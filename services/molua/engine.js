'use strict';
/* ===========================================================================
   MOLUA - multiplayer social deduction engine

   A port of the Python engine that was prototyped alongside the game client.
   It lives here because this is the service that actually deploys: Railway
   builds this repo, so the game server has a home the moment it is committed.

   Roles
     UNDERTOW   - pulls one islander under each Nightfall. Wins with REEF.
     NAVIGATOR  - measures one player each Nightfall, learns UNDERTOW or not.
     REEF       - knows who holds the notebook, cannot write, wins with them.
     VILLAGER   - no power but judgement. Wins by finding the notebook.

   UNDERTOW is a mantle, not a person - whoever draws it wears the name.

   Phase loop
     LOBBY -> NIGHTFALL -> DECREE -> GATHERING -> VERDICT -> (NIGHTFALL | OVER)

   The DECREE phase is what makes this a party game rather than a browser
   game. The cut player is told privately that they have forty seconds and is
   handed an instruction to carry out loud, in the actual room. Everyone sees
   the instruction with no name attached, and watches to see who obeys.

   Design constraints for a mixed-age camp audience:
     - Chat is the one place a player can put arbitrary text on another
       player's screen, so it is rate limited, length capped, and split into
       two rooms: the living cannot hear the dead, who know every role.
     - Every manner of death is mythic and bloodless.
     - Nothing here filters what people write. For a commercial deployment to
       minors that is the surface that needs moderation.

   Transport-agnostic: the WebSocket plumbing lives in ./index.js.
   =========================================================================== */

const crypto = require('crypto');

// Ambiguous glyphs removed so a code survives being shouted across a mess hall.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 16;
const MAX_NAME_LENGTH = 14;
const MAX_CHAT_LENGTH = 160;
const MAX_LOG_ENTRIES = 160;

// One message every this many seconds, per player.
const CHAT_MIN_INTERVAL = 1.1;

// Phase durations in seconds. Tuned so a whole game runs about seven minutes.
// How long a tapped emote plays for. Long enough to read across a square,
// short enough that a wave does not become a personality.
/* A match is three rounds, not "until somebody wins".

   Left open-ended a game runs anywhere from two rounds to six, which is
   unusable for the thing this is actually for: a counsellor with a room of
   children and forty minutes. Three rounds is about seven minutes, and it is
   the same seven minutes every time, so an adult can plan around it.

   It also fixes the game. An unbounded hunt has no urgency - the village can
   always vote nobody out and try again next round. A clock means the notebook
   only has to survive, which gives the village a reason to commit to a guess
   while they still can. */
const MAX_ROUNDS = 3;

const EMOTE_SECONDS = 4;

const NIGHTFALL_SECONDS = 40;
const DECREE_SECONDS = 40;
const GATHERING_SECONDS = 105;
const VERDICT_SECONDS = 10;
const OVER_SECONDS = 90;

// Rooms with nobody connected for this long are reaped.
const ROOM_IDLE_TIMEOUT = 3600;

// Every ending is mythic and bloodless. Nothing needs a content warning.
const MANNERS = [
  'the tide took them',
  'went out too far',
  'the current',
  'a long sleep',
  'the reef',
  'a storm, sudden',
  'the sand gave way',
  'the wind, and nothing else'
];

// Decrees are performed out loud, in the room. That is the entire point.
// Fixed list: nothing a player types can ever reach another player's screen.
const DECREES = [
  'Stand up and accuse someone.',
  "Say 'I do not have the notebook' three times.",
  'Compliment the person you suspect most.',
  'Laugh out loud at nothing.',
  'Swap seats with someone.',
  'Whisper to the person on your left.',
  'Point at someone. Say nothing.',
  'Stay silent for the whole Gathering.',
  'Do your best evil laugh.',
  'Speak only in questions this round.',
  'Clap three times, slowly.',
  'Tell the room your favourite animal. Sound deadly serious.'
];

// Table calls let a quiet player join the argument without typing anything.
const CALLS = [
  "It's you. I know it.",
  "I'm clean, I swear.",
  "They're too quiet.",
  'That was a lie.',
  'Trust me this once.',
  'I saw something.',
  "I'm changing my vote.",
  'Nobody move.'
];

// A Spirit's one anonymous message to the living.
const OMENS = [
  'One of you is lying right now.',
  'You are looking the wrong way.',
  'The quiet one is quiet for a reason.',
  'You had it right, and you let go.',
  'Count the votes again.',
  'Two of them are working together.'
];

