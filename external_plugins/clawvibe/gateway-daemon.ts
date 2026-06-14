#!/usr/bin/env bun
/**
 * ClawVibe shared gateway daemon.
 *
 * One long-lived process per machine. Owns:
 *   - the HTTP/WS server on 127.0.0.1:8791 (OpenClaw wire protocol → iOS app)
 *   - device pairing + access.json
 *   - a DYNAMIC registry of connected agent clients (channel-client.ts) over a
 *     Unix domain socket at $CLAWVIBE_STATE_DIR/gateway.sock
 *
 * Routing: chat.send carries sessionKey = "agent:<agentId>:clawvibe:app:<deviceId>".
 * The daemon parses <agentId>, forwards the message to that agent's client over IPC,
 * and routes the client's reply back to the originating device socket only.
 *
 * Singleton: PID file + Unix-socket bind + 8791 bind all guard against duplicates;
 * a redundant daemon exits(0) cleanly instead of zombie-ing on EADDRINUSE.
 */

import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync, rmSync, existsSync, unlinkSync } from 'fs'
import type { ServerWebSocket, Socket } from 'bun'

import {
  STATE_DIR, ACCESS_FILE, PID_FILE, SOCK_FILE, PORT, HOSTNAME,
  TICK_INTERVAL_MS, HANDSHAKE_TIMEOUT_MS, ACTIVE_RUN_TTL_MS,
  ensureStateDirs, readAccess, writeAccess, newPairCode, newToken,
  tokenToDevice, newBootstrapToken, consumeBootstrapToken, drainApprovalSentinels,
  type ApprovedDevice,
} from './shared/access.ts'
import {
  agentIdFromSessionKey, makeLineDecoder, encodeFrame,
  type RequestFrame, type ResponseFrame, type EventFrame, type WSData,
  type ChatState, type InboundMeta, type AgentIdentity, type IpcFrame,
} from './shared/protocol.ts'

const startedAt = Date.now()

// ── Singleton acquisition ─────────────────────────────────────────────────────

ensureStateDirs()

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

// (1) PID-file guard: if a live daemon already owns the PID file, we are redundant.
try {
  const existing = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
  if (existing !== process.pid && pidAlive(existing)) {
    process.stderr.write(`clawvibe-daemon: another daemon is live (pid=${existing}); exiting\n`)
    process.exit(0)
  }
} catch {}

// (2) Unix socket: if a live daemon is listening, exit; if it's a stale file, remove it.
async function ensureSocketFree(): Promise<void> {
  if (!existsSync(SOCK_FILE)) return
  try {
    const probe = await Bun.connect({
      unix: SOCK_FILE,
      socket: { data() {}, open() {}, close() {}, error() {} },
    })
    // A live daemon answered — we are redundant.
    probe.end()
    process.stderr.write('clawvibe-daemon: gateway.sock already owned by a live daemon; exiting\n')
    process.exit(0)
  } catch {
    // No listener — stale socket file. Remove it.
    try { unlinkSync(SOCK_FILE) } catch {}
  }
}
await ensureSocketFree()

process.on('unhandledRejection', err => {
  process.stderr.write(`clawvibe-daemon: unhandled rejection: ${err}\n`)
})

// ── Agent registry (IPC) ──────────────────────────────────────────────────────

type SockState = { decode: (chunk: Uint8Array) => void; agentId?: string }
type AgentConn = { agentId: string; identity: AgentIdentity; sock: Socket<SockState>; registeredAt: number }

const agentClients = new Map<string, AgentConn>() // keyed by agentId, insertion-ordered

function writeIpc(sock: Socket<SockState>, frame: IpcFrame): void {
  try { sock.write(encodeFrame(frame)) } catch (err) {
    process.stderr.write(`clawvibe-daemon: ipc write failed: ${err}\n`)
  }
}

/** Choose an agent when the sessionKey carries none (legacy / device:<id>). */
function pickFallbackAgentId(): string | null {
  if (agentClients.size === 0) return null
  const ids = [...agentClients.keys()]
  return ids[0] // first-registered = defaultId
}

