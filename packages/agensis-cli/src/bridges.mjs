// The daemon lane of channel bridges: the transports that CANNOT run on a
// server, running here instead.
//
// Three providers, one reason each:
//   whatsapp  links as a companion device (Baileys). The account keys are the
//             user's and stay on the user's disk. A hosted service holding them
//             would be holding the user's WhatsApp account.
//   signal    has no server API at all. signal-cli links as a second device,
//             same shape as WhatsApp.
//   openclaw  binds to 127.0.0.1:18789 by default — the gateway is on the
//             user's machine and is not reachable from anywhere else.
//
// The hub never sees a credential for any of these. It sends `bridge_send` and
// receives `bridge_inbound` / `bridge_status`, and everything else — QR codes,
// session files, reconnects — lives here.
//
// Both heavy dependencies are OPTIONAL and loaded on demand: the overwhelming
// majority of daemons never bridge anything, and making every install pay for
// Baileys (and a signal-cli binary that may not exist) would be indefensible.
// A missing dependency is reported as a bridge status, not a crash.

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require_ = createRequire(import.meta.url);

// bridgeId -> { provider, stop() , send(text, author) }
const active = new Map();

function stateDir(bridgeId, provider) {
  const dir = path.join(os.homedir(), '.agensis', 'bridges', provider, String(bridgeId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// WhatsApp — Baileys, QR-linked companion device
// ---------------------------------------------------------------------------

async function startWhatsApp({ bridgeId, externalId, emit }) {
  let baileys;
  try {
    baileys = require_('@whiskeysockets/baileys');
  } catch {
    emit({ action: 'bridge_status', bridgeId, status: 'error',
      error: 'WhatsApp support needs @whiskeysockets/baileys installed on this machine: npm i -g @whiskeysockets/baileys' });
    return null;
  }
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;
  const { state, saveCreds } = await useMultiFileAuthState(stateDir(bridgeId, 'whatsapp'));

  const sock = makeWASocket({ auth: state, printQRInTerminal: false });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    // The QR is a live credential valid for seconds. It goes straight up to the
    // open setup dialog and is never written down.
    if (update.qr) emit({ action: 'bridge_status', bridgeId, status: 'pairing', qr: update.qr });
    if (update.connection === 'open') emit({ action: 'bridge_status', bridgeId, status: 'connected' });
    if (update.connection === 'close') {
      const code = update.lastDisconnect?.error?.output?.statusCode;
      // loggedOut means the user unlinked the device: reconnecting would just
      // spin, and the stored creds are now worthless.
      const loggedOut = code === DisconnectReason?.loggedOut;
      emit({ action: 'bridge_status', bridgeId, status: loggedOut ? 'error' : 'reconnecting',
        error: loggedOut ? 'WhatsApp was unlinked on the phone. Scan again to reconnect.' : null });
      if (!loggedOut && active.has(bridgeId)) {
        setTimeout(() => { void startWhatsApp({ bridgeId, externalId, emit }); }, 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      // fromMe is our own traffic coming back down the socket — a linked device
      // sees everything the account sends, including what WE just sent.
      if (m.key?.fromMe) continue;
      const jid = m.key?.remoteJid;
      if (!jid) continue;
      if (externalId && jid !== externalId) continue;
      const text = m.message?.conversation
        || m.message?.extendedTextMessage?.text
        || '';
      if (!text.trim()) continue;
      emit({
        action: 'bridge_inbound',
        bridgeId,
        externalMessageId: m.key.id ? `${jid}:${m.key.id}` : '',
        author: m.pushName || jid.split('@')[0],
        text,
        externalId: jid,
      });
    }
  });

  return {
    provider: 'whatsapp',
    async send(text, author) {
      const jid = externalId;
      if (!jid) throw new Error('No WhatsApp conversation selected yet');
      const body = author ? `*${author}*: ${text}` : text;
      const sent = await sock.sendMessage(jid, { text: body });
      return sent?.key?.id ? `${jid}:${sent.key.id}` : null;
    },
    stop() { try { sock.end(); } catch { /* already gone */ } },
  };
}

// ---------------------------------------------------------------------------
// Signal — signal-cli in JSON-RPC mode
// ---------------------------------------------------------------------------

async function startSignal({ bridgeId, externalId, emit, account }) {
  // signal-cli is a separate binary, not an npm package. Absent is the normal
  // case, so say what to install rather than throwing a spawn ENOENT.
  const proc = spawn('signal-cli', ['-a', account || '', 'jsonRpc'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffered = '';
  let nextId = 1;

  proc.on('error', () => {
    emit({ action: 'bridge_status', bridgeId, status: 'error',
      error: 'signal-cli is not installed on this machine. Install it (brew install signal-cli) and link a device.' });
  });
  proc.stderr.on('data', (chunk) => {
    const line = String(chunk);
    if (/link|tsdevice/i.test(line)) {
      const match = line.match(/(sgnl:\/\/linkdevice\S+|tsdevice:\S+)/);
      if (match) emit({ action: 'bridge_status', bridgeId, status: 'pairing', qr: match[1] });
    }
  });

  proc.stdout.on('data', (chunk) => {
    buffered += String(chunk);
    // JSON-RPC over a pipe is newline-delimited, and a chunk boundary can land
    // mid-object — hold the tail rather than trying to parse a partial line.
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      const envelope = frame?.params?.envelope;
      const message = envelope?.dataMessage;
      if (!envelope || !message?.message) continue;
      const groupId = message.groupInfo?.groupId || envelope.sourceNumber;
      if (externalId && groupId !== externalId) continue;
      emit({
        action: 'bridge_inbound',
        bridgeId,
        // The send timestamp is Signal's per-message identity and is stable
        // across signal-cli restarts, which re-deliver anything unacknowledged.
        externalMessageId: `${groupId}:${envelope.timestamp}`,
        author: envelope.sourceName || envelope.sourceNumber || 'Signal user',
        text: message.message,
        externalId: groupId,
      });
    }
  });

  emit({ action: 'bridge_status', bridgeId, status: 'connected' });

  return {
    provider: 'signal',
    async send(text, author) {
      const body = author ? `${author}: ${text}` : text;
      const isGroup = String(externalId || '').length > 20;
      const req = {
        jsonrpc: '2.0',
        id: String(nextId++),
        method: 'send',
        params: isGroup ? { groupId: externalId, message: body } : { recipient: [externalId], message: body },
      };
      proc.stdin.write(`${JSON.stringify(req)}\n`);
      return null; // signal-cli answers asynchronously; dedup rides the inbound side
    },
    stop() { try { proc.kill(); } catch { /* already gone */ } },
  };
}

// ---------------------------------------------------------------------------
// OpenClaw — an operator CLIENT on the user's gateway
// ---------------------------------------------------------------------------

// Deliberately a client, not a node. In OpenClaw's model a node is a DEVICE that
// declares capabilities and executes commands; a client is the control-plane
// connection that sends requests and subscribes to events. Mirroring chats into
// agensis is the latter. (Registering agensis agents as an OpenClaw node — the
// opposite direction — is a separate feature.)
async function startOpenClaw({ bridgeId, externalId, emit, config }) {
  const WebSocketImpl = (await import('ws')).default;
  const url = String(config?.gatewayUrl || 'ws://127.0.0.1:18789');
  const token = String(config?.authToken || '');
  const ws = new WebSocketImpl(url);
  let nextId = 1;
  const pending = new Map();

  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = String(nextId++);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
    // The gateway's own request timeout is 30s; failing at the same point keeps
    // a caller from waiting on a promise the other side has already abandoned.
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`OpenClaw ${method} timed out`));
    }, 30_000);
  });

  ws.on('open', () => emit({ action: 'bridge_status', bridgeId, status: 'connecting' }));
  ws.on('error', (error) => emit({
    action: 'bridge_status', bridgeId, status: 'error',
    error: `OpenClaw gateway: ${error?.message || error}`,
  }));

  ws.on('message', async (raw) => {
    let frame;
    try { frame = JSON.parse(String(raw)); } catch { return; }

    // The gateway opens with a challenge; the connect request answers it.
    if (frame.type === 'event' && frame.event === 'connect.challenge') {
      try {
        await rpc('connect', {
          minProtocol: 4,
          maxProtocol: 4,
          client: { id: 'agensis', version: '1', platform: process.platform, mode: 'operator' },
          role: 'operator',
          scopes: ['operator.read', 'operator.write'],
          auth: { token },
          device: { id: `agensis-${bridgeId}`, nonce: frame.payload?.nonce },
        });
        await rpc('watch.subscribe', {});
        emit({ action: 'bridge_status', bridgeId, status: 'connected' });
      } catch (error) {
        emit({ action: 'bridge_status', bridgeId, status: 'error', error: String(error.message || error) });
      }
      return;
    }

    if (frame.type === 'res' && pending.has(frame.id)) {
      const { resolve, reject } = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.ok) resolve(frame.payload);
      else reject(new Error(frame.error?.message || 'OpenClaw request failed'));
      return;
    }

    // watch.subscribe delivers inbound traffic as notifications whose method is
    // "message".
    if (frame.method === 'message' || frame.event === 'message') {
      const p = frame.params || frame.payload || {};
      const chatId = String(p.chat_id ?? p.chatId ?? '');
      if (externalId && chatId !== externalId) return;
      if (p.fromMe || p.outbound) return;
      const text = String(p.text ?? p.message ?? '');
      if (!text.trim()) return;
      emit({
        action: 'bridge_inbound',
        bridgeId,
        externalMessageId: String(p.id ?? p.message_id ?? ''),
        author: String(p.sender_name ?? p.author ?? 'OpenClaw'),
        text,
        externalId: chatId,
      });
    }
  });

  return {
    provider: 'openclaw',
    async send(text, author) {
      const body = author ? `${author}: ${text}` : text;
      // Side-effecting gateway methods require an idempotency key, so a retry
      // after a dropped response cannot post twice.
      const res = await rpc('send', {
        chat_id: externalId,
        text: body,
        idempotency_key: `agensis-${bridgeId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      });
      return res?.id ? String(res.id) : null;
    },
    stop() { try { ws.close(); } catch { /* already gone */ } },
  };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const STARTERS = { whatsapp: startWhatsApp, signal: startSignal, openclaw: startOpenClaw };

/**
 * Handle a bridge frame from the hub.
 *
 * `emit` writes back up the SAME socket the daemon already holds, and is passed
 * in rather than captured so a reconnect swaps it underneath us — the same
 * reason the permission broker takes a live sender.
 */
export async function handleBridgeFrame(message, emit) {
  const bridgeId = String(message?.bridgeId || '');
  if (!bridgeId) return;

  if (message.action === 'bridge_stop') {
    active.get(bridgeId)?.stop?.();
    active.delete(bridgeId);
    return;
  }

  if (message.action === 'bridge_start') {
    if (active.has(bridgeId)) return; // already running; restart is stop-then-start
    const starter = STARTERS[String(message.provider)];
    if (!starter) return;
    try {
      const conn = await starter({
        bridgeId,
        externalId: String(message.externalId || ''),
        config: message.config || {},
        account: message.account,
        emit,
      });
      if (conn) active.set(bridgeId, conn);
    } catch (error) {
      emit({ action: 'bridge_status', bridgeId, status: 'error', error: String(error?.message || error) });
    }
    return;
  }

  if (message.action === 'bridge_send') {
    const conn = active.get(bridgeId);
    if (!conn) {
      emit({ action: 'bridge_status', bridgeId, status: 'error', error: 'This bridge is not running on this machine.' });
      return;
    }
    try {
      const externalMessageId = await conn.send(String(message.text || ''), String(message.author || ''));
      // Report our own send so the hub can claim the id: WhatsApp and Signal
      // both echo a linked device's own traffic straight back, and without the
      // claim that echo reads as a new inbound message.
      if (externalMessageId) {
        emit({ action: 'bridge_status', bridgeId, status: 'connected', sentMessageId: externalMessageId });
      }
    } catch (error) {
      emit({ action: 'bridge_status', bridgeId, status: 'error', error: String(error?.message || error) });
    }
  }
}

export function stopAllBridges() {
  for (const conn of active.values()) conn.stop?.();
  active.clear();
}

export function activeBridgeIds() {
  return [...active.keys()];
}