const REACTIONS = ['eye', 'flame', 'hand', 'skull'];

const DEFAULT_LOADOUT = ['wave', 'dance', 'clap', 'cheer', 'point', 'laugh', 'sit', 'flex'];

const MAPS = ['village', 'grove', 'bay'];

const EMOTES = [
  'wave', 'dance', 'spin', 'clap', 'cheer', 'point', 'bow', 'flex',
  'laugh', 'think', 'sit', 'sleep', 'robot', 'wiggle'
];

// How many an islander carries on their wheel at once.
const EMOTE_SLOTS = 8;

// The village players walk around in, in world units.
const VILLAGE_RADIUS = 26.0;
const SPAWN_RADIUS = 7.0;

// A face thumbnail is relayed to every player, so it is hard-capped. The
// client sends roughly a 128px cel-shaded JPEG, which lands near 6 KB.
const MAX_ISLANDER_BYTES = 24000;

// The shape of an Islander, mirroring the client's avatar library. Explicit
// whitelists, so a client cannot inject arbitrary strings into other players'
// renderers.
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const ISLANDER_COLOR_KEYS = ['skin', 'hair', 'shirt', 'pants', 'shoes', 'hatColor'];
const ISLANDER_STYLE_KEYS = {
  hairStyle: ['crop', 'buzz', 'bob', 'long', 'wavy', 'braids', 'ponytail', 'curls', 'bun', 'topknot'],
  eyes: ['round', 'almond', 'wide', 'happy', 'sleepy', 'wink'],
  brows: ['soft', 'flat', 'arched', 'thick'],
  mouth: ['smile', 'grin', 'smirk', 'open', 'calm'],
  hatStyle: ['cap', 'capBack'],
  costume: ['cap', 'crown', 'scientist', 'bear', 'explorer', 'chef', 'diver', 'none']
};

const Phase = {
  LOBBY: 'lobby',
  NIGHTFALL: 'nightfall',
  DECREE: 'decree',
  GATHERING: 'gathering',
  VERDICT: 'verdict',
  OVER: 'over'
};

const Role = {
  UNDERTOW: 'undertow',
  NAVIGATOR: 'navigator',
  REEF: 'reef',
  VILLAGER: 'villager'
};

const ROLE_TITLES = {
  undertow: 'THE NOTEBOOK',
  navigator: 'NAVIGATOR',
  reef: 'REEF',
  villager: 'VILLAGER'
};

// Flavour first, then the plain-language version an eight-year-old can act on.
const ROLE_BLURBS = {
  undertow: 'You have the notebook.',
  navigator: 'You measure what others only guess at.',
  reef: 'You are the dark they work under.',
  villager: 'You have no gift. Only the room.'
};

const ROLE_HOWTO = {
  undertow: "Each night, write one name in the notebook, and an order for them to obey. Don't get caught holding it.",
  navigator: "Each night, pick one player. You'll be told whether they have the notebook. Nobody else finds out.",
  reef: "You already know who has the notebook. You cannot write in it. Lie for them and stay alive.",
  villager: 'You have no night action. Listen, argue out loud, and find who has the notebook.'
};

const now = () => Date.now() / 1000;

function newCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

/* Collapse whitespace, drop control characters, clamp, uppercase. */
function cleanName(value) {
  if (typeof value !== 'string') return '';
  const kept = value.replace(/[\p{C}]/gu, '');
  return kept.split(/\s+/).filter(Boolean).join(' ').slice(0, MAX_NAME_LENGTH).toUpperCase();
}

function cleanText(value, limit) {
  if (typeof value !== 'string') return '';
  const kept = value.replace(/[\p{C}]/gu, '');
  return kept.split(/\s+/).filter(Boolean).join(' ').slice(0, limit);
}

/* Resolve a client-supplied index into a fixed list. Falls back to random. */
function pickFrom(options, index) {
  if (Number.isInteger(index) && index >= 0 && index < options.length) return options[index];
  return options[crypto.randomInt(options.length)];
}

function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

class Player {
  constructor(pid, secret, name, seat, isHost) {
    this.pid = pid;
    this.secret = secret;
    this.name = name;
    this.seat = seat;
    this.isHost = !!isHost;
    this.role = Role.VILLAGER;
    this.alive = true;
    this.connected = true;

    // Per-round scratch state.
    this.vote = null;
    this.obeyed = false;
    this.reaction = null;

    // Where they are standing, and which way they face.
    this.x = 0;
    this.z = 0;
    this.angle = 0;
    this.moving = false;
    this.emote = null;
    this.emoteUntil = 0;

    // Their Islander: a face thumbnail plus the colours pulled from it.
    this.islander = null;

    // Navigator findings: round -> {pid, name, undertow}
    this.findings = {};

    // One anonymous message from beyond, per game.
    this.omenSpent = false;

    this.lastSaid = 0;
    this.voice = false;
    this.loadout = DEFAULT_LOADOUT.slice();

    this.manner = null;
    this.deathRound = null;
    this.castOut = false;
  }

