'use strict';
/* ===========================================================================
   MOLUA - transport

   Mounts the game onto the existing Express app and HTTP server:

     GET  /api/v1/game/islands       islands anyone can join
     POST /api/v1/game/rooms         open a room
     GET  /api/v1/game/rooms/:code   does this room exist
     WS   /api/v1/game/ws/:code      the game itself

   A plain WebSocket, not Socket.IO. Socket.IO is already on this server for
   the admin dashboard and stays exactly where it is - the two coexist because
   they occupy different upgrade paths, and this handles only its own. The game
   client is a static page with no build step, so a raw WebSocket costs it
   nothing while a Socket.IO client would mean shipping and vendoring a
   library.

   One interval per room drives the phase clock. Movement frames go out far
   more often than full state, because a position is seven numbers and a
   snapshot is the whole game.
   =========================================================================== */

const { URL } = require('url');
const { registry, Phase, cleanName, MAX_PLAYERS } = require('./engine');
const bots = require('./bots');

const TICK_MS = 250;
// Movement frames at roughly 7 a second, which is smooth once the client
// interpolates and stays cheap on a camp network.
const POSITION_EVERY = 1;

let WebSocketServer = null;
try {
  ({ WebSocketServer } = require('ws'));
} catch (e) {
  console.error('Molua: ws unavailable —', e.message);
}