function handleIpcFrame(sock: Socket<SockState>, frame: IpcFrame): void {
  switch (frame.t) {
    case 'register': {
      const { agentId, identity } = frame
      const prev = agentClients.get(agentId)
      if (prev && prev.sock !== sock) {
        // Last-writer-wins: a fresh client for the same agent replaces the stale one.
        process.stderr.write(`clawvibe-daemon: replacing stale client for agent=${agentId}\n`)
        try { prev.sock.end() } catch {}
      }
      sock.data.agentId = agentId
      agentClients.set(agentId, { agentId, identity, sock, registeredAt: Date.now() })
      writeIpc(sock, { v: 1, t: 'register.ok', agentId })
      process.stderr.write(`clawvibe-daemon: agent registered id=${agentId} name="${identity.name}"\n`)
      return
    }
    case 'reply': {
      const run = activeRuns.get(frame.sessionKey)
      if (!run) {
        process.stderr.write(`clawvibe-daemon: reply for unknown session ${frame.sessionKey}\n`)
        return
      }
      broadcastChatEvent(frame.runId || run.runId, frame.sessionKey, frame.state, {
        text: frame.text,
        errorMessage: frame.errorMessage,
        targetDeviceId: run.deviceId,
      })
      return
    }
    case 'edit': {
      const run = activeRuns.get(frame.sessionKey)
      if (!run) return
      broadcastChatEvent(frame.messageId, frame.sessionKey, 'final', {
        text: frame.text,
        targetDeviceId: run.deviceId,
      })
      return
    }
    case 'ping':
      return
  }
}

function onIpcClose(sock: Socket<SockState>): void {
  const agentId = sock.data?.agentId
  if (agentId && agentClients.get(agentId)?.sock === sock) {
    agentClients.delete(agentId)
    process.stderr.write(`clawvibe-daemon: agent deregistered id=${agentId}\n`)
  }
}

const ipcServer = Bun.listen<SockState>({
  unix: SOCK_FILE,
  socket: {
    open(sock) {
      sock.data = { decode: makeLineDecoder(f => handleIpcFrame(sock, f)) }
    },
    data(sock, data) { sock.data.decode(data) },
    close(sock) { onIpcClose(sock) },
    error(sock, err) {
      process.stderr.write(`clawvibe-daemon: ipc socket error: ${err}\n`)
      onIpcClose(sock)
    },
  },
})

// ── Device WS state ────────────────────────────────────────────────────────────

const clients = new Map<string, Set<ServerWebSocket<WSData>>>()
const handshakeTimers = new Map<ServerWebSocket<WSData>, Timer>()
// keyed by sessionKey; deviceId lets replies route back to the originating device
const activeRuns = new Map<string, { runId: string; ts: number; deviceId: string }>()
const runSeq = new Map<string, number>() // per-run chat event sequence

let msgSeq = 0
let eventSeq = 0
function nextMsgId(): string { return `m${Date.now()}-${++msgSeq}` }
function nextEventSeq(): number { return ++eventSeq }
function nextRunSeq(runId: string): number {
  const n = (runSeq.get(runId) ?? -1) + 1
  runSeq.set(runId, n)
  return n
}

function reapDeadSockets(): void {
  let reaped = 0
  for (const [deviceId, set] of clients) {
    for (const ws of set) if (ws.readyState !== 1) { set.delete(ws); reaped++ }
    if (set.size === 0) clients.delete(deviceId)
  }
  if (reaped > 0) process.stderr.write(`clawvibe-daemon: reaped ${reaped} dead socket(s)\n`)
}

function pruneActiveRuns(): void {
  const now = Date.now()
  for (const [k, v] of activeRuns) {
    if (now - v.ts > ACTIVE_RUN_TTL_MS) {
      activeRuns.delete(k)
      runSeq.delete(v.runId)
      // Don't leave the app spinning on a run that never produced a final.
      broadcastChatEvent(v.runId, k, 'aborted', { targetDeviceId: v.deviceId })
    }
  }
}

// ── Broadcast helpers ───────────────────────────────────────────────────────

function sendFrame(ws: ServerWebSocket<WSData>, frame: ResponseFrame | EventFrame): void {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(frame)) } catch (err) {
    process.stderr.write(`clawvibe-daemon: sendFrame failed: ${err}\n`)
  }
}