  get withUndertow() {
    return this.role === Role.UNDERTOW || this.role === Role.REEF;
  }
}

class Room {
  constructor(code) {
    this.code = code;
    this.map = MAPS[0];
    this.players = new Map();
    this.order = [];
    this.phase = Phase.LOBBY;
    this.round = 0;
    this.phaseEndsAt = 0;
    this.log = [];
    this.winner = null;
    this.createdAt = now();
    this.lastSeen = now();

    // Whether this island shows up in the public list. On by default, because
    // a browser that is always empty is not a feature - but a host can close
    // it, and only rooms still in the lobby are ever listed.
    this.public = true;

    // Nightfall bookkeeping.
    this.cut = null;
    this.cutManner = null;
    this.cutDecree = null;
    this.decreeDone = false;
    this.lastCut = null;
    this.lastVerdict = null;

    // Transport - populated by ./index.js
    this.sockets = new Map();
    this.timer = null;
  }

  // -- membership --------------------------------------------------------

  get seated() {
    return this.order.map((pid) => this.players.get(pid)).filter(Boolean);
  }

  get living() {
    return this.seated.filter((p) => p.alive);
  }

  playerBySecret(secret) {
    if (!secret) return null;
    for (const player of this.players.values()) {
      if (sameSecret(player.secret, secret)) return player;
    }
    return null;
  }

