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

module.exports = { setIO, adminEmit, emitAnalytics, emitNebula };