function broadcastEvent(frame: EventFrame, targetDeviceId?: string): void {
  let sent = 0, skipped = 0
  let payload: string
  try { payload = JSON.stringify(frame) } catch (err) {
    process.stderr.write(`clawvibe-daemon: broadcastEvent serialize failed: ${err}\n`)
    return
  }
  const send = (ws: ServerWebSocket<WSData>) => {
    if (!ws.data.authenticated) { skipped++; return }
    if (ws.readyState === 1) { ws.send(payload); sent++ } else { skipped++ }
  }
  if (targetDeviceId) clients.get(targetDeviceId)?.forEach(send)
  else for (const set of clients.values()) set.forEach(send)
  if (frame.event !== 'tick') {
    process.stderr.write(`clawvibe-daemon: broadcast event=${frame.event} sent=${sent} skipped=${skipped}\n`)
  }
}

function broadcastChatEvent(
  runId: string,
  sessionKey: string,
  state: ChatState,
  opts: { text?: string; errorMessage?: string; targetDeviceId?: string } = {},
): void {
  const payload: Record<string, unknown> = {
    runId,
    sessionKey,
    seq: nextRunSeq(runId),
    state,
  }
  if (opts.text !== undefined) {
    payload.message = {
      role: 'assistant',
      content: [{ type: 'text', text: opts.text }],
      timestamp: new Date().toISOString(),
    }
  }
  if (opts.errorMessage !== undefined) payload.errorMessage = opts.errorMessage
  if (state === 'final' || state === 'error' || state === 'aborted') runSeq.delete(runId)

  broadcastEvent({
    type: 'event',
    event: 'chat',
    payload,
    seq: nextEventSeq(),
    stateVersion: null,
  }, opts.targetDeviceId)
}

// 30s tick keepalive + dead socket reaper + activeRuns pruner
setInterval(() => {
  reapDeadSockets()
  pruneActiveRuns()
  broadcastEvent({ type: 'event', event: 'tick', payload: null, seq: nextEventSeq(), stateVersion: null })
}, TICK_INTERVAL_MS)

// ── Inbound routing (daemon → agent client) ──────────────────────────────────

function routeInbound(sessionKey: string, runId: string, text: string, meta: InboundMeta): boolean {
  const agentId = agentIdFromSessionKey(sessionKey) ?? pickFallbackAgentId()
  const conn = agentId ? agentClients.get(agentId) : undefined
  if (!conn) {
    process.stderr.write(`clawvibe-daemon: no agent for session=${sessionKey} (agentId=${agentId})\n`)
    return false
  }
  writeIpc(conn.sock, { v: 1, t: 'inbound', sessionKey, runId, text, meta })
  return true
}

// ── RPC handlers ────────────────────────────────────────────────────────────

