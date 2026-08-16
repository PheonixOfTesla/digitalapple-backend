/* Engine-level checks for the three-round cap, the results list and reset.
   Driven directly rather than through a browser, because a real match is
   three minutes a round and the thing being tested is arithmetic. */
const { registry } = require('./engine');
const bots = require('./bots');

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

// --- a match where nobody is ever voted out should end after three rounds ---
const room = registry.create('HOST');
for (let i = 0; i < 5; i++) bots.addBot(room);
room.start();
check('starts at round 1', room.round, 1);
check('phase is nightfall', room.phase, 'nightfall');

const holder = [...room.players.values()].find(p => p.role === 'undertow');
console.log(`      notebook is ${holder.name}`);

// Run rounds without anybody voting, so only the round cap can end it.
for (let guard = 0; guard < 40 && room.phase !== 'over'; guard++) {
  if (room.phase === 'nightfall') {
    // Nobody is cut, so nobody dies and only the cap can decide the match.
    room.cut = null;
    const nav = room.living.find(p => p.role === 'navigator');
    if (nav) nav.findings[String(room.round)] = { pid: null, name: '', undertow: false };
  }
  room.advance();
}
check('match ended', room.phase, 'over');
check('ended on the round cap', room.round, 3);
check('notebook wins when never found', room.winner, 'undertow');

// --- results ---
const r = room.results || [];
check('a result row per player', r.length, room.players.size);
const holderRow = r.find(x => x.role === 'undertow');
check('the notebook holder is listed as a winner', !!(holderRow && holderRow.won), true);
const villagerRow = r.find(x => x.role === 'villager');
check('a villager is listed as a loser', !!(villagerRow && !villagerRow.won), true);
check('every row carries a name', r.every(x => !!x.name), true);
check('every row carries a title', r.every(x => !!x.title), true);

// --- new game keeps the room ---
const before = room.players.size;
room.resetToLobby();
check('back in the lobby', room.phase, 'lobby');
check('players kept', room.players.size, before);
check('round reset', room.round, 0);
check('results cleared', room.results, null);
check('everybody alive again', [...room.players.values()].every(p => p.alive), true);

// --- and a match that IS won early should not wait for the cap ---
const room2 = registry.create('HOST2');
for (let i = 0; i < 5; i++) bots.addBot(room2);
room2.start();
const holder2 = [...room2.players.values()].find(p => p.role === 'undertow');
holder2.alive = false;                       // as if voted out
room2.checkWinner();
check('village wins the moment the notebook is out', room2.winner, 'villagers');
check('and it did not need three rounds', room2.round < 3, true);

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
