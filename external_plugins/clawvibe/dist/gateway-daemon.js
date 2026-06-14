#!/usr/bin/env bun
// @bun
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// gateway-daemon.ts
import { randomBytes as randomBytes2 } from "crypto";
import { readFileSync as readFileSync2, writeFileSync as writeFileSync2, rmSync as rmSync2, existsSync, unlinkSync } from "fs";

// shared/access.ts
import { randomBytes } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, chmodSync } from "fs";
import { homedir } from "os";
import { join } from "path";
var STATE_DIR = process.env.CLAWVIBE_STATE_DIR ?? join(homedir(), ".claude", "channels", "clawvibe");
var ACCESS_FILE = join(STATE_DIR, "access.json");
var APPROVED_DIR = join(STATE_DIR, "approved");
var PID_FILE = join(STATE_DIR, "server.pid");
var SOCK_FILE = join(STATE_DIR, "gateway.sock");
var PORT = Number(process.env.CLAWVIBE_PORT ?? 8791);
var HOSTNAME = process.env.CLAWVIBE_HOSTNAME ?? "127.0.0.1";
var TICK_INTERVAL_MS = 30000;
var HANDSHAKE_TIMEOUT_MS = 1e4;
var ACTIVE_RUN_TTL_MS = 5 * 60 * 1000;
function ensureStateDirs() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 448 });
  mkdirSync(APPROVED_DIR, { recursive: true, mode: 448 });
}
function defaultAccess() {
  return { dmPolicy: "pairing", approved: {}, pending: {} };
}
function readAccess() {
  try {
    const raw = readFileSync(ACCESS_FILE, "utf8");
    const a = JSON.parse(raw);
    return {
      dmPolicy: a.dmPolicy ?? "pairing",
      approved: a.approved ?? {},
      pending: a.pending ?? {},
      bootstrapTokens: a.bootstrapTokens
    };
  } catch {
    return defaultAccess();
  }
}
function writeAccess(a) {
  writeFileSync(ACCESS_FILE, JSON.stringify(a, null, 2));
  try {
    chmodSync(ACCESS_FILE, 384);
  } catch {}
}
function newPairCode() {
  const alpha = "ABCDEFGHIJKMNOPQRSTUVWXYZ";
  let s = "";
  for (const b of randomBytes(5))
    s += alpha[b % alpha.length];
  return s;
}
function newToken() {
  return randomBytes(32).toString("base64url");
}
function tokenToDevice(token) {
  if (!token)
    return;
  const a = readAccess();
  for (const d of Object.values(a.approved))
    if (d.token === token)
      return d;
  return;
}
function newBootstrapToken() {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const a = readAccess();
  if (!a.bootstrapTokens)
    a.bootstrapTokens = {};
  for (const [k, v] of Object.entries(a.bootstrapTokens)) {
    if (v.expires_at < Date.now() && !v.paired_device_id)
      delete a.bootstrapTokens[k];
  }
  a.bootstrapTokens[token] = { created_at: Date.now(), expires_at: expiresAt, used: false };
  writeAccess(a);
  return { token, expiresAt };
}
function consumeBootstrapToken(token) {
  const a = readAccess();
  const bt = a.bootstrapTokens?.[token];
  if (!bt || bt.used || bt.expires_at < Date.now())
    return false;
  bt.used = true;
  writeAccess(a);
  return true;
}
function drainApprovalSentinels() {
  let names = [];
  try {
    names = readdirSync(APPROVED_DIR);
  } catch {
    return;
  }
  if (names.length === 0)
    return;
  const a = readAccess();
  let changed = false;
  for (const deviceId of names) {
    const code = Object.keys(a.pending).find((c) => a.pending[c].device_id === deviceId);
    if (code) {
      const p = a.pending[code];
      a.approved[deviceId] = {
        device_id: deviceId,
        device_name: p.device_name,
        token: newToken(),
        approved_at: Date.now()
      };
      delete a.pending[code];
      changed = true;
    }
    try {
      rmSync(join(APPROVED_DIR, deviceId));
    } catch {}
  }
  if (changed)
    writeAccess(a);
}

