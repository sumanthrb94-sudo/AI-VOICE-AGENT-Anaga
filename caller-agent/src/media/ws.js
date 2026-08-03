// caller-agent/src/media/ws.js
//
// Minimal RFC 6455 WebSocket SERVER. Deliberately dependency-free: the caller
// agent ships with an empty `dependencies` block and a hand-rolled subset is
// ~150 lines against a stable, fully-specified wire format.
//
// Implements exactly what a telephony media stream needs:
//   - the HTTP Upgrade handshake (Sec-WebSocket-Accept)
//   - text + binary data frames, including continuation (fragmented) frames
//   - ping/pong and close control frames
//   - client-to-server unmasking (mandatory per spec) and server-to-client
//     frames sent unmasked (also mandatory)
//
// Deliberately NOT implemented: extensions (permessage-deflate), because
// telephony audio is already compressed and negotiating it buys nothing.
//
// This is verified against Node's own global WebSocket client in
// scripts/test-media-server.mjs — real interop, not a self-consistent mock.

import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = Number(process.env.WS_MAX_MESSAGE_BYTES || 1_000_000);

export function acceptKey(key) {
  return crypto.createHash('sha1').update(String(key) + GUID).digest('base64');
}

/** True when this request is a valid WebSocket upgrade. */
export function isUpgrade(req) {
  return String(req.headers.upgrade || '').toLowerCase() === 'websocket'
    && Boolean(req.headers['sec-websocket-key']);
}

/**
 * Complete the handshake and return a small connection object.
 * @returns {{send:Function, close:Function, on:Function, socket:object}|null}
 */
export function upgrade(req, socket, head) {
  if (!isUpgrade(req)) { socket.destroy(); return null; }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n`
    + '\r\n'
  );

  const handlers = { message: [], close: [], error: [] };
  const emit = (ev, ...a) => handlers[ev]?.forEach((h) => { try { h(...a); } catch { /* handler's problem */ } });

  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let closed = false;

  // Fragmented-message accumulator.
  let fragOpcode = null;
  let fragParts = [];
  let fragBytes = 0;

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);

    for (;;) {
      const frame = decodeFrame(buf);
      if (!frame) break;                 // need more bytes
      buf = buf.subarray(frame.consumed);

      const { fin, opcode, payload } = frame;

      // --- control frames: never fragmented, handled inline ---------------
      if (opcode === 0x8) { close(1000, 'peer_closed'); return; }
      if (opcode === 0x9) { socket.write(encodeFrame(0xA, payload)); continue; }  // ping -> pong
      if (opcode === 0xA) continue;                                               // pong

      // --- data frames ----------------------------------------------------
      if (opcode === 0x0) {
        if (fragOpcode == null) { emit('error', new Error('continuation_without_start')); close(1002, 'protocol'); return; }
      } else {
        fragOpcode = opcode;
        fragParts = [];
        fragBytes = 0;
      }

      fragParts.push(payload);
      fragBytes += payload.length;
      if (fragBytes > MAX_MESSAGE_BYTES) {
        emit('error', new Error('message_too_large'));
        close(1009, 'too_large');
        return;
      }

      if (fin) {
        const full = Buffer.concat(fragParts);
        const op = fragOpcode;
        fragOpcode = null; fragParts = []; fragBytes = 0;
        emit('message', op === 0x1 ? full.toString('utf8') : full, op === 0x1 ? 'text' : 'binary');
      }
    }
  });

  socket.on('error', (err) => { emit('error', err); close(1011, 'socket_error'); });
  socket.on('close', () => close(1006, 'socket_closed'));

  function close(code = 1000, reason = 'closed') {
    if (closed) return;
    closed = true;
    try { socket.write(encodeFrame(0x8, Buffer.alloc(0))); } catch { /* already gone */ }
    try { socket.destroy(); } catch { /* already gone */ }
    emit('close', code, reason);
  }

  return {
    socket,
    get closed() { return closed; },
    on(ev, fn) { (handlers[ev] ||= []).push(fn); return this; },
    send(data) {
      if (closed) return false;
      const isText = typeof data === 'string';
      try {
        socket.write(encodeFrame(isText ? 0x1 : 0x2, isText ? Buffer.from(data, 'utf8') : Buffer.from(data)));
        return true;
      } catch {
        return false;
      }
    },
    close,
  };
}

/**
 * Decode one frame. Returns null when more bytes are needed.
 * Client frames are ALWAYS masked per spec; we unmask here.
 */
export function decodeFrame(buf) {
  if (buf.length < 2) return null;

  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset); offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const big = buf.readBigUInt64BE(offset); offset += 8;
    if (big > BigInt(MAX_MESSAGE_BYTES)) throw new Error('frame_too_large');
    len = Number(big);
  }

  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4); offset += 4;
  }

  if (buf.length < offset + len) return null;

  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

  return { fin, opcode, payload, consumed: offset + len };
}

/** Encode a server frame — never masked, per spec. */
export function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;

  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;   // FIN + opcode
  return Buffer.concat([header, data]);
}
