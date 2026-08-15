'use strict';
/* ===========================================================================
   Islanders who are not people

   Molua needs four players and a summer camp does not always have four
   phones in the same room at the same time. Without this, one person opening
   the game can walk around an empty island and nothing else - the start
   button stays grey, because the rules genuinely require a fourth thread.

   These are not an AI. They are a small state machine that takes a seat,
   wanders, votes, and performs whatever its role is obliged to do at night,
   so a host can fill a room and play. They are deliberately not good: a bot
   that deduced correctly would be miserable to play against, and one that
   never voted would be furniture. They guess, they follow the room a little,
   and they are wrong often.

   Everything here goes through the same Room methods a socket message does.
   A bot cannot do anything a player could not do, which is the only way to
   be sure adding them cannot corrupt a game.
   =========================================================================== */

const NAMES = [
  'MAKO', 'PUA', 'KEONI', 'LANI', 'IKAIKA', 'NALU', 'HOKU', 'MOANA',
  'KEKOA', 'ALANA', 'KANOA', 'LEILA', 'AKELA', 'NOELANI', 'TAMA', 'IOLANA'
];

const SKIN  = ['#FFDCBC', '#F2C9A0', '#E8B187', '#C68642', '#A9673B', '#8D5524', '#63391F'];
const HAIR  = ['#1C1410', '#3B2417', '#5A3825', '#8B5A2B', '#B87333', '#D9A441', '#9AA0A6'];
const SHIRT = ['#E05B4B', '#3B82C4', '#4CAF6E', '#E8A33D', '#8E5FA8', '#38B2AC', '#D64F7A'];
const PANTS = ['#3A4657', '#2F3A46', '#5A6B7D', '#7A6A55', '#31445E', '#2B2438'];
const SHOES = ['#2B2438', '#F2F0E6', '#E05B4B', '#3B82C4', '#4CAF6E'];

const HAIR_STYLES = ['crop', 'buzz', 'bob', 'long', 'wavy', 'braids', 'ponytail', 'curls', 'bun'];
const EYES   = ['round', 'almond', 'wide', 'happy', 'sleepy'];
const BROWS  = ['soft', 'flat', 'arched', 'thick'];
const MOUTHS = ['smile', 'grin', 'smirk', 'calm'];
const COSTUMES = ['cap', 'crown', 'scientist', 'bear', 'explorer', 'chef', 'diver', 'none'];

const EMOTES = ['wave', 'dance', 'clap', 'cheer', 'point', 'laugh', 'flex', 'think'];

const pick = (a) => a[Math.floor(Math.random() * a.length)];

/* A bot's Islander. Built from the same palettes a player picks from, so a
   room of bots looks like a room of people rather than a row of clones. */
function makeIslander() {
  return {
    skin: pick(SKIN), hair: pick(HAIR), shirt: pick(SHIRT),
    pants: pick(PANTS), shoes: pick(SHOES),
    hairStyle: pick(HAIR_STYLES), eyes: pick(EYES),
    brows: pick(BROWS), mouth: pick(MOUTHS),
    costume: pick(COSTUMES), glasses: Math.random() < 0.25
  };
}

/* One bot's private scratchpad: where it is wandering to, when it last said
   something, and who it currently suspects. Kept off the Player so nothing
   here can leak into a state frame. */
const minds = new Map();      // pid -> mind

function mind(pid) {
  let m = minds.get(pid);
  if (!m) {
    m = {
      tx: 0, tz: 0, restUntil: 0,
      nextTalk: Date.now() / 1000 + 4 + Math.random() * 14,
      suspect: null, votedRound: -1, actedRound: -1
    };
    minds.set(pid, m);
  }
  return m;
}

function forget(pid) { minds.delete(pid); }

function isBot(player) { return !!(player && player.bot); }
function botsIn(room) { return [...room.players.values()].filter(isBot); }

/* Add one. Everything a joining socket would do - take a seat, choose an
   Islander - done in one call so the room never sees a half-built player. */
function addBot(room, Engine) {
  const taken = new Set([...room.players.values()].map((p) => p.name));
  const free = NAMES.filter((n) => !taken.has(n));
  const name = free.length ? pick(free) : 'ROBOT ' + (botsIn(room).length + 1);

  const player = room.addPlayer(name);
  player.bot = true;
  player.connected = true;
  room.actIslander(player, null, makeIslander());
  mind(player.pid);
  return player;
}

function removeBot(room) {
  const list = botsIn(room);
  if (!list.length) return null;
  const victim = list[list.length - 1];
  forget(victim.pid);
  room.removePlayer(victim.pid);
  return victim;
}

/* ---------------------------------------------------------------------------
   Wandering

   Positions are the room's own fields, updated the way a player's move
   message would update them. A bot picks a spot near the square, walks to it,
   stands about for a moment, then picks another. Speed is deliberately under
   a player's so a bot never looks like it is chasing anybody.
   --------------------------------------------------------------------------- */
const WANDER_R = 9.0;
const BOT_SPEED = 2.6;