  uniqueName(wanted) {
    const base = cleanName(wanted) || 'NAMELESS';
    const taken = new Set([...this.players.values()].map((p) => p.name));
    if (!taken.has(base)) return base;
    for (let n = 2; n < 100; n++) {
      const candidate = `${base} ${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    return base;
  }

  addPlayer(name) {
    const pid = crypto.randomBytes(6).toString('hex');
    const player = new Player(
      pid,
      crypto.randomBytes(24).toString('base64url'),
      this.uniqueName(name),
      this.order.length,
      this.players.size === 0
    );
    this.players.set(pid, player);
    this.order.push(pid);
    // Stand everyone round the square as they arrive, not only when a game
    // starts. Players default to the origin, which is exactly where the
    // monument is, so anyone who walked around the lobby was standing inside
    // it - and with the camera looking at their own position, they saw the
    // inside of a stone column instead of themselves.
    this.spawnPositions();
    this.writeLog('join', `${player.name} takes a thread.`);
    return player;
  }

  removePlayer(pid) {
    const player = this.players.get(pid);
    if (!player) return;
    this.players.delete(pid);
    this.order = this.order.filter((x) => x !== pid);
    this.order.forEach((other, index) => {
      const p = this.players.get(other);
      if (p) p.seat = index;
    });
    if (player.isHost && this.order.length) {
      const next = this.players.get(this.order[0]);
      if (next) next.isHost = true;
    }
    this.writeLog('leave', `${player.name} let go.`);
  }

  // -- log ---------------------------------------------------------------

  writeLog(kind, text, extra) {
    this.log.push(Object.assign({ kind, text, round: this.round, at: now() }, extra || {}));
    if (this.log.length > MAX_LOG_ENTRIES) {
      this.log.splice(0, this.log.length - MAX_LOG_ENTRIES);
    }
  }

  // -- lifecycle ---------------------------------------------------------

  start() {
    const count = this.players.size;
    if (count < MIN_PLAYERS) {
      throw new Error(`Molua needs at least ${MIN_PLAYERS} threads.`);
    }

    const pool = shuffled([...this.players.values()]);
    const pullers = count >= 11 ? 2 : 1;
    const assignments = [];
    for (let i = 0; i < pullers; i++) assignments.push(Role.UNDERTOW);
    assignments.push(Role.NAVIGATOR);
    if (count >= 7) assignments.push(Role.REEF);
    while (assignments.length < count) assignments.push(Role.VILLAGER);

    pool.forEach((player, i) => {
      player.role = assignments[i];
      player.alive = true;
      player.vote = null;
      player.manner = null;
      player.deathRound = null;
      player.castOut = false;
      player.findings = {};
      player.omenSpent = false;
    });

    this.round = 0;
    this.winner = null;
    this.log = [];
    this.spawnPositions();
    this.writeLog('system', 'Something is in the water tonight. Nobody knows what.');
    this.beginNightfall();
  }

  beginNightfall() {
    this.round += 1;
    this.phase = Phase.NIGHTFALL;
    this.phaseEndsAt = now() + NIGHTFALL_SECONDS;
    this.cut = null;
    this.cutManner = null;
    this.cutDecree = null;
    this.decreeDone = false;
    this.lastCut = null;
    this.lastVerdict = null;
    for (const player of this.players.values()) {
      player.vote = null;
      player.obeyed = false;
      player.reaction = null;
    }
    this.writeLog('phase', `Nightfall ${this.round}. The lanterns go out.`);
  }

  beginDecree() {
    this.phase = Phase.DECREE;
    this.phaseEndsAt = now() + DECREE_SECONDS;
    this.writeLog('phase', 'Someone is being pulled under. Forty seconds.');
    if (this.cutDecree) this.writeLog('decree', this.cutDecree, { anonymous: true });
  }

  beginGathering() {
    this.phase = Phase.GATHERING;
    this.phaseEndsAt = now() + GATHERING_SECONDS;
    for (const player of this.players.values()) player.vote = null;
    this.writeLog('phase', `Gathering ${this.round}. Speak, and be counted.`);
  }

  beginVerdict() {
    this.phase = Phase.VERDICT;
    this.phaseEndsAt = now() + VERDICT_SECONDS;
  }

  finish(winner) {
    this.phase = Phase.OVER;
    this.winner = winner;
    this.phaseEndsAt = now() + OVER_SECONDS;
    /* Who won, by name.

       A result that only names the winning side leaves everybody working out
       from memory who was on it - and the whole pleasure of the ending is
       finding out that the person you defended all game was holding it. */
    this.results = this.seated.map((p) => ({
      pid: p.pid,
      name: p.name,
      role: p.role,
      title: ROLE_TITLES[p.role],
      won: winner === 'undertow' ? !!p.withUndertow : !p.withUndertow,
      survived: p.alive
    }));
    if (winner === 'undertow') {
      this.writeLog('system', 'The island is quiet. The water keeps its own.');
    } else {
      this.writeLog('system', 'The water is still. Molua sleeps easy.');
    }
  }

  // -- actions -----------------------------------------------------------

  actCut(actor, targetPid, mannerIndex, decreeIndex) {
    if (this.phase !== Phase.NIGHTFALL || actor.role !== Role.UNDERTOW || !actor.alive) return;
    const target = this.players.get(targetPid);
    if (!target || !target.alive || target.pid === actor.pid) return;
    this.cut = target.pid;
    this.cutManner = pickFrom(MANNERS, mannerIndex);
    this.cutDecree = pickFrom(DECREES, decreeIndex);
  }

  actMeasure(actor, targetPid) {
    if (this.phase !== Phase.NIGHTFALL || actor.role !== Role.NAVIGATOR || !actor.alive) return;
    if (Object.prototype.hasOwnProperty.call(actor.findings, String(this.round))) return;
    const target = this.players.get(targetPid);
    if (!target || target.pid === actor.pid || !target.alive) return;
    actor.findings[String(this.round)] = {
      pid: target.pid,
      name: target.name,
      undertow: target.role === Role.UNDERTOW
    };
  }

  /* The cut player confirms they performed their decree in the room. */
  actObey(actor) {
    if (this.phase !== Phase.DECREE || actor.pid !== this.cut || actor.obeyed) return;
    actor.obeyed = true;
    this.decreeDone = true;
  }

  /* Free-text chat. Rate limited and length capped, because this is the one
     place a player can put arbitrary text on everyone else's screen. The
     living and the dead are separate rooms: a Spirit knows every role, so
     letting them talk to the living would hand the game away. */
  actSay(actor, text) {
    const message = cleanText(text, MAX_CHAT_LENGTH);
    if (!message) return;

    const t = now();
    if (t - actor.lastSaid < CHAT_MIN_INTERVAL) return;
    actor.lastSaid = t;

    /* The living can talk in any phase.

       Nightfall used to be silent, which is correct at a table where everyone
       has their eyes shut. It is wrong here. These are children in the same
       room on their own phones - they are going to talk through Nightfall
       whatever the software says, and all a disabled text box achieves is
       that the quiet kid who was typing instead of shouting gets shut out.

       The split that actually matters is still enforced: the dead write to
       the spirit channel and the living never see it. That one is load
       bearing, because a Spirit knows every role. */
    if (!actor.alive) {
      this.writeLog('spirit', message, { who: actor.name, seat: actor.seat, pid: actor.pid });
    } else {
      this.writeLog('chat', message, { who: actor.name, seat: actor.seat, pid: actor.pid });
    }
  }

  actCall(actor, index) {
    if (!Number.isInteger(index) || index < 0 || index >= CALLS.length) return;
    if (!actor.alive) {
      this.writeLog('spirit', CALLS[index], { who: actor.name, seat: actor.seat, pid: actor.pid });
    } else {
      this.writeLog('call', CALLS[index], { who: actor.name, seat: actor.seat, pid: actor.pid });
    }
  }

  actOmen(actor, index) {
    if (actor.alive || actor.omenSpent || this.phase !== Phase.GATHERING) return;
    if (!Number.isInteger(index) || index < 0 || index >= OMENS.length) return;
    actor.omenSpent = true;
    this.writeLog('omen', OMENS[index], { anonymous: true });
  }

  actVote(actor, targetPid) {
    if (this.phase !== Phase.GATHERING || !actor.alive) return;
    if (!targetPid) {
      actor.vote = null;
      return;
    }
    const target = this.players.get(targetPid);
    if (!target || !target.alive) return;
    // Tapping the same player again takes the vote back.
    actor.vote = actor.vote === target.pid ? null : target.pid;
  }

  /* Host picks where everyone is playing. Lobby only - swapping the world
     mid-game would teleport people into scenery. */
  actMap(actor, name) {
    if (!actor.isHost || this.phase !== Phase.LOBBY) return;
    if (typeof name === 'string' && MAPS.includes(name)) this.map = name;
  }

  actVoice(actor, on) {
    actor.voice = !!on;
  }

  actReact(actor, symbol) {
    if (REACTIONS.includes(symbol)) actor.reaction = symbol;
  }

  /* Walk. Clamped to the village so nobody wanders off the island. */
  actMove(actor, x, z, angle, moving) {
    const nx = Number(x);
    const nz = Number(z);
    const na = Number(angle);
    if (![nx, nz, na].every(Number.isFinite)) return;
    let cx = nx;
    let cz = nz;
    const radius = Math.hypot(cx, cz);
    if (radius > VILLAGE_RADIUS) {
      cx *= VILLAGE_RADIUS / radius;
      cz *= VILLAGE_RADIUS / radius;
    }
    actor.x = cx;
    actor.z = cz;
    actor.angle = na;
    actor.moving = !!moving;
  }

  /* An emote runs for EMOTE_SECONDS and then stops.

     It used to be set and never cleared, which made it permanent - and worse
     than permanent. The client animates for a few seconds and then puts the
     limbs back, but the next position frame still carried the emote name, so
     it read as a new one and started again. A single tap left a character
     dancing for the rest of the game.

     The clock owns the expiry rather than the client, because every player
     has to see the same thing stop at the same moment. */
  actEmote(actor, name) {
    if (!EMOTES.includes(name)) { actor.emote = null; return; }
    actor.emote = name;
    actor.emoteUntil = now() + EMOTE_SECONDS;
  }

  /* Called every tick. Returns true when at least one emote ended, so the
     transport knows the position frame is worth sending. */
  expireEmotes() {
    const t = now();
    let ended = false;
    for (const p of this.players.values()) {
      if (p.emote && t >= (p.emoteUntil || 0)) {
        p.emote = null;
        p.emoteUntil = 0;
        ended = true;
      }
    }
    return ended;
  }

  /* The eight emotes on this player's wheel. Whitelisted and length capped,
     and it is only ever theirs - nobody sets anyone else's. */
  actLoadout(actor, names) {
    if (!Array.isArray(names)) return;
    const seen = new Set();
    const clean = [];
    for (const n of names) {
      if (typeof n === 'string' && EMOTES.includes(n) && !seen.has(n)) {
        seen.add(n);
        clean.push(n);
      }
    }
    if (clean.length) actor.loadout = clean.slice(0, EMOTE_SLOTS);
  }

  /* Host decides whether strangers can find this island. */
  actPublic(actor, on) {
    if (!actor.isHost || this.phase !== Phase.LOBBY) return;
    this.public = !!on;
  }

  /* Store a player's Islander.

     Everything here is relayed to every other player, so nothing is trusted:
     colours must match a hex pattern, every style must be one of a known set,
     and the optional face thumbnail is size-capped and required to be a data
     URL. Anything that fails simply does not make it into the record. */
  actIslander(actor, face, colors) {
    const safe = {};

    if (typeof face === 'string' && face.startsWith('data:image/') && face.length <= MAX_ISLANDER_BYTES) {
      safe.face = face;
    }

    if (colors && typeof colors === 'object') {
      for (const key of ISLANDER_COLOR_KEYS) {
        const value = colors[key];
        if (typeof value === 'string' && HEX_COLOR.test(value)) safe[key] = value;
      }
      for (const [key, allowed] of Object.entries(ISLANDER_STYLE_KEYS)) {
        const value = colors[key];
        if (typeof value === 'string' && allowed.includes(value)) safe[key] = value;
      }
      if (typeof colors.glasses === 'boolean') safe.glasses = colors.glasses;
    }

    // A record with nothing valid in it is not worth relaying.
    if (Object.keys(safe).length) actor.islander = safe;
  }

  /* Stand everyone in a ring in the square, facing the middle. */
  spawnPositions() {
    const seated = this.seated;
    seated.forEach((player, index) => {
      const a = (index / Math.max(1, seated.length)) * Math.PI * 2;
      player.x = Math.cos(a) * SPAWN_RADIUS;
      player.z = Math.sin(a) * SPAWN_RADIUS;
      player.angle = a + Math.PI;
      player.moving = false;
      player.emote = null;
    });
  }

  /* The lightweight movement frame, sent far more often than full state. */
  positions() {
    return this.seated.map((p) => [
      p.pid,
      Math.round(p.x * 100) / 100,
      Math.round(p.z * 100) / 100,
      Math.round(p.angle * 100) / 100,
      p.moving ? 1 : 0,
      p.alive ? 1 : 0,
      p.emote || ''
    ]);
  }

  islanders() {
    const out = {};
    for (const p of this.seated) if (p.islander) out[p.pid] = p.islander;
    return out;
  }

  // -- resolution --------------------------------------------------------

  resolveNightfall() {
    if (this.cut) {
      this.beginDecree();
    } else {
      this.writeLog('system', 'The water was still tonight.');
      this.beginGathering();
    }
  }

  resolveDecree() {
    const victim = this.players.get(this.cut || '');
    if (victim && victim.alive) {
      victim.alive = false;
      victim.manner = this.cutManner;
      victim.deathRound = this.round;
      this.lastCut = {
        pid: victim.pid,
        name: victim.name,
        seat: victim.seat,
        manner: this.cutManner,
        decree: this.cutDecree,
        obeyed: victim.obeyed
      };
      const tail = victim.obeyed ? '' : ' They refused, and it made no difference.';
      this.writeLog('cut', `${victim.name} - ${this.cutManner}.${tail}`, {
        who: victim.name,
        seat: victim.seat
      });
    }
    if (!this.checkWinner()) this.beginGathering();
  }

  tally() {
    const counts = {};
    for (const player of this.living) {
      if (player.vote) counts[player.vote] = (counts[player.vote] || 0) + 1;
    }
    return counts;
  }

  resolveGathering() {
    const counts = this.tally();
    let chosen = null;
    const values = Object.values(counts);
    if (values.length) {
      const top = Math.max(...values);
      const leaders = Object.keys(counts).filter((pid) => counts[pid] === top);
      // A tie is not a majority. Nobody is cast out on a tie.
      if (leaders.length === 1 && top > this.living.length / 2) {
        chosen = this.players.get(leaders[0]) || null;
      }
    }

    if (chosen) {
      chosen.alive = false;
      chosen.castOut = true;
      chosen.manner = 'cast out by the Gathering';
      chosen.deathRound = this.round;
      this.lastVerdict = {
        pid: chosen.pid,
        name: chosen.name,
        seat: chosen.seat,
        role: chosen.role,
        title: ROLE_TITLES[chosen.role],
        votes: counts[chosen.pid] || 0,
        correct: chosen.role === Role.UNDERTOW
      };
      this.writeLog('verdict', `${chosen.name} is cast out. ${Room.roleReveal(chosen)}`, {
        who: chosen.name,
        seat: chosen.seat
      });
    } else {
      this.lastVerdict = null;
      this.writeLog('system', 'No majority. The Gathering breaks with nothing.');
    }

    this.beginVerdict();
  }

  static roleReveal(player) {
    if (player.role === Role.UNDERTOW) return 'The water lets them go.';
    if (player.role === Role.REEF) return 'They kept the water dark.';
    if (player.role === Role.NAVIGATOR) return 'They were the one who measured.';
    return 'Their hands were empty.';
  }

  checkWinner() {
    const living = this.living;
    const pullers = living.filter((p) => p.role === Role.UNDERTOW);
    const theirs = living.filter((p) => p.withUndertow);
    const ours = living.filter((p) => !p.withUndertow);
    if (!pullers.length) {
      this.finish('villagers');
      return true;
    }
    if (theirs.length >= ours.length) {
      this.finish('undertow');
      return true;
    }
    return false;
  }

  /* Called when the phase clock expires or every action is in. */
  advance() {
    if (this.phase === Phase.NIGHTFALL) this.resolveNightfall();
    else if (this.phase === Phase.DECREE) this.resolveDecree();
    else if (this.phase === Phase.GATHERING) this.resolveGathering();
    else if (this.phase === Phase.VERDICT) {
      if (this.checkWinner()) return;
      // Out of rounds. Whoever held the notebook was never found, which is a
      // win for them and a clearer ending than a draw.
      if (this.round >= MAX_ROUNDS){ this.finish('undertow'); return; }
      this.beginNightfall();
    } else if (this.phase === Phase.OVER) this.resetToLobby();
  }

  resetToLobby() {
    this.phase = Phase.LOBBY;
    this.round = 0;
    this.winner = null;
    this.results = null;
    this.cut = null;
    this.lastCut = null;
    this.lastVerdict = null;
    this.log = [];
    for (const player of this.players.values()) {
      player.alive = true;
      player.role = Role.VILLAGER;
      player.vote = null;
      player.manner = null;
      player.castOut = false;
      player.reaction = null;
      player.findings = {};
      player.omenSpent = false;
    }
    this.writeLog('system', 'New morning. Same water.');
  }

  /* Lets a phase end early once there is nothing left to wait for. */
  everyoneActed() {
    if (this.phase === Phase.NIGHTFALL) {
      const pullDone =
        this.cut !== null ||
        ![...this.players.values()].some((p) => p.alive && p.role === Role.UNDERTOW);
      const measurer = this.living.find((p) => p.role === Role.NAVIGATOR) || null;
      const measureDone =
        measurer === null ||
        Object.prototype.hasOwnProperty.call(measurer.findings, String(this.round));
      return pullDone && measureDone;
    }
    if (this.phase === Phase.DECREE) return this.decreeDone;
    if (this.phase === Phase.GATHERING) {
      const living = this.living;
      return living.length > 0 && living.every((p) => p.vote);
    }
    return false;
  }

  // -- serialisation -----------------------------------------------------

  publicPlayers() {
    const over = this.phase === Phase.OVER;
    return this.seated.map((p) => ({
      pid: p.pid,
      name: p.name,
      seat: p.seat,
      alive: p.alive,
      connected: p.connected,
      // Public on purpose. Knowing which islanders are robots is part of
      // reading the room - hiding it would make a bot's clumsy vote look like
      // a person's, which is a worse game, not a cleverer one.
      bot: !!p.bot,
      host: p.isHost,
      manner: p.manner,
      castOut: p.castOut,
      reaction: p.reaction,
      hasIslander: p.islander !== null,
      voice: p.voice,
      // Roles become public only when the game is over.
      role: over ? p.role : null,
      title: over ? ROLE_TITLES[p.role] : null
    }));
  }

  phaseDuration() {
    return (
      {
        [Phase.NIGHTFALL]: NIGHTFALL_SECONDS,
        [Phase.DECREE]: DECREE_SECONDS,
        [Phase.GATHERING]: GATHERING_SECONDS,
        [Phase.VERDICT]: VERDICT_SECONDS,
        [Phase.OVER]: OVER_SECONDS
      }[this.phase] || 0
    );
  }

  /* The personalised view. Secret knowledge is added here and nowhere else. */
  snapshotFor(viewer) {
    let remaining = 0;
    if (this.phase !== Phase.LOBBY) remaining = Math.max(0, this.phaseEndsAt - now());

    // Spirits read the spirit channel; the living never receive it.
    const asSpirit = viewer !== null && viewer !== undefined && !viewer.alive && this.phase !== Phase.LOBBY;
    const visibleLog = this.log.slice(-70).filter((e) => e.kind !== 'spirit' || asSpirit);

    const state = {
      t: 'state',
      code: this.code,
      map: this.map,
      maps: MAPS,
      emotes: EMOTES,
      phase: this.phase,
      round: this.round,
      remaining: Math.round(remaining * 10) / 10,
      duration: this.phaseDuration(),
      players: this.publicPlayers(),
      winner: this.winner,
      results: this.phase === Phase.OVER ? this.results : null,
      maxRounds: MAX_ROUNDS,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      public: this.public,
      manners: MANNERS,
      decrees: DECREES,
      calls: CALLS,
      omens: OMENS,
      lastCut: this.lastCut,
      lastVerdict: this.lastVerdict,
      log: visibleLog
    };

    if (this.phase === Phase.GATHERING) {
      // Votes are public as they land - the pile-on is half the fun.
      const votes = {};
      for (const p of this.living) if (p.vote) votes[p.pid] = p.vote;
      state.votes = votes;
    }

    if (!viewer) return state;

    const playing = this.phase !== Phase.LOBBY;
    const me = {
      pid: viewer.pid,
      name: viewer.name,
      seat: viewer.seat,
      alive: viewer.alive,
      host: viewer.isHost,
      vote: viewer.vote,
      loadout: viewer.loadout,
      role: playing ? viewer.role : null,
      title: playing ? ROLE_TITLES[viewer.role] : null,
      blurb: playing ? ROLE_BLURBS[viewer.role] : null,
      howto: playing ? ROLE_HOWTO[viewer.role] : null
    };

    if (playing) {
      if (viewer.role === Role.UNDERTOW && viewer.alive) {
        me.cut = this.cut;
        me.manner = this.cutManner;
        me.decree = this.cutDecree;
      }
      if (viewer.role === Role.NAVIGATOR) {
        me.findings = Object.keys(viewer.findings)
          .sort()
          .map((rnd) => Object.assign({ round: rnd }, viewer.findings[rnd]));
        me.measured = Object.prototype.hasOwnProperty.call(viewer.findings, String(this.round));
      }
      if (viewer.role === Role.REEF) {
        me.knows = this.seated.filter((p) => p.role === Role.UNDERTOW).map((p) => p.pid);
      }
      if (!viewer.alive) {
        // Dying buys you the truth. It is the whole compensation.
        const revealed = {};
        for (const p of this.seated) revealed[p.pid] = p.role;
        me.revealed = revealed;
        me.omenSpent = viewer.omenSpent;
      }
    }

    // Only the cut player learns they are cut, and only inside the window.
    if (this.phase === Phase.DECREE && viewer.pid === this.cut) {
      me.condemned = {
        decree: this.cutDecree,
        manner: this.cutManner,
        obeyed: viewer.obeyed
      };
    }

    state.me = me;
    return state;
  }
}

class Registry {
  constructor() {
    this.rooms = new Map();
  }

  create() {
    this.reap();
    for (let i = 0; i < 20; i++) {
      const code = newCode();
      if (!this.rooms.has(code)) {
        const room = new Room(code);
        this.rooms.set(code, room);
        return room;
      }
    }
    throw new Error('Could not allocate a room code.');
  }

  get(code) {
    return this.rooms.get(String(code || '').trim().toUpperCase()) || null;
  }

  /* Islands anyone can walk into.

     Only rooms still in the lobby, marked public, with somebody actually
     connected and a seat left. Fullest first, because a game one player short
     of starting is the one worth joining. Nothing private is exposed: a
     display name the host typed, a count and a map. */
  openIslands(limit = 24) {
    this.reap();
    const out = [];
    for (const room of this.rooms.values()) {
      if (!room.public || room.phase !== Phase.LOBBY) continue;
      const seated = room.seated;
      if (!seated.length || !room.sockets.size || seated.length >= MAX_PLAYERS) continue;
      const host = seated.find((p) => p.isHost) || seated[0];
      out.push({
        code: room.code,
        host: host.name,
        players: seated.length,
        max: MAX_PLAYERS,
        map: room.map,
        age: Math.floor(now() - room.createdAt)
      });
    }
    out.sort((a, b) => b.players - a.players || a.age - b.age);
    return out.slice(0, limit);
  }

  reap() {
    const t = now();
    for (const [code, room] of [...this.rooms.entries()]) {
      if (!room.sockets.size && t - room.lastSeen > ROOM_IDLE_TIMEOUT) {
        if (room.timer) clearInterval(room.timer);
        this.rooms.delete(code);
      }
    }
  }
}

const registry = new Registry();

module.exports = {
  Phase,
  Role,
  Room,
  Registry,
  registry,
  MIN_PLAYERS,
  MAX_PLAYERS,
  MAPS,
  EMOTES,
  cleanName
};
