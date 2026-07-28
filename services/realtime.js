/**
 * realtime — thin wrapper around the Socket.IO server.
 *
 * Controllers call the emit helpers here without importing server.js (avoids
 * circular deps). server.js calls setIO(io) once the socket server is up.
 * Everything no-ops safely until then, so emitting is always fire-and-forget.
 *
 * Admin analytics can contain premises and emails, so events are only ever
 * broadcast on the authenticated `/admin` namespace (see server.js gate).
 */

let io = null;

function setIO(instance) {
  io = instance;
}

// Broadcast to every connected admin dashboard.
function adminEmit(event, payload) {
  if (!io) return;
  try {
    io.of('/admin').emit(event, payload);
  } catch (e) {
    // Never let realtime break a request path.
  }
}

// A page view / app click / install — the admin refreshes traffic + sources.
function emitAnalytics(evt) {
  adminEmit('analytics:event', {
    event: evt.event || null,
    app: evt.app || null,
    source: evt.source || null,
    at: Date.now()
  });
}

// A new nebula was created — carries the row so the recent feed updates
// instantly, and signals the counts should refresh.
function emitNebula(row) {
  adminEmit('nebula:created', row);
}

// Push an event to ONE signed-in member over the `/hub` namespace. Each socket
// joins its own `user:<id>` room on connect (see server.js), so this reaches
// every open tab that user has — and silently no-ops for offline users.
function userEmit(userId, event, payload) {
  if (!io || !userId) return;
  try {
    io.of('/hub').to('user:' + String(userId)).emit(event, payload);
  } catch (e) {
    // Never let realtime break a request path.
  }
}

// Which studios are LIVE right now — sockets connected in the /studio
// namespace, keyed by studio id. Powers the LIVE pills on Hub/lobby cards.
function liveStudioCounts(ids) {
  const out = {};
  if (!io) return out;
  try {
    const rooms = io.of('/studio').adapter.rooms;
    (ids || []).forEach((id) => {
      const r = rooms.get(String(id));
      if (r && r.size > 0) out[String(id)] = r.size;
    });
  } catch (e) { /* fire-and-forget */ }
  return out;
}

module.exports = { setIO, adminEmit, emitAnalytics, emitNebula, userEmit, liveStudioCounts };