// shared/protocol.ts
function agentIdFromSessionKey(sessionKey) {
  if (!sessionKey)
    return null;
  const m = /^agent:([^:]+):/.exec(sessionKey);
  return m ? m[1] : null;
}
function encodeFrame(frame) {
  return JSON.stringify(frame) + `
`;
}
function makeLineDecoder(onFrame) {
  let buf = "";
  const decoder = new TextDecoder;
  return (chunk) => {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf(`
`)) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line)
        continue;
      try {
        onFrame(JSON.parse(line));
      } catch {}
    }
  };
}

// gateway-daemon.ts
var startedAt = Date.now();
ensureStateDirs();
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
try {
  const existing = parseInt(readFileSync2(PID_FILE, "utf8"), 10);
  if (existing !== process.pid && pidAlive(existing)) {
    process.stderr.write(`clawvibe-daemon: another daemon is live (pid=${existing}); exiting
`);
    process.exit(0);
  }
} catch {}
async function ensureSocketFree() {
  if (!existsSync(SOCK_FILE))
    return;
  try {
    const probe = await Bun.connect({
      unix: SOCK_FILE,
      socket: { data() {}, open() {}, close() {}, error() {} }
    });
    probe.end();
    process.stderr.write(`clawvibe-daemon: gateway.sock already owned by a live daemon; exiting
`);
    process.exit(0);
  } catch {
    try {
      unlinkSync(SOCK_FILE);
    } catch {}
  }
}
await ensureSocketFree();
process.on("unhandledRejection", (err) => {
  process.stderr.write(`clawvibe-daemon: unhandled rejection: ${err}
`);
});
var agentClients = new Map;
function writeIpc(sock, frame) {
  try {
    sock.write(encodeFrame(frame));
  } catch (err) {
    process.stderr.write(`clawvibe-daemon: ipc write failed: ${err}
`);
  }
}
function pickFallbackAgentId() {
  if (agentClients.size === 0)
    return null;
  const ids = [...agentClients.keys()];
  return ids[0];
}
function handleIpcFrame(sock, frame) {
  switch (frame.t) {
    case "register": {
      const { agentId, identity } = frame;
      const prev = agentClients.get(agentId);
      if (prev && prev.sock !== sock) {
        process.stderr.write(`clawvibe-daemon: replacing stale client for agent=${agentId}
`);
        try {
          prev.sock.end();
        } catch {}
      }
      sock.data.agentId = agentId;
      agentClients.set(agentId, { agentId, identity, sock, registeredAt: Date.now() });
      writeIpc(sock, { v: 1, t: "register.ok", agentId });
      process.stderr.write(`clawvibe-daemon: agent registered id=${agentId} name="${identity.name}"
`);
      return;
    }
    case "reply": {
      const run = activeRuns.get(frame.sessionKey);
      if (!run) {
        process.stderr.write(`clawvibe-daemon: reply for unknown session ${frame.sessionKey}
`);
        return;
      }
      broadcastChatEvent(frame.runId || run.runId, frame.sessionKey, frame.state, {
        text: frame.text,
        errorMessage: frame.errorMessage,
        targetDeviceId: run.deviceId
      });
      return;
    }
    case "edit": {
      const run = activeRuns.get(frame.sessionKey);
      if (!run)
        return;
      broadcastChatEvent(frame.messageId, frame.sessionKey, "final", {
        text: frame.text,
        targetDeviceId: run.deviceId
      });
      return;
    }
    case "ping":
      return;
  }
}
function onIpcClose(sock) {
  const agentId = sock.data?.agentId;
  if (agentId && agentClients.get(agentId)?.sock === sock) {
    agentClients.delete(agentId);
    process.stderr.write(`clawvibe-daemon: agent deregistered id=${agentId}
`);
  }
}
var ipcServer = Bun.listen({
  unix: SOCK_FILE,
  socket: {
    open(sock) {
      sock.data = { decode: makeLineDecoder((f) => handleIpcFrame(sock, f)) };
    },
    data(sock, data) {
      sock.data.decode(data);
    },
    close(sock) {
      onIpcClose(sock);
    },
    error(sock, err) {
      process.stderr.write(`clawvibe-daemon: ipc socket error: ${err}
`);
      onIpcClose(sock);
    }
  }
});
var clients = new Map;
var handshakeTimers = new Map;
var activeRuns = new Map;
var runSeq = new Map;
var msgSeq = 0;
var eventSeq = 0;
function nextMsgId() {
  return `m${Date.now()}-${++msgSeq}`;
}
function nextEventSeq() {
  return ++eventSeq;
}
function nextRunSeq(runId) {
  const n = (runSeq.get(runId) ?? -1) + 1;
  runSeq.set(runId, n);
  return n;
}
function reapDeadSockets() {
  let reaped = 0;
  for (const [deviceId, set] of clients) {
    for (const ws of set)
      if (ws.readyState !== 1) {
        set.delete(ws);
        reaped++;
      }
    if (set.size === 0)
      clients.delete(deviceId);
  }
  if (reaped > 0)
    process.stderr.write(`clawvibe-daemon: reaped ${reaped} dead socket(s)
`);
}
function pruneActiveRuns() {
  const now = Date.now();
  for (const [k, v] of activeRuns) {
    if (now - v.ts > ACTIVE_RUN_TTL_MS) {
      activeRuns.delete(k);
      runSeq.delete(v.runId);
      broadcastChatEvent(v.runId, k, "aborted", { targetDeviceId: v.deviceId });
    }
  }
}
function sendFrame(ws, frame) {
  try {
    if (ws.readyState === 1)
      ws.send(JSON.stringify(frame));
  } catch (err) {
    process.stderr.write(`clawvibe-daemon: sendFrame failed: ${err}
`);
  }
}
function broadcastEvent(frame, targetDeviceId) {
  let sent = 0, skipped = 0;
  let payload;
  try {
    payload = JSON.stringify(frame);
  } catch (err) {
    process.stderr.write(`clawvibe-daemon: broadcastEvent serialize failed: ${err}
`);
    return;
  }
  const send = (ws) => {
    if (!ws.data.authenticated) {
      skipped++;
      return;
    }
    if (ws.readyState === 1) {
      ws.send(payload);
      sent++;
    } else {
      skipped++;
    }
  };
  if (targetDeviceId)
    clients.get(targetDeviceId)?.forEach(send);
  else
    for (const set of clients.values())
      set.forEach(send);
  if (frame.event !== "tick") {
    process.stderr.write(`clawvibe-daemon: broadcast event=${frame.event} sent=${sent} skipped=${skipped}
`);
  }
}
function broadcastChatEvent(runId, sessionKey, state, opts = {}) {
  const payload = {
    runId,
    sessionKey,
    seq: nextRunSeq(runId),
    state
  };
  if (opts.text !== undefined) {
    payload.message = {
      role: "assistant",
      content: [{ type: "text", text: opts.text }],
      timestamp: new Date().toISOString()
    };
  }
  if (opts.errorMessage !== undefined)
    payload.errorMessage = opts.errorMessage;
  if (state === "final" || state === "error" || state === "aborted")
    runSeq.delete(runId);
  broadcastEvent({
    type: "event",
    event: "chat",
    payload,
    seq: nextEventSeq(),
    stateVersion: null
  }, opts.targetDeviceId);
}
setInterval(() => {
  reapDeadSockets();
  pruneActiveRuns();
  broadcastEvent({ type: "event", event: "tick", payload: null, seq: nextEventSeq(), stateVersion: null });
}, TICK_INTERVAL_MS);
function routeInbound(sessionKey, runId, text, meta) {
  const agentId = agentIdFromSessionKey(sessionKey) ?? pickFallbackAgentId();
  const conn = agentId ? agentClients.get(agentId) : undefined;
  if (!conn) {
    process.stderr.write(`clawvibe-daemon: no agent for session=${sessionKey} (agentId=${agentId})
`);
    return false;
  }
  writeIpc(conn.sock, { v: 1, t: "inbound", sessionKey, runId, text, meta });
  return true;
}
function handleConnect(ws, req) {
  const params = req.params ?? {};
  const auth = params.auth;
  const token = auth?.token ?? "";
  const bootstrapToken = auth?.bootstrapToken ?? "";
  process.stderr.write(`clawvibe-daemon: connect auth=[${Object.keys(auth ?? {}).join(",") || "none"}]
`);
  let device;
  if (bootstrapToken) {
    if (consumeBootstrapToken(bootstrapToken)) {
      const deviceField = params.device;
      const clientField = params.client;
      const deviceId = deviceField?.deviceId ?? `device-${randomBytes2(8).toString("hex")}`;
      const deviceName = clientField?.clientDisplayName ?? "ClawVibe device";
      const deviceToken = newToken();
      const a2 = readAccess();
      a2.approved[deviceId] = { device_id: deviceId, device_name: deviceName, token: deviceToken, approved_at: Date.now() };
      if (a2.bootstrapTokens?.[bootstrapToken]) {
        a2.bootstrapTokens[bootstrapToken].paired_device_id = deviceId;
        a2.bootstrapTokens[bootstrapToken].paired_device_name = deviceName;
      }
      writeAccess(a2);
      device = a2.approved[deviceId];
      process.stderr.write(`clawvibe-daemon: bootstrap paired device=${deviceId} name="${deviceName}"
`);
    } else {
      const a2 = readAccess();
      const bt = a2.bootstrapTokens?.[bootstrapToken];
      device = bt?.paired_device_id ? a2.approved[bt.paired_device_id] : undefined;
      if (device) {
        process.stderr.write(`clawvibe-daemon: bootstrap reused \u2192 re-auth device=${device.device_id}
`);
      } else {
        sendFrame(ws, {
          type: "res",
          id: req.id,
          ok: false,
          error: {
            message: "invalid or expired bootstrap token",
            details: {
              code: "PAIRING_REQUIRED",
              reason: "bootstrap-invalid",
              pauseReconnect: true,
              userMessage: "This pairing code has expired. Generate a new QR code and try again."
            }
          }
        });
        return;
      }
    }
  } else {
    device = tokenToDevice(token);
    process.stderr.write(`clawvibe-daemon: token auth \u2192 ${device ? "OK device=" + device.device_id : "REJECTED (token not in access.json)"}
`);
  }
  if (!device) {
    sendFrame(ws, {
      type: "res",
      id: req.id,
      ok: false,
      error: {
        message: "device not paired",
        details: {
          code: "PAIRING_REQUIRED",
          reason: "not-paired",
          pauseReconnect: true,
          userMessage: "Open ClawVibe settings and scan the QR code to pair this device."
        }
      }
    });
    return;
  }
  const timer = handshakeTimers.get(ws);
  if (timer) {
    clearTimeout(timer);
    handshakeTimers.delete(ws);
  }
  ws.data.device_id = device.device_id;
  ws.data.device_name = device.device_name;
  ws.data.authenticated = true;
  const existing = clients.get(device.device_id);
  if (existing) {
    for (const old of existing) {
      if (old !== ws) {
        process.stderr.write(`clawvibe-daemon: evicting stale socket for device=${device.device_id}
`);
        try {
          old.close(4000, "replaced by new connection");
        } catch {}
        existing.delete(old);
      }
    }
  }
  let set = clients.get(device.device_id);
  if (!set) {
    set = new Set;
    clients.set(device.device_id, set);
  }
  set.add(ws);
  const a = readAccess();
  if (a.approved[device.device_id]) {
    a.approved[device.device_id].last_seen_at = Date.now();
    writeAccess(a);
  }
  sendFrame(ws, {
    type: "res",
    id: req.id,
    ok: true,
    payload: {
      type: "hello_ok",
      protocol: 3,
      server: { name: "clawvibe", version: "0.0.1" },
      features: {},
      snapshot: {
        presence: [],
        health: { ok: true },
        stateVersion: { presence: 0, health: 0 },
        uptimeMs: Date.now() - startedAt,
        configPath: null,
        stateDir: null,
        sessionDefaults: null,
        authMode: null,
        updateAvailable: null
      },
      canvasHostUrl: null,
      auth: { deviceToken: device.token, role: "operator", scopes: ["operator.read", "operator.write"] },
      policy: { tickIntervalMs: TICK_INTERVAL_MS }
    }
  });
  process.stderr.write(`clawvibe-daemon: device authenticated id=${device.device_id} name="${device.device_name}"
`);
}
function parseSensoryTags(message) {
  let context, location, voiceData;
  const c = message.match(/\[CONTEXT:\s*(.+?)\]/);
  if (c)
    context = c[1];
  const l = message.match(/\[LOCATION:\s*(.+?)\]/);
  if (l)
    location = l[1];
  const v = message.match(/\[VOICE_DATA:\s*(.+?)\]/);
  if (v) {
    try {
      voiceData = JSON.parse(v[1]);
    } catch {}
  }
  return { context, location, voiceData };
}
function handleChatSend(ws, req) {
  const params = req.params ?? {};
  const sessionKey = params.sessionKey ?? `device:${ws.data.device_id}`;
  const message = params.message ?? "";
  const thinking = params.thinking;
  const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : undefined;
  const runId = nextMsgId();
  const deviceId = ws.data.device_id;
  activeRuns.set(sessionKey, { runId, ts: Date.now(), deviceId });
  const { context, location, voiceData } = parseSensoryTags(message);
  process.stderr.write(`clawvibe-daemon: chat.send runId=${runId} session=${sessionKey} text="${message.slice(0, 80)}"
`);
  const routed = routeInbound(sessionKey, runId, message, {
    device_id: deviceId,
    device_name: ws.data.device_name,
    conversation_id: sessionKey,
    message_id: runId,
    ts: new Date().toISOString(),
    context,
    location,
    voice_data: voiceData,
    thinking,
    timeout_ms: timeoutMs
  });
  sendFrame(ws, { type: "res", id: req.id, ok: true, payload: { runId } });
  if (!routed) {
    broadcastChatEvent(runId, sessionKey, "error", {
      errorMessage: "agent not connected",
      targetDeviceId: deviceId
    });
  }
}
function handleHealth(ws, req) {
  sendFrame(ws, { type: "res", id: req.id, ok: true, payload: { ok: true } });
}
function handleAgentsList(ws, req) {
  const agents = [...agentClients.values()];
  const defaultId = agents.length > 0 ? agents[0].agentId : "default";
  sendFrame(ws, {
    type: "res",
    id: req.id,
    ok: true,
    payload: {
      defaultId,
      mainKey: `agent:${defaultId}`,
      scope: "all",
      agents: agents.map((c) => ({
        id: c.agentId,
        name: c.identity.name,
        identity: { name: c.identity.name, emoji: c.identity.emoji },
        workspace: null,
        model: null
      }))
    }
  });
}
function handleAgentIdentityGet(ws, req) {
  const params = req.params ?? {};
  const agentId = params.agentId ?? "default";
  const c = agentClients.get(agentId);
  if (!c) {
    sendFrame(ws, { type: "res", id: req.id, ok: false, error: { message: `agent not found: ${agentId}` } });
    return;
  }
  sendFrame(ws, {
    type: "res",
    id: req.id,
    ok: true,
    payload: { agentId: c.agentId, name: c.identity.name, avatar: null, emoji: c.identity.emoji }
  });
}
function handleRPC(ws, req) {
  switch (req.method) {
    case "connect":
      return handleConnect(ws, req);
    case "chat.send":
      return handleChatSend(ws, req);
    case "health":
      return handleHealth(ws, req);
    case "agents.list":
      return handleAgentsList(ws, req);
    case "agent.identity.get":
      return handleAgentIdentityGet(ws, req);
    default:
      sendFrame(ws, { type: "res", id: req.id, ok: false, error: { message: `unknown method: ${req.method}` } });
  }
}
function isLegacyFrame(frame) {
  if (!frame || typeof frame !== "object")
    return false;
  const f = frame;
  return f.type === "chat.send" || f.type === "chat.abort" || f.type === "permission.reply" || f.type === "ping";
}
function handleLegacyFrame(ws, frame) {
  switch (frame.type) {
    case "ping":
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    case "chat.send": {
      const parts = [frame.text];
      if (frame.tags?.context)
        parts.push(`[CONTEXT: ${frame.tags.context}]`);
      if (frame.tags?.location)
        parts.push(`[LOCATION: ${frame.tags.location}]`);
      if (frame.tags?.voice_data)
        parts.push(`[VOICE_DATA: ${JSON.stringify(frame.tags.voice_data)}]`);
      const runId = frame.run_id;
      const sessionKey = frame.conversation_id || `device:${ws.data.device_id}`;
      activeRuns.set(sessionKey, { runId, ts: Date.now(), deviceId: ws.data.device_id });
      routeInbound(sessionKey, runId, parts.join(`
`), {
        device_id: ws.data.device_id,
        device_name: ws.data.device_name,
        conversation_id: sessionKey,
        message_id: runId,
        ts: new Date().toISOString(),
        context: frame.tags?.context,
        location: frame.tags?.location,
        voice_data: frame.tags?.voice_data
      });
      return;
    }
    case "chat.abort":
      process.stderr.write(`clawvibe-daemon: abort run_id=${frame.run_id}
`);
      return;
    case "permission.reply":
      return;
  }
}
function startHttpServer() {
  return Bun.serve({
    port: PORT,
    hostname: HOSTNAME,
    fetch(req, server) {
      const url = new URL(req.url);
      if ((url.pathname === "/" || url.pathname === "/health") && !req.headers.get("upgrade")) {
        return Response.json({ ok: true, server: "clawvibe", version: "0.0.1" });
      }
      if (url.pathname === "/agents" && req.method === "GET") {
        const agents = [...agentClients.values()].map((c) => ({
          id: c.agentId,
          name: c.identity.name,
          emoji: c.identity.emoji
        }));
        return Response.json(agents);
      }
      if (url.pathname === "/bootstrap-token" && req.method === "POST") {
        const { token, expiresAt } = newBootstrapToken();
        return Response.json({ bootstrapToken: token, expiresAt });
      }
      if (url.pathname.startsWith("/bootstrap-token/") && req.method === "GET") {
        const token = url.pathname.slice("/bootstrap-token/".length);
        const a = readAccess();
        const bt = a.bootstrapTokens?.[token];
        if (!bt)
          return Response.json({ error: "not found" }, { status: 404 });
        if (bt.expires_at < Date.now() && !bt.used)
          return Response.json({ status: "expired" });
        if (bt.used) {
          return Response.json({
            status: "paired",
            device_id: bt.paired_device_id ?? null,
            device_name: bt.paired_device_name ?? null
          });
        }
        return Response.json({ status: "pending" });
      }
      if (url.pathname === "/pair/request" && req.method === "POST") {
        return (async () => {
          let body = {};
          try {
            body = await req.json();
          } catch {}
          const deviceId = (body.device_id ?? "").trim();
          const deviceName = (body.device_name ?? "ClawVibe device").trim().slice(0, 64);
          if (!deviceId)
            return Response.json({ error: "device_id required" }, { status: 400 });
          const a = readAccess();
          if (a.dmPolicy === "disabled")
            return Response.json({ error: "pairing disabled" }, { status: 403 });
          for (const [code2, p] of Object.entries(a.pending))
            if (p.device_id === deviceId)
              delete a.pending[code2];
          const code = newPairCode();
          const now = Date.now();
          a.pending[code] = { device_id: deviceId, device_name: deviceName, created_at: now, expires_at: now + 10 * 60 * 1000 };
          writeAccess(a);
          process.stderr.write(`clawvibe-daemon: pair request from "${deviceName}" \u2014 code ${code} (run: /clawvibe:access pair ${code})
`);
          return Response.json({ pairing_code: code, expires_at: a.pending[code].expires_at });
        })();
      }
      if (url.pathname === "/pair/status" && req.method === "GET") {
        const deviceId = url.searchParams.get("device_id");
        if (!deviceId)
          return Response.json({ error: "device_id required" }, { status: 400 });
        drainApprovalSentinels();
        const a = readAccess();
        const approved = a.approved[deviceId];
        if (approved)
          return Response.json({ status: "approved", device_token: approved.token, device_name: approved.device_name });
        const hasPending = Object.values(a.pending).some((p) => p.device_id === deviceId);
        return Response.json({ status: hasPending ? "pending" : "unknown" });
      }
      if (url.pathname === "/" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (server.upgrade(req, { data: { device_id: "", device_name: "", authenticated: false } }))
          return;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/ws") {
        const token = url.searchParams.get("device_token") ?? "";
        const device = tokenToDevice(token);
        if (!device)
          return new Response("unauthorized", { status: 401 });
        if (server.upgrade(req, { data: { device_id: device.device_id, device_name: device.device_name, authenticated: true } }))
          return;
        return new Response("upgrade failed", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        if (ws.data.authenticated) {
          let set = clients.get(ws.data.device_id);
          if (!set) {
            set = new Set;
            clients.set(ws.data.device_id, set);
          }
          set.add(ws);
          process.stderr.write(`clawvibe-daemon: ws open (legacy) device=${ws.data.device_id}
`);
          const a = readAccess();
          if (a.approved[ws.data.device_id]) {
            a.approved[ws.data.device_id].last_seen_at = Date.now();
            writeAccess(a);
          }
        } else {
          const nonce = randomBytes2(16).toString("hex");
          sendFrame(ws, { type: "event", event: "connect.challenge", payload: { nonce }, seq: null, stateVersion: null });
          const timer = setTimeout(() => {
            handshakeTimers.delete(ws);
            if (!ws.data.authenticated && ws.readyState === 1) {
              process.stderr.write(`clawvibe-daemon: handshake timeout, closing socket
`);
              ws.close(4001, "handshake timeout");
            }
          }, HANDSHAKE_TIMEOUT_MS);
          handshakeTimers.set(ws, timer);
          process.stderr.write(`clawvibe-daemon: ws open (gateway) \u2014 sent challenge
`);
        }
      },
      close(ws, code) {
        const timer = handshakeTimers.get(ws);
        if (timer) {
          clearTimeout(timer);
          handshakeTimers.delete(ws);
        }
        if (ws.data.device_id) {
          const set = clients.get(ws.data.device_id);
          if (set) {
            set.delete(ws);
            if (set.size === 0)
              clients.delete(ws.data.device_id);
          }
        }
        process.stderr.write(`clawvibe-daemon: ws close device=${ws.data.device_id || "(unauthenticated)"} code=${code}
`);
      },
      message(ws, raw) {
        let parsed;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          process.stderr.write(`clawvibe-daemon: ws bad frame: ${String(raw).slice(0, 200)}
`);
          return;
        }
        const frame = parsed;
        if (frame.type === "req" && typeof frame.id === "string" && typeof frame.method === "string") {
          const req = frame;
          if (req.method !== "connect" && !ws.data.authenticated) {
            sendFrame(ws, {
              type: "res",
              id: req.id,
              ok: false,
              error: { message: "not authenticated", details: { code: "AUTH_TOKEN_MISSING", pauseReconnect: true } }
            });
            return;
          }
          process.stderr.write(`clawvibe-daemon: ws rpc method=${req.method} device=${ws.data.device_id || "(pending)"}
`);
          handleRPC(ws, req);
          return;
        }
        if (isLegacyFrame(parsed)) {
          if (!ws.data.authenticated)
            return;
          process.stderr.write(`clawvibe-daemon: ws legacy recv type=${frame.type} device=${ws.data.device_id}
`);
          handleLegacyFrame(ws, parsed);
          return;
        }
        process.stderr.write(`clawvibe-daemon: ws unknown frame type=${frame.type}
`);
      }
    }
  });
}
var httpServer;
try {
  httpServer = startHttpServer();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/EADDRINUSE|address already in use/i.test(msg)) {
    process.stderr.write(`clawvibe-daemon: port 8791 already in use; exiting
`);
    process.exit(0);
  }
  process.stderr.write(`clawvibe-daemon: failed to bind HTTP server: ${msg}
`);
  process.exit(1);
}
writeFileSync2(PID_FILE, String(process.pid));
process.stderr.write(`clawvibe-daemon: listening on http://${HOSTNAME}:${PORT} (ipc ${SOCK_FILE})
`);
var shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown)
    return;
  shuttingDown = true;
  process.stderr.write(`clawvibe-daemon: ${sig} \u2014 shutting down
`);
  try {
    httpServer.stop(true);
  } catch {}
  try {
    ipcServer.stop(true);
  } catch {}
  try {
    rmSync2(PID_FILE);
  } catch {}
  try {
    if (existsSync(SOCK_FILE))
      unlinkSync(SOCK_FILE);
  } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