function handleConnect(ws: ServerWebSocket<WSData>, req: RequestFrame): void {
  const params = req.params ?? {}
  const auth = params.auth as Record<string, unknown> | undefined
  const token = (auth?.token as string) ?? ''
  const bootstrapToken = (auth?.bootstrapToken as string) ?? ''

  let device: ApprovedDevice | undefined

  if (bootstrapToken) {
    if (!consumeBootstrapToken(bootstrapToken)) {
      sendFrame(ws, {
        type: 'res', id: req.id, ok: false,
        error: {
          message: 'invalid or expired bootstrap token',
          details: {
            code: 'PAIRING_REQUIRED', reason: 'bootstrap-invalid', pauseReconnect: true,
            userMessage: 'This pairing code has expired. Generate a new QR code and try again.',
          },
        },
      })
      return
    }
    const deviceField = params.device as Record<string, unknown> | undefined
    const clientField = params.client as Record<string, unknown> | undefined
    const deviceId = (deviceField?.deviceId as string) ?? `device-${randomBytes(8).toString('hex')}`
    const deviceName = (clientField?.clientDisplayName as string) ?? 'ClawVibe device'
    const deviceToken = newToken()
    const a = readAccess()
    a.approved[deviceId] = { device_id: deviceId, device_name: deviceName, token: deviceToken, approved_at: Date.now() }
    if (a.bootstrapTokens?.[bootstrapToken]) {
      a.bootstrapTokens[bootstrapToken].paired_device_id = deviceId
      a.bootstrapTokens[bootstrapToken].paired_device_name = deviceName
    }
    writeAccess(a)
    device = a.approved[deviceId]
    process.stderr.write(`clawvibe-daemon: bootstrap paired device=${deviceId} name="${deviceName}"\n`)
  } else {
    device = tokenToDevice(token)
  }

  if (!device) {
    sendFrame(ws, {
      type: 'res', id: req.id, ok: false,
      error: {
        message: 'device not paired',
        details: {
          code: 'PAIRING_REQUIRED', reason: 'not-paired', pauseReconnect: true,
          userMessage: 'Open ClawVibe settings and scan the QR code to pair this device.',
        },
      },
    })
    return
  }

  const timer = handshakeTimers.get(ws)
  if (timer) { clearTimeout(timer); handshakeTimers.delete(ws) }
  ws.data.device_id = device.device_id
  ws.data.device_name = device.device_name
  ws.data.authenticated = true

  // Evict stale sockets for this device
  const existing = clients.get(device.device_id)
  if (existing) {
    for (const old of existing) {
      if (old !== ws) {
        process.stderr.write(`clawvibe-daemon: evicting stale socket for device=${device.device_id}\n`)
        try { old.close(4000, 'replaced by new connection') } catch {}
        existing.delete(old)
      }
    }
  }

  let set = clients.get(device.device_id)
  if (!set) { set = new Set(); clients.set(device.device_id, set) }
  set.add(ws)

  const a = readAccess()
  if (a.approved[device.device_id]) {
    a.approved[device.device_id].last_seen_at = Date.now()
    writeAccess(a)
  }

  sendFrame(ws, {
    type: 'res', id: req.id, ok: true,
    payload: {
      type: 'hello_ok',
      protocol: 3,
      server: { name: 'clawvibe', version: '0.0.1' },
      features: {},
      snapshot: {
        presence: [], health: { ok: true }, stateVersion: { presence: 0, health: 0 },
        uptimeMs: Date.now() - startedAt, configPath: null, stateDir: null,
        sessionDefaults: null, authMode: null, updateAvailable: null,
      },
      canvasHostUrl: null,
      auth: { deviceToken: device.token, role: 'operator', scopes: ['operator.read', 'operator.write'] },
      policy: { tickIntervalMs: TICK_INTERVAL_MS },
    },
  })
  process.stderr.write(`clawvibe-daemon: device authenticated id=${device.device_id} name="${device.device_name}"\n`)
}

function parseSensoryTags(message: string): { context?: string; location?: string; voiceData?: unknown } {
  let context: string | undefined, location: string | undefined, voiceData: unknown
  const c = message.match(/\[CONTEXT:\s*(.+?)\]/); if (c) context = c[1]
  const l = message.match(/\[LOCATION:\s*(.+?)\]/); if (l) location = l[1]
  const v = message.match(/\[VOICE_DATA:\s*(.+?)\]/)
  if (v) { try { voiceData = JSON.parse(v[1]) } catch {} }
  return { context, location, voiceData }
}

function handleChatSend(ws: ServerWebSocket<WSData>, req: RequestFrame): void {
  const params = req.params ?? {}
  const sessionKey = (params.sessionKey as string) ?? `device:${ws.data.device_id}`
  const message = (params.message as string) ?? ''
  const thinking = params.thinking as string | undefined
  const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined

  const runId = nextMsgId()
  const deviceId = ws.data.device_id
  activeRuns.set(sessionKey, { runId, ts: Date.now(), deviceId })

  const { context, location, voiceData } = parseSensoryTags(message)
  process.stderr.write(`clawvibe-daemon: chat.send runId=${runId} session=${sessionKey} text="${message.slice(0, 80)}"\n`)

  const routed = routeInbound(sessionKey, runId, message, {
    device_id: deviceId,
    device_name: ws.data.device_name,
    conversation_id: sessionKey,
    message_id: runId,
    ts: new Date().toISOString(),
    context, location, voice_data: voiceData, thinking, timeout_ms: timeoutMs,
  })

  // Always return the runId so the app can correlate.
  sendFrame(ws, { type: 'res', id: req.id, ok: true, payload: { runId } })

  if (!routed) {
    broadcastChatEvent(runId, sessionKey, 'error', {
      errorMessage: 'agent not connected', targetDeviceId: deviceId,
    })
  }
}

