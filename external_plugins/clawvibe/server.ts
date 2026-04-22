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

type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  approved: Record<string, ApprovedDevice>   // keyed by device_id
  pending: Record<string, PendingPair>        // keyed by pairing code (5 letters)
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
  // 5 letters a-z minus 'l' (confusable with 1/I), uppercase for QR legibility.
  const alpha = 'ABCDEFGHIJKMNOPQRSTUVWXYZ'
  let s = ''
  for (const b of randomBytes(5)) s += alpha[b % alpha.length]
  return s
}

function newToken(): string {
  return randomBytes(32).toString('base64url')
}

// Re-read access.json on each check so the /clawvibe:access skill's edits
// land without a server restart (matches telegram's semantics).
function tokenToDevice(token: string): ApprovedDevice | undefined {
  const a = readAccess()
  for (const d of Object.values(a.approved)) if (d.token === token) return d
  return undefined
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
        broadcast({
          type: 'message.final',
          message_id: id,
          conversation_id: conversationId,
          text,
          reply_to: replyTo,
          ts: Date.now(),
        })
        return { content: [{ type: 'text', text: `sent (${id})` }] }
      }
      case 'edit_message': {
        broadcast({
          type: 'message.edit',
          message_id: args.message_id as string,
          conversation_id: (args.conversation_id as string | undefined) ?? 'default',
          text: args.text as string,
          ts: Date.now(),
        })
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
        chat_id: meta.conversation_id, // fakechat/telegram naming compat
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

// ── WS broadcast ─────────────────────────────────────────────────────────────

type WSData = { device_id: string; device_name: string }
const clients = new Map<string, Set<ServerWebSocket<WSData>>>() // device_id -> sockets

let msgSeq = 0
function nextMsgId(): string {
  return `m${Date.now()}-${++msgSeq}`
}

type OutFrame =
  | { type: 'message.delta'; run_id?: string; conversation_id: string; text: string }
  | {
      type: 'message.final'
      message_id: string
      conversation_id: string
      text: string
      reply_to?: string
      ts: number
      run_id?: string
    }
  | {
      type: 'message.edit'
      message_id: string
      conversation_id: string
      text: string
      ts: number
    }
  | { type: 'permission.request'; request_id: string; tool: string; description?: string; preview?: unknown }
  | { type: 'permission.result'; request_id: string; allowed: boolean }
  | { type: 'pong' }
  | { type: 'tick'; ts: number }
  | { type: 'error'; message: string; run_id?: string }

function broadcast(frame: OutFrame, targetDeviceId?: string): void {
  const data = JSON.stringify(frame)
  const send = (ws: ServerWebSocket<WSData>) => { if (ws.readyState === 1) ws.send(data) }
  if (targetDeviceId) clients.get(targetDeviceId)?.forEach(send)
  else for (const set of clients.values()) set.forEach(send)
}

// 30s keepalive.
setInterval(() => broadcast({ type: 'tick', ts: Date.now() }), 30_000)

// ── HTTP + WS server ─────────────────────────────────────────────────────────

type InFrame =
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

Bun.serve<WSData>({
  port: PORT,
  hostname: HOSTNAME,
  fetch(req, server) {
    const url = new URL(req.url)

    // Health
    if (url.pathname === '/' || url.pathname === '/health') {
      return Response.json({ ok: true, server: 'clawvibe', version: '0.0.1' })
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
        // Dedupe any prior pending entries for this device.
        for (const [code, p] of Object.entries(a.pending)) {
          if (p.device_id === deviceId) delete a.pending[code]
        }
        const code = newPairCode()
        const now = Date.now()
        a.pending[code] = {
          device_id: deviceId,
          device_name: deviceName,
          created_at: now,
          expires_at: now + 10 * 60 * 1000, // 10 min
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
      // Drain any stale approved/<device_id> sentinels into access.json first.
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

    // WebSocket upgrade
    if (url.pathname === '/ws') {
      const token = url.searchParams.get('device_token') ?? ''
      const device = tokenToDevice(token)
      if (!device) return new Response('unauthorized', { status: 401 })
      if (server.upgrade(req, { data: { device_id: device.device_id, device_name: device.device_name } })) return
      return new Response('upgrade failed', { status: 400 })
    }

    return new Response('not found', { status: 404 })
  },

  websocket: {
    open(ws) {
      let set = clients.get(ws.data.device_id)
      if (!set) { set = new Set(); clients.set(ws.data.device_id, set) }
      set.add(ws)
      // Touch last_seen.
      const a = readAccess()
      if (a.approved[ws.data.device_id]) {
        a.approved[ws.data.device_id].last_seen_at = Date.now()
        writeAccess(a)
      }
    },
    close(ws) {
      clients.get(ws.data.device_id)?.delete(ws)
    },
    message(ws, raw) {
      let frame: InFrame
      try { frame = JSON.parse(String(raw)) as InFrame } catch { return }
      switch (frame.type) {
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }))
          return
        case 'chat.send': {
          // Compose message with sensory tags appended (stable order).
          const parts = [frame.text]
          if (frame.tags?.context) parts.push(`[CONTEXT: ${frame.tags.context}]`)
          if (frame.tags?.location) parts.push(`[LOCATION: ${frame.tags.location}]`)
          if (frame.tags?.voice_data) parts.push(`[VOICE_DATA: ${JSON.stringify(frame.tags.voice_data)}]`)
          deliverInbound(parts.join('\n'), {
            device_id: ws.data.device_id,
            device_name: ws.data.device_name,
            conversation_id: frame.conversation_id || 'default',
            message_id: frame.run_id,
            ts: new Date().toISOString(),
            context: frame.tags?.context,
            location: frame.tags?.location,
            voice_data: frame.tags?.voice_data,
          })
          return
        }
        case 'chat.abort':
          // Surface an abort-style error; the agent sees no direct signal
          // in this first-pass implementation. Follow-up: translate into a
          // claude/channel/abort notification when that capability lands.
          process.stderr.write(`clawvibe: abort run_id=${frame.run_id}\n`)
          return
        case 'permission.reply':
          // Permission relay follow-up lands the reply here and emits
          // notifications/claude/channel/permission. First pass: no-op.
          return
      }
    },
  },
})

process.stderr.write(`clawvibe: listening on http://${HOSTNAME}:${PORT}\n`)

// ── Approval sentinels ───────────────────────────────────────────────────────
// The `/clawvibe:access pair <code>` skill writes an empty file named
// `approved/<device_id>` to signal "this device is approved; issue a token."
// We drain those sentinels into access.json when checked.

function drainApprovalSentinels(): void {
  let names: string[] = []
  try { names = readdirSync(APPROVED_DIR) } catch { return }
  if (names.length === 0) return
  const a = readAccess()
  let changed = false
  for (const deviceId of names) {
    // Find the pending entry for this device_id, promote to approved.
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
