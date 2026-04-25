#!/usr/bin/env bun
/**
 * ClawVibe mobile channel for Claude Code.
 *
 * Stdio MCP server + embedded Bun HTTP/WS server. Lets a paired iOS device
 * (the public ClawVibe app) talk to this Claude Code session over a
 * long-lived WebSocket. Inbound device messages land as
 * `notifications/claude/channel` notifications; the agent replies via the
 * `reply` tool, which broadcasts to connected device(s).
 *
 * Wire protocol: speaks the OpenClaw gateway protocol so the iOS app's
 * GatewayChannelActor handles connection lifecycle, reconnection, keepalive,
 * and error classification identically for both OpenClaw and ClawCode backends.
 *
 * State in $CLAWVIBE_STATE_DIR (default ~/.claude/channels/clawvibe/):
 *   access.json            — dmPolicy, pending pairs, approved devices, tokens
 *   approved/<device_id>   — sentinel file, signals pairing approved
 *   server.pid             — single-instance guard
 *
 * Transport is assumed to be either localhost (dev) or reached through a
 * user-managed reverse proxy / Tailscale serve. We do NOT terminate TLS
 * ourselves — pair-code + device-token is the auth layer.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ServerWebSocket } from 'bun'

// ── Paths + config ───────────────────────────────────────────────────────────

const STATE_DIR = process.env.CLAWVIBE_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'clawvibe')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')
const PID_FILE = join(STATE_DIR, 'server.pid')
const PORT = Number(process.env.CLAWVIBE_PORT ?? 8791)
const HOSTNAME = process.env.CLAWVIBE_HOSTNAME ?? '127.0.0.1'
const TICK_INTERVAL_MS = 30_000
const startedAt = Date.now()

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
mkdirSync(APPROVED_DIR, { recursive: true, mode: 0o700 })

// Stale-PID cleanup — same trick telegram uses, for port reuse after crashes.
try {
  const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
  if (stale > 1 && stale !== process.pid) {
    process.kill(stale, 0) // throws if gone
    process.stderr.write(`clawvibe: replacing stale pid=${stale}\n`)
    process.kill(stale, 'SIGTERM')
  }
} catch {}
writeFileSync(PID_FILE, String(process.pid))

process.on('unhandledRejection', err => {
  process.stderr.write(`clawvibe: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`clawvibe: uncaught exception: ${err}\n`)
})

// ── Access state ─────────────────────────────────────────────────────────────

type PendingPair = {
  device_id: string
  device_name: string
  created_at: number
  expires_at: number
}

type ApprovedDevice = {
  device_id: string
  device_name: string
  token: string
  approved_at: number
  last_seen_at?: number
}

type BootstrapToken = {
  created_at: number
  expires_at: number
  used: boolean
}

type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  approved: Record<string, ApprovedDevice>   // keyed by device_id
  pending: Record<string, PendingPair>        // keyed by pairing code (5 letters)
  bootstrapTokens?: Record<string, BootstrapToken>
}

function defaultAccess(): Access {
  return { dmPolicy: 'pairing', approved: {}, pending: {} }
}

function readAccess(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const a = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: a.dmPolicy ?? 'pairing',
      approved: a.approved ?? {},
      pending: a.pending ?? {},
    }
  } catch {
    return defaultAccess()
  }
}

function writeAccess(a: Access): void {
  writeFileSync(ACCESS_FILE, JSON.stringify(a, null, 2))
  try { chmodSync(ACCESS_FILE, 0o600) } catch {}
}

function newPairCode(): string {
  const alpha = 'ABCDEFGHIJKMNOPQRSTUVWXYZ'
  let s = ''
  for (const b of randomBytes(5)) s += alpha[b % alpha.length]
  return s
}

function newToken(): string {
  return randomBytes(32).toString('base64url')
}

function tokenToDevice(token: string): ApprovedDevice | undefined {
  const a = readAccess()
  for (const d of Object.values(a.approved)) if (d.token === token) return d
  return undefined
}

function newBootstrapToken(): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = Date.now() + 10 * 60 * 1000
  const a = readAccess()
  if (!a.bootstrapTokens) a.bootstrapTokens = {}
  // Prune expired tokens
  for (const [k, v] of Object.entries(a.bootstrapTokens)) {
    if (v.expires_at < Date.now()) delete a.bootstrapTokens[k]
  }
  a.bootstrapTokens[token] = { created_at: Date.now(), expires_at: expiresAt, used: false }
  writeAccess(a)
  return { token, expiresAt }
}

function validateBootstrapToken(token: string): boolean {
  const a = readAccess()
  const bt = a.bootstrapTokens?.[token]
  if (!bt || bt.used || bt.expires_at < Date.now()) return false
  return true
}

function consumeBootstrapToken(token: string): boolean {
  const a = readAccess()
  const bt = a.bootstrapTokens?.[token]
  if (!bt || bt.used || bt.expires_at < Date.now()) return false
  bt.used = true
  writeAccess(a)
  return true
}

// ── MCP server ───────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'clawvibe', version: '0.0.1' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions:
      `ClawVibe mobile channel. Device users cannot see your transcript — reach them only via the \`reply\` tool.\n` +
      `\n` +
      `Inbound device messages arrive as <channel source="clawvibe" conversation_id="..." message_id="..."> … </channel>.\n` +
      `The device may append sensory tags: [CONTEXT: ...], [LOCATION: ...], [VOICE_DATA: ...]. Treat them as ambient awareness.\n` +
      `\n` +
      `Format directives for TTS-aware clients:\n` +
      `  [SPEAK] <text>      — force spoken output\n` +
      `  [TEXT]  <text>      — text-only, no TTS\n` +
      `  ---                 — segment separator (new chat bubble)\n` +
      `\n` +
      `Server URL: http://${HOSTNAME}:${PORT} (expose via Tailscale / reverse proxy).`,
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Send an assistant message to the paired ClawVibe device(s). Use conversation_id from the inbound channel tag to reply in the same thread. Text may include [SPEAK]/[TEXT]/--- directives.',
      inputSchema: {
        type: 'object',
        properties: {
          conversation_id: { type: 'string' },
          text: { type: 'string' },
          reply_to: { type: 'string' },
        },
        required: ['text'],
      },
    },
    {
      name: 'edit_message',
      description: 'Edit a previously sent assistant message.',
      inputSchema: {
        type: 'object',
        properties: {
          conversation_id: { type: 'string' },
          message_id: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['message_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'reply': {
        const conversationId = (args.conversation_id as string | undefined) ?? 'default'
        const text = args.text as string
        const replyTo = args.reply_to as string | undefined
        const id = nextMsgId()
        // Find the active runId for this conversation to correlate the reply
        const runId = activeRuns.get(conversationId) ?? id
        broadcastChatEvent(runId, conversationId, 'final', text)
        activeRuns.delete(conversationId)
        return { content: [{ type: 'text', text: `sent (${id})` }] }
      }
      case 'edit_message': {
        const messageId = args.message_id as string
        const conversationId = (args.conversation_id as string | undefined) ?? 'default'
        const text = args.text as string
        broadcastChatEvent(messageId, conversationId, 'final', text)
        return { content: [{ type: 'text', text: 'ok' }] }
      }
      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
          isError: true,
        }
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `${req.params.name}: ${err instanceof Error ? err.message : err}` }],
      isError: true,
    }
  }
})

// ── Inbound delivery ─────────────────────────────────────────────────────────

type InboundMeta = {
  device_id: string
  device_name: string
  conversation_id: string
  message_id: string
  ts: string
  context?: string
  location?: string
  voice_data?: unknown
}

function deliverInbound(text: string, meta: InboundMeta): void {
  void mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text,
      meta: {
        source: 'clawvibe',
        chat_id: meta.conversation_id,
        message_id: meta.message_id,
        user: meta.device_name,
        ts: meta.ts,
        device_id: meta.device_id,
        conversation_id: meta.conversation_id,
        ...(meta.context ? { context: meta.context } : {}),
        ...(meta.location ? { location: meta.location } : {}),
        ...(meta.voice_data ? { voice_data: meta.voice_data } : {}),
      },
    },
  })
}

// ── Gateway protocol types ──────────────────────────────────────────────────

type RequestFrame = {
  type: 'req'
  id: string
  method: string
  params?: Record<string, unknown>
}

type ResponseFrame = {
  type: 'res'
  id: string
  ok: boolean
  payload?: unknown
  error?: { message: string; details?: Record<string, unknown> }
}

type EventFrame = {
  type: 'event'
  event: string
  payload: unknown
  seq: number | null
  stateVersion: unknown
}

// ── WS state ────────────────────────────────────────────────────────────────

type WSData = {
  device_id: string
  device_name: string
  authenticated: boolean
  sessionKey?: string
}

const clients = new Map<string, Set<ServerWebSocket<WSData>>>()
// Track active run_id per conversation for reply correlation
const activeRuns = new Map<string, string>()

let msgSeq = 0
let eventSeq = 0
function nextMsgId(): string {
  return `m${Date.now()}-${++msgSeq}`
}
function nextEventSeq(): number {
  return ++eventSeq
}

// ── Broadcast helpers ───────────────────────────────────────────────────────

function sendFrame(ws: ServerWebSocket<WSData>, frame: ResponseFrame | EventFrame): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(frame))
}

function broadcastEvent(frame: EventFrame, targetDeviceId?: string): void {
  let sent = 0, skipped = 0
  const send = (ws: ServerWebSocket<WSData>) => {
    if (!ws.data.authenticated) { skipped++; return }
    if (ws.readyState === 1) { ws.send(JSON.stringify(frame)); sent++ }
    else { skipped++ }
  }
  if (targetDeviceId) clients.get(targetDeviceId)?.forEach(send)
  else for (const set of clients.values()) set.forEach(send)
  if (frame.event !== 'tick') {
    process.stderr.write(`clawvibe: broadcast event=${frame.event} sent=${sent} skipped=${skipped}\n`)
  }
}

function broadcastChatEvent(
  runId: string,
  sessionKey: string,
  state: 'delta' | 'final' | 'error' | 'aborted',
  text?: string,
  errorMessage?: string,
): void {
  const payload: Record<string, unknown> = {
    runId,
    sessionKey,
    seq: 0,
    state,
  }
  if (text !== undefined) {
    payload.message = {
      role: 'assistant',
      content: [{ type: 'text', text }],
      timestamp: new Date().toISOString(),
    }
  }
  if (errorMessage !== undefined) {
    payload.errorMessage = errorMessage
  }
  broadcastEvent({
    type: 'event',
    event: 'chat',
    payload,
    seq: nextEventSeq(),
    stateVersion: null,
  })
}

// 30s tick keepalive in OpenClaw EventFrame format
setInterval(() => {
  broadcastEvent({
    type: 'event',
    event: 'tick',
    payload: null,
    seq: nextEventSeq(),
    stateVersion: null,
  })
}, TICK_INTERVAL_MS)

// ── RPC handlers ────────────────────────────────────────────────────────────

function handleConnect(ws: ServerWebSocket<WSData>, req: RequestFrame): void {
  const params = req.params ?? {}
  const auth = params.auth as Record<string, unknown> | undefined
  const token = (auth?.token as string) ?? ''
  const bootstrapToken = (auth?.bootstrapToken as string) ?? ''

  let device: ApprovedDevice | undefined

  if (bootstrapToken) {
    // Bootstrap token auth: auto-approve this device and issue a device token
    if (!consumeBootstrapToken(bootstrapToken)) {
      sendFrame(ws, {
        type: 'res',
        id: req.id,
        ok: false,
        error: {
          message: 'invalid or expired bootstrap token',
          details: {
            code: 'PAIRING_REQUIRED',
            reason: 'bootstrap-invalid',
            pauseReconnect: true,
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
    a.approved[deviceId] = {
      device_id: deviceId,
      device_name: deviceName,
      token: deviceToken,
      approved_at: Date.now(),
    }
    writeAccess(a)
    device = a.approved[deviceId]
    process.stderr.write(`clawvibe: bootstrap paired device=${deviceId} name="${deviceName}"\n`)
  } else {
    device = tokenToDevice(token)
  }

  if (!device) {
    sendFrame(ws, {
      type: 'res',
      id: req.id,
      ok: false,
      error: {
        message: 'device not paired',
        details: {
          code: 'PAIRING_REQUIRED',
          reason: 'not-paired',
          pauseReconnect: true,
          userMessage: 'Open ClawVibe settings and scan the QR code to pair this device.',
        },
      },
    })
    return
  }

  // Authenticate the socket
  ws.data.device_id = device.device_id
  ws.data.device_name = device.device_name
  ws.data.authenticated = true

  // Register in clients map
  let set = clients.get(device.device_id)
  if (!set) { set = new Set(); clients.set(device.device_id, set) }
  set.add(ws)

  // Touch last_seen
  const a = readAccess()
  if (a.approved[device.device_id]) {
    a.approved[device.device_id].last_seen_at = Date.now()
    writeAccess(a)
  }

  const helloOk: ResponseFrame = {
    type: 'res',
    id: req.id,
    ok: true,
    payload: {
      type: 'hello_ok',
      protocol: 3,
      server: { name: 'clawvibe', version: '0.0.1' },
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
        updateAvailable: null,
      },
      canvasHostUrl: null,
      auth: {
        deviceToken: device.token,
        role: 'operator',
        scopes: ['operator.read', 'operator.write'],
      },
      policy: { tickIntervalMs: TICK_INTERVAL_MS },
    },
  }
  sendFrame(ws, helloOk)
  process.stderr.write(`clawvibe: device authenticated id=${device.device_id} name="${device.device_name}"\n`)
}

function handleChatSend(ws: ServerWebSocket<WSData>, req: RequestFrame): void {
  const params = req.params ?? {}
  const sessionKey = (params.sessionKey as string) ?? `device:${ws.data.device_id}`
  const message = (params.message as string) ?? ''
  const idempotencyKey = (params.idempotencyKey as string) ?? ''

  const runId = nextMsgId()
  const conversationId = sessionKey

  // Track for reply correlation
  activeRuns.set(conversationId, runId)

  // Parse sensory tags from the message (iOS embeds them inline)
  let context: string | undefined
  let location: string | undefined
  let voiceData: unknown | undefined

  const contextMatch = message.match(/\[CONTEXT:\s*(.+?)\]/)
  if (contextMatch) context = contextMatch[1]
  const locationMatch = message.match(/\[LOCATION:\s*(.+?)\]/)
  if (locationMatch) location = locationMatch[1]
  const voiceDataMatch = message.match(/\[VOICE_DATA:\s*(.+?)\]/)
  if (voiceDataMatch) {
    try { voiceData = JSON.parse(voiceDataMatch[1]) } catch {}
  }

  process.stderr.write(`clawvibe: chat.send runId=${runId} session=${sessionKey} text="${message.slice(0, 80)}"\n`)

  deliverInbound(message, {
    device_id: ws.data.device_id,
    device_name: ws.data.device_name,
    conversation_id: conversationId,
    message_id: runId,
    ts: new Date().toISOString(),
    context,
    location,
    voice_data: voiceData,
  })

  // Respond with the runId so iOS can correlate events
  const res: ResponseFrame = {
    type: 'res',
    id: req.id,
    ok: true,
    payload: { runId },
  }
  sendFrame(ws, res)
}

function handleHealth(ws: ServerWebSocket<WSData>, req: RequestFrame): void {
  sendFrame(ws, { type: 'res', id: req.id, ok: true, payload: { ok: true } })
}

function handleAgentsList(ws: ServerWebSocket<WSData>, req: RequestFrame): void {
  let agents: Array<{ id: string; name: string; emoji?: string }> = []
  try {
    const raw = readFileSync(join(STATE_DIR, 'agents.json'), 'utf8')
    agents = JSON.parse(raw) as typeof agents
  } catch {}

  const defaultId = agents.length > 0 ? agents[0].id : 'default'
  const result = {
    defaultId,
    mainKey: `agent:${defaultId}`,
    scope: 'all',
    agents: agents.map(a => ({
      id: a.id,
      name: a.name,
      identity: { name: a.name, emoji: a.emoji ?? null },
      workspace: null,
      model: null,
    })),
  }
  sendFrame(ws, { type: 'res', id: req.id, ok: true, payload: result })
}

function handleRPC(ws: ServerWebSocket<WSData>, req: RequestFrame): void {
  switch (req.method) {
    case 'connect':
      handleConnect(ws, req)
      return
    case 'chat.send':
      handleChatSend(ws, req)
      return
    case 'health':
      handleHealth(ws, req)
      return
    case 'agents.list':
      handleAgentsList(ws, req)
      return
    default:
      sendFrame(ws, {
        type: 'res',
        id: req.id,
        ok: false,
        error: { message: `unknown method: ${req.method}` },
      })
  }
}

// ── Legacy protocol support ─────────────────────────────────────────────────
// Backward compat: the old ClawVibeChannelConnector uses a simpler frame format.

type LegacyInFrame =
  | {
      type: 'chat.send'
      run_id: string
      conversation_id: string
      text: string
      tags?: { context?: string; location?: string; voice_data?: unknown }
    }
  | { type: 'chat.abort'; run_id: string }
  | { type: 'permission.reply'; request_id: string; allowed: boolean }
  | { type: 'ping' }

function isLegacyFrame(frame: unknown): frame is LegacyInFrame {
  if (!frame || typeof frame !== 'object') return false
  const f = frame as Record<string, unknown>
  return f.type === 'chat.send' || f.type === 'chat.abort' ||
         f.type === 'permission.reply' || f.type === 'ping'
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
      const conversationId = frame.conversation_id || 'default'
      activeRuns.set(conversationId, runId)
      deliverInbound(parts.join('\n'), {
        device_id: ws.data.device_id,
        device_name: ws.data.device_name,
        conversation_id: conversationId,
        message_id: runId,
        ts: new Date().toISOString(),
        context: frame.tags?.context,
        location: frame.tags?.location,
        voice_data: frame.tags?.voice_data,
      })
      return
    }
    case 'chat.abort':
      process.stderr.write(`clawvibe: abort run_id=${frame.run_id}\n`)
      return
    case 'permission.reply':
      return
  }
}

// ── HTTP + WS server ─────────────────────────────────────────────────────────

Bun.serve<WSData>({
  port: PORT,
  hostname: HOSTNAME,
  fetch(req, server) {
    const url = new URL(req.url)

    // Health
    if ((url.pathname === '/' || url.pathname === '/health') && !req.headers.get('upgrade')) {
      return Response.json({ ok: true, server: 'clawvibe', version: '0.0.1' })
    }

    // Agent discovery — iOS app fetches this to build the agent picker.
    if (url.pathname === '/agents' && req.method === 'GET') {
      try {
        const raw = readFileSync(join(STATE_DIR, 'agents.json'), 'utf8')
        return Response.json(JSON.parse(raw))
      } catch {
        return Response.json([])
      }
    }

    // Bootstrap token: generate a one-time token for QR-based pairing
    if (url.pathname === '/bootstrap-token' && req.method === 'POST') {
      const { token, expiresAt } = newBootstrapToken()
      return Response.json({ bootstrapToken: token, expiresAt })
    }

    // Pairing: request a code
    if (url.pathname === '/pair/request' && req.method === 'POST') {
      return (async () => {
        let body: { device_id?: string; device_name?: string } = {}
        try { body = await req.json() as typeof body } catch {}
        const deviceId = (body.device_id ?? '').trim()
        const deviceName = (body.device_name ?? 'ClawVibe device').trim().slice(0, 64)
        if (!deviceId) return Response.json({ error: 'device_id required' }, { status: 400 })

        const a = readAccess()
        if (a.dmPolicy === 'disabled') {
          return Response.json({ error: 'pairing disabled' }, { status: 403 })
        }
        for (const [code, p] of Object.entries(a.pending)) {
          if (p.device_id === deviceId) delete a.pending[code]
        }
        const code = newPairCode()
        const now = Date.now()
        a.pending[code] = {
          device_id: deviceId,
          device_name: deviceName,
          created_at: now,
          expires_at: now + 10 * 60 * 1000,
        }
        writeAccess(a)

        process.stderr.write(
          `clawvibe: pair request from "${deviceName}" — code ${code} ` +
          `(run: /clawvibe:access pair ${code})\n`,
        )
        return Response.json({ pairing_code: code, expires_at: a.pending[code].expires_at })
      })()
    }

    // Pairing: poll status (iOS polls this until approved)
    if (url.pathname === '/pair/status' && req.method === 'GET') {
      const deviceId = url.searchParams.get('device_id')
      if (!deviceId) return Response.json({ error: 'device_id required' }, { status: 400 })
      drainApprovalSentinels()
      const a = readAccess()
      const approved = a.approved[deviceId]
      if (approved) {
        return Response.json({
          status: 'approved',
          device_token: approved.token,
          device_name: approved.device_name,
        })
      }
      const hasPending = Object.values(a.pending).some(p => p.device_id === deviceId)
      return Response.json({ status: hasPending ? 'pending' : 'unknown' })
    }

    // Gateway protocol: WebSocket upgrade at root path (new)
    if (url.pathname === '/' && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      if (server.upgrade(req, { data: { device_id: '', device_name: '', authenticated: false } })) return
      return new Response('upgrade failed', { status: 400 })
    }

    // Legacy: WebSocket upgrade at /ws with token in query (backward compat)
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
        // Legacy path: already authenticated via /ws?device_token=X
        let set = clients.get(ws.data.device_id)
        if (!set) { set = new Set(); clients.set(ws.data.device_id, set) }
        set.add(ws)
        process.stderr.write(`clawvibe: ws open (legacy) device=${ws.data.device_id}\n`)
        const a = readAccess()
        if (a.approved[ws.data.device_id]) {
          a.approved[ws.data.device_id].last_seen_at = Date.now()
          writeAccess(a)
        }
      } else {
        // Gateway protocol: send connect.challenge immediately
        const nonce = randomBytes(16).toString('hex')
        const challenge: EventFrame = {
          type: 'event',
          event: 'connect.challenge',
          payload: { nonce },
          seq: null,
          stateVersion: null,
        }
        sendFrame(ws, challenge)
        process.stderr.write(`clawvibe: ws open (gateway) — sent challenge\n`)
      }
    },
    close(ws, code, reason) {
      if (ws.data.device_id) {
        clients.get(ws.data.device_id)?.delete(ws)
      }
      process.stderr.write(`clawvibe: ws close device=${ws.data.device_id || '(unauthenticated)'} code=${code}\n`)
    },
    message(ws, raw) {
      let parsed: unknown
      try { parsed = JSON.parse(String(raw)) } catch {
        process.stderr.write(`clawvibe: ws bad frame: ${String(raw).slice(0, 200)}\n`)
        return
      }

      const frame = parsed as Record<string, unknown>

      // Gateway protocol: RequestFrame has type="req"
      if (frame.type === 'req' && typeof frame.id === 'string' && typeof frame.method === 'string') {
        const req = frame as unknown as RequestFrame
        // Allow connect before authentication; everything else requires it
        if (req.method !== 'connect' && !ws.data.authenticated) {
          sendFrame(ws, {
            type: 'res',
            id: req.id,
            ok: false,
            error: {
              message: 'not authenticated',
              details: { code: 'AUTH_TOKEN_MISSING', pauseReconnect: true },
            },
          })
          return
        }
        process.stderr.write(`clawvibe: ws rpc method=${req.method} device=${ws.data.device_id || '(pending)'}\n`)
        handleRPC(ws, req)
        return
      }

      // Legacy protocol: simple typed frames (chat.send, ping, etc.)
      if (isLegacyFrame(parsed)) {
        if (!ws.data.authenticated) return
        process.stderr.write(`clawvibe: ws legacy recv type=${frame.type} device=${ws.data.device_id}\n`)
        handleLegacyFrame(ws, parsed)
        return
      }

      process.stderr.write(`clawvibe: ws unknown frame type=${frame.type}\n`)
    },
  },
})

process.stderr.write(`clawvibe: listening on http://${HOSTNAME}:${PORT}\n`)

// ── Approval sentinels ───────────────────────────────────────────────────────

function drainApprovalSentinels(): void {
  let names: string[] = []
  try { names = readdirSync(APPROVED_DIR) } catch { return }
  if (names.length === 0) return
  const a = readAccess()
  let changed = false
  for (const deviceId of names) {
    const code = Object.keys(a.pending).find(c => a.pending[c].device_id === deviceId)
    if (code) {
      const p = a.pending[code]
      a.approved[deviceId] = {
        device_id: deviceId,
        device_name: p.device_name,
        token: newToken(),
        approved_at: Date.now(),
      }
      delete a.pending[code]
      changed = true
    }
    try { rmSync(join(APPROVED_DIR, deviceId)) } catch {}
  }
  if (changed) writeAccess(a)
}

// Start MCP stdio transport last — this holds the event loop open for the
// duration of the Claude session. Bun.serve() must be called first so the
// HTTP/WS server is bound before the MCP handshake completes.
await mcp.connect(new StdioServerTransport())
