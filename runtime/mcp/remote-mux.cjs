const { randomUUID } = require('node:crypto');

// One authenticated socket per runtime/client process. Streams remain separately
// timed and cancelled; a disconnect fails observations instead of inventing state.
class RemoteMux {
  constructor(Socket, url, cookie, onClose = () => {}) {
    this.Socket = Socket;
    this.pending = new Map();
    this.socket = new Socket(url, { headers: { cookie }, maxPayload: 16 * 1024 * 1024 });
    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject;
      this.socket.addEventListener('open', () => resolve());
    });
    this.ready.catch(() => {});
    this.socket.addEventListener('message', ({ data }) => {
      let frame;
      try { frame = JSON.parse(String(data)); } catch { this.fail(new Error('Invalid DSH stream frame')); return; }
      const request = this.pending.get(frame.streamId);
      if (!request) return;
      if (frame.type === 'item') request.finish(null, frame.value);
      else if (frame.type === 'error') request.finish(new Error(frame.error?.message || 'DSH stream failed'));
      else if (frame.type === 'end') request.finish(new Error('DSH stream ended without a snapshot'));
    });
    this.socket.addEventListener('error', () => this.fail(new Error('DSH WebSocket connection failed')));
    this.socket.addEventListener('close', () => { this.fail(new Error('DSH stream closed')); onClose(); });
  }
  fail(error) {
    this.rejectReady(error);
    for (const request of [...this.pending.values()]) request.finish(error);
    clearTimeout(this.idleTimer);
    this.socket.terminate();
  }
  first(endpoint, payload, timeoutMs) {
    clearTimeout(this.idleTimer);
    this.socket._socket?.ref();
    return new Promise((resolve, reject) => {
      const streamId = randomUUID();
      const finish = (error, value) => {
        if (!this.pending.delete(streamId)) return;
        clearTimeout(timer);
        if (this.socket.readyState === this.Socket.OPEN) this.socket.send(JSON.stringify({ type: 'cancel', streamId }));
        if (error) reject(error); else resolve(value);
        if (!this.pending.size) {
          this.idleTimer = setTimeout(() => this.socket.close(), 5000);
          this.idleTimer.unref?.();
          this.socket._socket?.unref();
        }
      };
      const timer = setTimeout(() => finish(new Error(`${endpoint}: timeout`)), timeoutMs);
      this.pending.set(streamId, { finish });
      this.ready.then(() => {
        if (this.pending.has(streamId)) this.socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args: payload } }));
      }).catch((error) => finish(error));
    });
  }
}
module.exports = { RemoteMux };