function handleHealth(ws: ServerWebSocket<WSData>, req: RequestFrame): void {
  sendFrame(ws, { type: 'res', id: req.id, ok: true, payload: { ok: true } })
}

function handleAgentsList(ws: ServerWebSocket<WSData>, req: RequestFrame): void {
  const agents = [...agentClients.values()]
  const defaultId = agents.length > 0 ? agents[0].agentId : 'default'
  sendFrame(ws, {
    type: 'res', id: req.id, ok: true,
    payload: {
      defaultId,
      mainKey: `agent:${defaultId}`,
      scope: 'all',
      agents: agents.map(c => ({
        id: c.agentId,
        name: c.identity.name,
        identity: { name: c.identity.name, emoji: c.identity.emoji },
        workspace: null,
        model: null,
      })),
    },
  })
}

function handleAgentIdentityGet(ws: ServerWebSocket<WSData>, req: RequestFrame): void {
  const params = req.params ?? {}
  const agentId = (params.agentId as string) ?? 'default'
  const c = agentClients.get(agentId)
  if (!c) {
    sendFrame(ws, { type: 'res', id: req.id, ok: false, error: { message: `agent not found: ${agentId}` } })
    return
  }
  sendFrame(ws, {
    type: 'res', id: req.id, ok: true,
    payload: { agentId: c.agentId, name: c.identity.name, avatar: null, emoji: c.identity.emoji },
  })
}

function handleRPC(ws: ServerWebSocket<WSData>, req: RequestFrame): void {
  switch (req.method) {
    case 'connect': return handleConnect(ws, req)
    case 'chat.send': return handleChatSend(ws, req)
    case 'health': return handleHealth(ws, req)
    case 'agents.list': return handleAgentsList(ws, req)
    case 'agent.identity.get': return handleAgentIdentityGet(ws, req)
    default:
      sendFrame(ws, { type: 'res', id: req.id, ok: false, error: { message: `unknown method: ${req.method}` } })
  }
}

// ── Legacy frame support ──────────────────────────────────────────────────────

type LegacyInFrame =
  | { type: 'chat.send'; run_id: string; conversation_id: string; text: string; tags?: { context?: string; location?: string; voice_data?: unknown } }
  | { type: 'chat.abort'; run_id: string }
  | { type: 'permission.reply'; request_id: string; allowed: boolean }
  | { type: 'ping' }

function isLegacyFrame(frame: unknown): frame is LegacyInFrame {
  if (!frame || typeof frame !== 'object') return false
  const f = frame as Record<string, unknown>
  return f.type === 'chat.send' || f.type === 'chat.abort' || f.type === 'permission.reply' || f.type === 'ping'
}

function handleLegacyFrame(ws: ServerWebSocket<WSData>, frame: LegacyInFrame): void {
  switch (frame.type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }))
      return
    case 'chat.send': {
      const parts = [frame.text]
      if (frame.tags?.context) parts.push(`[CONTEXT: ${frame.tags.context}]`)
      if (frame.tags?.location) parts.push(`[LOCATION: ${frame.tags.location}]`)
      if (frame.tags?.voice_data) parts.push(`[VOICE_DATA: ${JSON.stringify(frame.tags.voice_data)}]`)
      const runId = frame.run_id
      // Legacy frames have no agent in the key — route via fallback.
      const sessionKey = frame.conversation_id || `device:${ws.data.device_id}`
      activeRuns.set(sessionKey, { runId, ts: Date.now(), deviceId: ws.data.device_id })
      routeInbound(sessionKey, runId, parts.join('\n'), {
        device_id: ws.data.device_id,
        device_name: ws.data.device_name,
        conversation_id: sessionKey,
        message_id: runId,
        ts: new Date().toISOString(),
        context: frame.tags?.context,
        location: frame.tags?.location,
        voice_data: frame.tags?.voice_data,
      })
      return
    }
    case 'chat.abort':
      process.stderr.write(`clawvibe-daemon: abort run_id=${frame.run_id}\n`)
      return
    case 'permission.reply':
      return
  }
}