function send(socket, payload) {
  if (!socket || socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch (e) {
    /* a closing socket is not an error worth logging per message */
  }
}

/* Every player gets their own view: secret knowledge is added per viewer. */
function broadcast(room) {
  for (const [pid, socket] of room.sockets) {
    const player = room.players.get(pid) || null;
    send(socket, room.snapshotFor(player));
  }
}

function broadcastPositions(room) {
  const frame = { t: 'pos', players: room.positions() };
  for (const socket of room.sockets.values()) send(socket, frame);
}

function broadcastIslanders(room) {
  const frame = { t: 'islanders', map: room.islanders() };
  for (const socket of room.sockets.values()) send(socket, frame);
}

/* The phase clock. Started when a room gets its first socket and stopped when
   the last one leaves, so an abandoned room costs nothing. */
function startClock(room) {
  if (room.timer) return;
  let ticks = 0;
  room.timer = setInterval(() => {
    ticks += 1;
    try {
      // Bots move and act on the same clock as everything else, and before the
      // phase is tested - so a night whose only remaining actor is a bot
      // resolves on this tick instead of waiting out the full forty seconds.
      room.expireEmotes();
      if (bots.tick(room, TICK_MS / 1000)) broadcast(room);

      if (room.phase !== Phase.LOBBY) {
        const expired = Date.now() / 1000 >= room.phaseEndsAt;
        if (expired || room.everyoneActed()) {
          room.advance();
          broadcast(room);
          return;
        }
      }
      if (ticks % POSITION_EVERY === 0) broadcastPositions(room);
    } catch (err) {
      console.error('Molua: clock error in room', room.code, err);
    }
  }, TICK_MS);
}

function stopClock(room) {
  if (!room.timer) return;
  clearInterval(room.timer);
  room.timer = null;
}

/* One client message. Returns true when the room should be rebroadcast. */
function handle(room, player, message, socket) {
  const kind = message && message.t;
  const target = (message && message.target) || '';

  if (kind === 'ping') {
    send(socket, { t: 'pong' });
    return false;
  }

  /* Robots.

     A room needs four threads and one person with a phone has one. The host
     can fill the rest with bots rather than not playing - which is the whole
     difference between a game you can try right now and a game you have to
     organise first. Host only, lobby only, and capped by the same MAX_PLAYERS
     a room of people is. */
  if (kind === 'bot') {
    if (!player.isHost || room.phase !== Phase.LOBBY) return false;
    if (room.players.size >= MAX_PLAYERS) {
      send(socket, { t: 'error', text: 'The island is full.' });
      return false;
    }
    bots.addBot(room);
    broadcastIslanders(room);
    return true;
  }

  if (kind === 'unbot') {
    if (!player.isHost || room.phase !== Phase.LOBBY) return false;
    bots.removeBot(room);
    return true;
  }

  /* Set the number of computer players outright.

     A host filling a room is making one decision - "three computers" - not
     three separate ones, so this takes a target and adds or removes until it
     matches rather than making them tap a plus button. */
  if (kind === 'bots') {
    if (!player.isHost || room.phase !== Phase.LOBBY) return false;
    const want = Math.max(0, Math.min(9, Number(message.n) || 0));
    let guard = 32;
    while (bots.botsIn(room).length < want && room.players.size < MAX_PLAYERS && guard-- > 0) {
      bots.addBot(room);
    }
    while (bots.botsIn(room).length > want && guard-- > 0) bots.removeBot(room);
    broadcastIslanders(room);
    return true;
  }

  if (kind === 'start') {
    if (!player.isHost || room.phase !== Phase.LOBBY) return false;
    try {
      room.start();
    } catch (e) {
      send(socket, { t: 'error', text: e.message });
      return false;
    }
    return true;
  }

  if (kind === 'again') {
    if (player.isHost && room.phase === Phase.OVER) {
      room.resetToLobby();
      return true;
    }
    return false;
  }

  if (kind === 'cut') {
    room.actCut(player, target, message.manner, message.decree);
    return true;
  }
  if (kind === 'measure') {
    room.actMeasure(player, target);
    return true;
  }
  if (kind === 'obey') {
    room.actObey(player);
    return true;
  }
  if (kind === 'vote') {
    room.actVote(player, target);
    return true;
  }
  if (kind === 'public') {
    room.actPublic(player, message.on);
    return true;
  }

  // --- voice ------------------------------------------------------------
  // WebRTC needs a signalling path, not a media server: the audio itself goes
  // peer to peer. This socket is already open and already knows who is in the
  // room, so it carries the handshake. Payloads are relayed untouched to
  // exactly one recipient.
  if (kind === 'rtc') {
    const to = room.sockets.get(message.to || '');
    if (to) {
      send(to, { t: 'rtc', from: player.pid, kind: message.kind, data: message.data });
    }
    return false;
  }

  if (kind === 'loadout') {
    room.actLoadout(player, message.names);
    return true;
  }
  if (kind === 'map') {
    room.actMap(player, message.name);
    return true;
  }
  if (kind === 'voice') {
    room.actVoice(player, message.on);
    return true;
  }
  if (kind === 'say') {
    room.actSay(player, message.text);
    return true;
  }
  if (kind === 'call') {
    room.actCall(player, message.index);
    return true;
  }
  if (kind === 'omen') {
    room.actOmen(player, message.index);
    return true;
  }
  if (kind === 'react') {
    room.actReact(player, message.symbol || '');
    return true;
  }

  if (kind === 'move') {
    room.actMove(player, message.x, message.z, message.angle, message.moving);
    return false; // movement rides the position frame, not a full snapshot
  }
  if (kind === 'emote') {
    room.actEmote(player, message.name);
    return false;
  }
  if (kind === 'islander') {
    room.actIslander(player, message.face, message.colors);
    broadcastIslanders(room);
    return true;
  }

  return false;
}

/* Routes and sockets mount at different moments, and they have to.

   Express matches middleware in registration order, and this app registers a
   catch-all 404 well before the HTTP server exists. Mounting everything in one
   call at the bottom of server.js logged a cheerful "mounted" and then served
   404 for every game route, because they were all registered behind that
   catch-all. So the REST half goes on early, with the other routes, and the
   socket half goes on later, once there is a server to attach to. */
function mountRoutes(app) {
  // --- REST -------------------------------------------------------------

  app.get('/api/v1/game/islands', (req, res) => {
    res.json({ islands: registry.openIslands() });
  });

  app.post('/api/v1/game/rooms', (req, res) => {
    const room = registry.create();
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({ code: room.code, url: `${base}/play/${room.code}`, maxPlayers: MAX_PLAYERS });
  });

  app.get('/api/v1/game/rooms/:code', (req, res) => {
    const room = registry.get(req.params.code);
    if (!room) return res.status(404).json({ error: 'No such island.' });
    res.json({
      code: room.code,
      phase: room.phase,
      players: room.seated.length,
      maxPlayers: MAX_PLAYERS
    });
  });

  console.log('Molua: routes mounted at /api/v1/game');
}

function mountSockets(server) {
  if (!WebSocketServer) {
    console.error('Molua: sockets not mounted, ws missing');
    return;
  }

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(request.url, 'http://x').pathname;
    } catch (e) {
      return;
    }
    // Only ours. Anything else - Socket.IO's /socket.io/ included - is left
    // alone for its own handler, which is why both can live on one server.
    if (!pathname.startsWith('/api/v1/game/ws/')) return;

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws, request) => {
    let url;
    try {
      url = new URL(request.url, 'http://x');
    } catch (e) {
      ws.close();
      return;
    }
    const code = url.pathname.split('/').pop();
    const name = url.searchParams.get('name') || '';
    const secret = url.searchParams.get('secret') || '';

    const room = registry.get(code);
    if (!room) {
      send(ws, { t: 'error', text: 'That island does not exist.' });
      ws.close();
      return;
    }

    // Returning players keep their seat and their thread; the secret is how
    // a dropped phone gets its own role back rather than a fresh one.
    let player = room.playerBySecret(secret);
    if (!player) {
      if (room.phase !== Phase.LOBBY) {
        send(ws, { t: 'error', text: 'That game has already started.' });
        ws.close();
        return;
      }
      if (room.players.size >= MAX_PLAYERS) {
        send(ws, { t: 'error', text: 'That island is full.' });
        ws.close();
        return;
      }
      player = room.addPlayer(cleanName(name));
    }

    player.connected = true;
    room.lastSeen = Date.now() / 1000;

    // A second tab for the same player replaces the first.
    const existing = room.sockets.get(player.pid);
    if (existing && existing !== ws) {
      try {
        existing.close();
      } catch (e) {}
    }
    room.sockets.set(player.pid, ws);
    startClock(room);

    send(ws, { t: 'welcome', pid: player.pid, secret: player.secret, code: room.code });
    broadcastIslanders(room); // a joiner needs every face already in the room
    broadcast(room);

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch (e) {
        return;
      }
      if (!message || typeof message !== 'object') return;
      room.lastSeen = Date.now() / 1000;
      try {
        if (handle(room, player, message, ws)) broadcast(room);
      } catch (err) {
        console.error('Molua: handler error', err);
      }
    });

    ws.on('close', () => {
      if (room.sockets.get(player.pid) === ws) room.sockets.delete(player.pid);
      player.connected = false;
      room.lastSeen = Date.now() / 1000;
      // A player who drops before the game starts gives up their seat; a
      // mid-game leaver keeps it, so they can come back to the same role.
      if (room.phase === Phase.LOBBY) room.removePlayer(player.pid);
      if (!room.sockets.size) stopClock(room);
      else broadcast(room);
    });

    ws.on('error', () => {
      /* close will follow */
    });
  });

  console.log('Molua: sockets mounted at /api/v1/game/ws');
}

/* Both at once - only safe where nothing is registered after it. */
function mount(app, server) {
  mountRoutes(app);
  mountSockets(server);
}

module.exports = { mount, mountRoutes, mountSockets };