function wander(room, player, dt, nowSec) {
  const m = mind(player.pid);

  if (!player.alive) { player.moving = false; return; }

  if (nowSec < m.restUntil) { player.moving = false; return; }

  const dx = m.tx - player.x, dz = m.tz - player.z;
  const dist = Math.hypot(dx, dz);

  if (dist < 0.45) {
    // Arrived. Stand still for a beat, then choose somewhere else. The pause
    // matters: bots that never stop read as a screensaver.
    const a = Math.random() * Math.PI * 2;
    const r = 3.2 + Math.random() * (WANDER_R - 3.2);
    m.tx = Math.cos(a) * r;
    m.tz = Math.sin(a) * r;
    m.restUntil = nowSec + 1.2 + Math.random() * 4.5;
    player.moving = false;
    return;
  }

  const step = Math.min(dist, BOT_SPEED * dt);
  player.x += (dx / dist) * step;
  player.z += (dz / dist) * step;
  player.angle = Math.atan2(dx, dz);
  player.moving = true;
}

/* ---------------------------------------------------------------------------
   Playing

   Every decision below runs through a Room action, so the rules - who may act
   in which phase, who may be targeted, whether a vote is allowed - are
   enforced in exactly one place and the bots simply obey them.
   --------------------------------------------------------------------------- */

function others(room, player) {
  return room.living.filter((p) => p.pid !== player.pid);
}

/* Who a bot thinks did it. Not deduction - a stable arbitrary suspicion,
   because a bot that changes its mind every round is unreadable, and being
   readable is what makes an opponent fun to argue with. */
function suspectOf(room, player) {
  const m = mind(player.pid);
  const pool = others(room, player);
  if (!pool.length) return null;
  const held = pool.find((p) => p.pid === m.suspect);
  if (held) return held;
  m.suspect = pick(pool).pid;
  return room.players.get(m.suspect);
}

function playNightfall(room, player) {
  const m = mind(player.pid);
  if (m.actedRound === room.round) return;

  const pool = others(room, player);
  if (!pool.length) return;

  if (player.role === 'undertow') {
    // Never its own side, when it can tell. A bot Undertow eliminating its
    // own Reef would end games by accident.
    const fair = pool.filter((p) => !p.withUndertow);
    const target = pick(fair.length ? fair : pool);
    room.actCut(player, target.pid,
                Math.floor(Math.random() * 8), Math.floor(Math.random() * 12));
    m.actedRound = room.round;
    return;
  }

  if (player.role === 'navigator') {
    const target = suspectOf(room, player) || pick(pool);
    room.actMeasure(player, target.pid);
    m.actedRound = room.round;
    return;
  }

  m.actedRound = room.round;      // villagers and reef have no night action
}

function playGathering(room, player, nowSec) {
  const m = mind(player.pid);

  // Vote, but not instantly - a room where every bot votes on the first tick
  // ends the phase before a person has read the screen.
  if (m.votedRound !== room.round && nowSec > (m.voteAt || 0)) {
    if (!m.voteAt) {
      m.voteAt = nowSec + 8 + Math.random() * 40;
      return;
    }
    const pool = others(room, player);
    if (pool.length) {
      let target;
      if (player.withUndertow) {
        // Vote with the room, away from its own side: the simplest lie.
        const fair = pool.filter((p) => !p.withUndertow);
        target = fair.length ? pick(fair) : pick(pool);
      } else {
        target = suspectOf(room, player) || pick(pool);
      }
      room.actVote(player, target.pid);
    }
    m.votedRound = room.round;
    m.voteAt = 0;
  }

  // And occasionally say something out of the fixed call list, so a room with
  // bots in it is not silent. Free text is never generated - a bot must not be
  // able to put arbitrary words on a child's screen.
  if (nowSec > m.nextTalk) {
    m.nextTalk = nowSec + 14 + Math.random() * 34;
    room.actCall(player, Math.floor(Math.random() * 8));
    return true;
  }
  return false;
}

function playDecree(room, player) {
  // If a bot is the one under the decree, it performs it and moves the phase
  // on. A human would be doing this out loud in the room; a bot cannot, so it
  // simply does not hold everybody up.
  if (player.pid === room.cut && !player.obeyed) room.actObey(player);
}

function playLobby(room, player, nowSec) {
  const m = mind(player.pid);
  if (nowSec > m.nextTalk) {
    m.nextTalk = nowSec + 10 + Math.random() * 24;
    // Through the same action a tap goes through, so a bot's wave lasts
    // exactly as long as a player's and the clock clears both.
    room.actEmote(player, pick(EMOTES));
  }
}

/* One tick of every bot in a room. Returns true when something happened that
   the full state frame needs to carry - a vote, a call - as opposed to
   movement, which rides on the position frame. */
function tick(room, dt) {
  const list = botsIn(room);
  if (!list.length) return false;

  const nowSec = Date.now() / 1000;
  let dirty = false;

  for (const player of list) {
    wander(room, player, dt, nowSec);

    switch (room.phase) {
      case 'lobby':     playLobby(room, player, nowSec); break;
      case 'nightfall': if (player.alive) playNightfall(room, player); dirty = true; break;
      case 'decree':    if (player.alive) playDecree(room, player); break;
      case 'gathering': if (player.alive && playGathering(room, player, nowSec)) dirty = true; break;
      default: break;
    }
  }
  return dirty;
}

module.exports = { addBot, removeBot, botsIn, isBot, tick, forget };