// ── HTTP + WS server ─────────────────────────────────────────────────────────

function startHttpServer() {
  return Bun.serve<WSData>({
    port: PORT,
    hostname: HOSTNAME,
    fetch(req, server) {
      const url = new URL(req.url)

      if ((url.pathname === '/' || url.pathname === '/health') && !req.headers.get('upgrade')) {
        return Response.json({ ok: true, server: 'clawvibe', version: '0.0.1' })
      }

      // Agent discovery (HTTP) — served from the live registry.
      if (url.pathname === '/agents' && req.method === 'GET') {
        const agents = [...agentClients.values()].map(c => ({
          id: c.agentId, name: c.identity.name, emoji: c.identity.emoji,
        }))
        return Response.json(agents)
      }

      if (url.pathname === '/bootstrap-token' && req.method === 'POST') {
        const { token, expiresAt } = newBootstrapToken()
        return Response.json({ bootstrapToken: token, expiresAt })
      }

      if (url.pathname.startsWith('/bootstrap-token/') && req.method === 'GET') {
        const token = url.pathname.slice('/bootstrap-token/'.length)
        const a = readAccess()
        const bt = a.bootstrapTokens?.[token]
        if (!bt) return Response.json({ error: 'not found' }, { status: 404 })
        if (bt.expires_at < Date.now() && !bt.used) return Response.json({ status: 'expired' })
        if (bt.used) {
          return Response.json({
            status: 'paired',
            device_id: bt.paired_device_id ?? null,
            device_name: bt.paired_device_name ?? null,
          })
        }
        return Response.json({ status: 'pending' })
      }

      if (url.pathname === '/pair/request' && req.method === 'POST') {
        return (async () => {
          let body: { device_id?: string; device_name?: string } = {}
          try { body = await req.json() as typeof body } catch {}
          const deviceId = (body.device_id ?? '').trim()
          const deviceName = (body.device_name ?? 'ClawVibe device').trim().slice(0, 64)
          if (!deviceId) return Response.json({ error: 'device_id required' }, { status: 400 })
          const a = readAccess()
          if (a.dmPolicy === 'disabled') return Response.json({ error: 'pairing disabled' }, { status: 403 })
          for (const [code, p] of Object.entries(a.pending)) if (p.device_id === deviceId) delete a.pending[code]
          const code = newPairCode()
          const now = Date.now()
          a.pending[code] = { device_id: deviceId, device_name: deviceName, created_at: now, expires_at: now + 10 * 60 * 1000 }
          writeAccess(a)
          process.stderr.write(`clawvibe-daemon: pair request from "${deviceName}" — code ${code} (run: /clawvibe:access pair ${code})\n`)
          return Response.json({ pairing_code: code, expires_at: a.pending[code].expires_at })
        })()
      }

      if (url.pathname === '/pair/status' && req.method === 'GET') {
        const deviceId = url.searchParams.get('device_id')
        if (!deviceId) return Response.json({ error: 'device_id required' }, { status: 400 })
        drainApprovalSentinels()
        const a = readAccess()
        const approved = a.approved[deviceId]
        if (approved) return Response.json({ status: 'approved', device_token: approved.token, device_name: approved.device_name })
        const hasPending = Object.values(a.pending).some(p => p.device_id === deviceId)
        return Response.json({ status: hasPending ? 'pending' : 'unknown' })
      }

      if (url.pathname === '/' && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        if (server.upgrade(req, { data: { device_id: '', device_name: '', authenticated: false } })) return
        return new Response('upgrade failed', { status: 400 })
      }

      if (url.pathname === '/ws') {
        const token = url.searchParams.get('device_token') ?? ''
        const device = tokenToDevice(token)
        if (!device) return new Response('unauthorized', { status: 401 })
        if (server.upgrade(req, { data: { device_id: device.device_id, device_name: device.device_name, authenticated: true } })) return
        return new Response('upgrade failed', { status: 400 })
      }

      return new Response('not found', { status: 404 })
    },

    websocket: {
      open(ws) {
        if (ws.data.authenticated) {
          let set = clients.get(ws.data.device_id)
          if (!set) { set = new Set(); clients.set(ws.data.device_id, set) }
          set.add(ws)
          process.stderr.write(`clawvibe-daemon: ws open (legacy) device=${ws.data.device_id}\n`)
          const a = readAccess()
          if (a.approved[ws.data.device_id]) { a.approved[ws.data.device_id].last_seen_at = Date.now(); writeAccess(a) }
        } else {
          const nonce = randomBytes(16).toString('hex')
          sendFrame(ws, { type: 'event', event: 'connect.challenge', payload: { nonce }, seq: null, stateVersion: null })
          const timer = setTimeout(() => {
            handshakeTimers.delete(ws)
            if (!ws.data.authenticated && ws.readyState === 1) {
              process.stderr.write('clawvibe-daemon: handshake timeout, closing socket\n')
              ws.close(4001, 'handshake timeout')
            }
          }, HANDSHAKE_TIMEOUT_MS)
          handshakeTimers.set(ws, timer)
          process.stderr.write('clawvibe-daemon: ws open (gateway) — sent challenge\n')
        }
      },
      close(ws, code) {
        const timer = handshakeTimers.get(ws)
        if (timer) { clearTimeout(timer); handshakeTimers.delete(ws) }
        if (ws.data.device_id) {
          const set = clients.get(ws.data.device_id)
          if (set) { set.delete(ws); if (set.size === 0) clients.delete(ws.data.device_id) }
        }
        process.stderr.write(`clawvibe-daemon: ws close device=${ws.data.device_id || '(unauthenticated)'} code=${code}\n`)
      },
      message(ws, raw) {
        let parsed: unknown
        try { parsed = JSON.parse(String(raw)) } catch {
          process.stderr.write(`clawvibe-daemon: ws bad frame: ${String(raw).slice(0, 200)}\n`)
          return
        }
        const frame = parsed as Record<string, unknown>
        if (frame.type === 'req' && typeof frame.id === 'string' && typeof frame.method === 'string') {
          const req = frame as unknown as RequestFrame
          if (req.method !== 'connect' && !ws.data.authenticated) {
            sendFrame(ws, {
              type: 'res', id: req.id, ok: false,
              error: { message: 'not authenticated', details: { code: 'AUTH_TOKEN_MISSING', pauseReconnect: true } },
            })
            return
          }
          process.stderr.write(`clawvibe-daemon: ws rpc method=${req.method} device=${ws.data.device_id || '(pending)'}\n`)
          handleRPC(ws, req)
          return
        }
        if (isLegacyFrame(parsed)) {
          if (!ws.data.authenticated) return
          process.stderr.write(`clawvibe-daemon: ws legacy recv type=${frame.type} device=${ws.data.device_id}\n`)
          handleLegacyFrame(ws, parsed)
          return
        }
        process.stderr.write(`clawvibe-daemon: ws unknown frame type=${frame.type}\n`)
      },
    },
  })
}

// (3) Bind 8791 — exit(0) cleanly if another daemon already owns it (no zombie).
let httpServer: ReturnType<typeof startHttpServer>
try {
  httpServer = startHttpServer()
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (/EADDRINUSE|address already in use/i.test(msg)) {
    process.stderr.write('clawvibe-daemon: port 8791 already in use; exiting\n')
    process.exit(0)
  }
  process.stderr.write(`clawvibe-daemon: failed to bind HTTP server: ${msg}\n`)
  process.exit(1)
}

// (4) Claim the PID file now that we own both the socket and the port.
writeFileSync(PID_FILE, String(process.pid))
process.stderr.write(`clawvibe-daemon: listening on http://${HOSTNAME}:${PORT} (ipc ${SOCK_FILE})\n`)

// ── Shutdown ──────────────────────────────────────────────────────────────────

let shuttingDown = false
function shutdown(sig: string): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write(`clawvibe-daemon: ${sig} — shutting down\n`)
  try { httpServer.stop(true) } catch {}
  try { ipcServer.stop(true) } catch {}
  try { rmSync(PID_FILE) } catch {}
  try { if (existsSync(SOCK_FILE)) unlinkSync(SOCK_FILE) } catch {}
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
