// Smoky — Discord Rich Presence, leichtgewichtig und ohne native Pakete.
// Spricht direkt mit der lokalen Discord-Desktop-App über die IPC-Named-Pipe
// (discord-ipc-0 … discord-ipc-9) auf Windows bzw. den Unix-Socket auf macOS/Linux.
// Kein npm-Paket, keine node-gyp-Kompilierung — läuft überall, wo Node läuft.
//
// Braucht eine Discord-Application-ID (discord.com/developers → New Application
// → General Information → Application ID). Ohne gültige ID bleibt das Ganze still.

const net = require('node:net');

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

// 8-Byte-Header (op: uint32 LE, length: uint32 LE) + JSON-Payload.
function buildFrame(op, payload) {
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const buf = Buffer.alloc(8 + data.length);
  buf.writeUInt32LE(op, 0);
  buf.writeUInt32LE(data.length, 4);
  data.copy(buf, 8);
  return buf;
}

// Puffert eingehende Bytes und gibt komplette Frames + Rest zurück.
function parseFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const op = buf.readUInt32LE(off);
    const len = buf.readUInt32LE(off + 4);
    if (off + 8 + len > buf.length) break;
    try {
      frames.push({ op, payload: JSON.parse(buf.toString('utf8', off + 8, off + 8 + len)) });
    } catch {}
    off += 8 + len;
  }
  return { frames, rest: buf.subarray(off) };
}

function defaultPipePath(i) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${i}`;
  return `${process.env.XDG_RUNTIME_DIR || '/tmp'}/discord-ipc-${i}`;
}

class DiscordRPC {
  // clientId: Discord-Application-ID; opts.pipePath: Override für Tests.
  constructor(clientId, opts = {}) {
    this.clientId = clientId;
    this.maxPipes = opts.maxPipes != null ? opts.maxPipes : 10; // discord-ipc-0 … 9
    this.retryMs = opts.retryMs != null ? opts.retryMs : 15000;
    this.pipePath = opts.pipePath || null;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.handshakeDone = false;
    this.currentActivity = null;
    this.reconnectTimer = null;
    this.pipeIndex = 0;
    this.connecting = false;
    this._onActivitySent = opts.onActivitySent || null; // Test-Hook
  }

  // Gültige IDs bestehen aus Ziffern; Platzhalter wie "DEINE_ID" werden ignoriert.
  static hasValidId(id) {
    return /^\d+$/.test(String(id || ''));
  }

  start() {
    if (!DiscordRPC.hasValidId(this.clientId)) return false;
    this.connect();
    return true;
  }

  connect() {
    if (this.connecting || this.sock) return;
    this.connecting = true;
    const idx = this.pipeIndex;
    const path = this.pipePath || defaultPipePath(idx);
    const s = net.connect({ path });
    const timeout = setTimeout(() => { try { s.destroy(); } catch {} }, 3000);

    s.on('connect', () => {
      clearTimeout(timeout);
      this.pipeIndex = 0; // zurücksetzen — nächster Versuch startet wieder bei 0
      this.sock = s;
      this.buf = Buffer.alloc(0);
      this.handshakeDone = false;
      s.write(buildFrame(OP_HANDSHAKE, { v: 1, client_id: this.clientId }));
    });

    s.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      const { frames, rest } = parseFrames(this.buf);
      this.buf = rest;
      for (const f of frames) {
        if (f.payload && f.payload.evt === 'READY') {
          this.handshakeDone = true;
          this.connecting = false;
          if (this.currentActivity) this.sendActivity(this.currentActivity);
        } else if (f.op === OP_PING) {
          try { s.write(buildFrame(OP_PONG, f.payload)); } catch {}
        } else if (f.op === OP_CLOSE) {
          this.disconnect();
        }
      }
    });

    s.on('error', () => {
      clearTimeout(timeout);
      this.connecting = false;
      this.sock = null;
      this.handshakeDone = false;
      this.scheduleReconnect();
    });

    s.on('close', () => {
      clearTimeout(timeout);
      this.connecting = false;
      this.sock = null;
      this.handshakeDone = false;
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this._stopped) return;
    if (!this.pipePath) {
      // Nächste Pipe probieren; nach der letzten von vorn beginnen.
      this.pipeIndex = (this.pipeIndex + 1) % this.maxPipes;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.retryMs);
  }

  setActivity(activity) {
    // Nur senden, wenn sich etwas geändert hat (Discord mag keine Spam-Updates).
    const key = JSON.stringify(activity);
    if (key === this._lastKey) return;
    this._lastKey = key;
    this.currentActivity = activity;
    if (this.sock && this.handshakeDone) this.sendActivity(activity);
  }

  sendActivity(activity) {
    if (!this.sock) return;
    try {
      this.sock.write(buildFrame(OP_FRAME, {
        cmd: 'SET_ACTIVITY',
        args: { pid: process.pid, activity: activity || null },
        nonce: 'smoky-' + Date.now(),
      }));
      if (this._onActivitySent) this._onActivitySent(activity);
    } catch {}
  }

  clearActivity() {
    this._lastKey = null;
    this.setActivity(null);
  }

  disconnect() {
    this._stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.sock) { try { this.sock.destroy(); } catch {} }
    this.sock = null;
    this.handshakeDone = false;
    this.connecting = false;
  }
}

module.exports = { DiscordRPC, buildFrame, parseFrames, OP_HANDSHAKE, OP_FRAME, OP_PING, OP_PONG };
