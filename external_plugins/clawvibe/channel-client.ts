#!/usr/bin/env bun
/**
 * ClawVibe channel client — the thin per-Claude-session MCP server.
 *
 * Launched by the plugin via `--channels` (.mcp.json → `bun channel-client.ts`).
 * It does NOT bind any port. Instead it connects to the shared gateway daemon
 * over a Unix domain socket (auto-spawning the daemon if absent), registers its
 * agent identity, relays inbound device messages into this Claude session as
 * `notifications/claude/channel`, and implements the `reply`/`edit_message`
 * tools by sending frames back to the daemon for delivery to the right device.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { join } from 'path'
import type { Socket } from 'bun'

import { STATE_DIR, SOCK_FILE, ensureStateDirs } from './shared/access.ts'
import {
  makeLineDecoder, encodeFrame,
  type IpcFrame, type IpcInbound, type InboundMeta,
} from './shared/protocol.ts'

// A session only acts as a channel agent when it was launched for a specific
// agent (--agent → CLAUDE_CODE_AGENT, or an explicit CLAWVIBE_AGENT_ID). A
// session that merely has the plugin enabled (e.g. a dev session) has neither,
// so it stays inert instead of registering a bogus "default" agent that would
// pollute the picker and fight other such sessions for the "default" id.
const EXPLICIT_AGENT = process.env.CLAUDE_CODE_AGENT || process.env.CLAWVIBE_AGENT_ID || ''
const AGENT_ID = EXPLICIT_AGENT || 'default'
// Connection identity: unique per client PROCESS, stable across its reconnects.
// AGENT_ID alone is the agent *type* and collides between concurrent sessions —
// keying the daemon registry on it made two clients evict each other forever.
const CONN_ID = `${AGENT_ID}#${randomUUID()}`
// Resolve the daemon next to the running file — `.js` when bundled into dist/,
// `.ts` when running from source.
const DAEMON_PATH =
  ['gateway-daemon.js', 'gateway-daemon.ts']
    .map(f => join(import.meta.dir, f))
    .find(existsSync) ?? join(import.meta.dir, 'gateway-daemon.ts')

ensureStateDirs()

// ── MCP server + tools ─────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'clawvibe', version: '0.1.5' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
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
      `Reply with the \`reply\` tool, passing conversation_id from the inbound channel tag to reply in the same thread.\n` +
      `\n` +
      `IDENTITY — on EVERY \`reply\`, set the \`name\` and \`emoji\` parameters to your display name and emoji. The channel uses them to keep your listing current (it never reads any file), so include them every time even if unchanged.\n` +
      `\n` +
      `LIVENESS — if you receive a message whose conversation_id starts with \`clawvibe:probe\`, it is an automated check, not a user. Immediately \`reply\` to that SAME conversation_id with text \`pong\` and your \`name\`/\`emoji\`. Do not narrate it or tell the user about it.\n` +
      `\n` +
      `STAY ONLINE — you are a long-lived channel agent, not a task to complete. After you \`reply\`, your work is NOT finished: go back to waiting for the next device message. End every turn standing by, and never report the conversation or your assignment as done. This matters mechanically, not just stylistically: the runtime reclaims background sessions it considers settled, so an agent that declares itself finished is reaped and drops out of the app, while one that stays standing by is not.`,
  },
)

// Local correlation: conversation_id (== sessionKey) → runId, populated from inbound frames.
const convToRun = new Map<string, string>()
let lastSessionKey: string | undefined
let msgSeq = 0
function nextMsgId(): string { return `c${Date.now()}-${++msgSeq}` }

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Send an assistant message to the paired ClawVibe device(s). Use conversation_id from the inbound channel tag to reply in the same thread. Text may include [SPEAK]/[TEXT]/--- directives. ALWAYS pass your display name and emoji (name, emoji) — the channel uses them to keep your identity current.',
      inputSchema: {
        type: 'object',
        properties: {
          conversation_id: { type: 'string' },
          text: { type: 'string' },
          name: { type: 'string', description: 'Your display name (include on every reply)' },
          emoji: { type: 'string', description: 'Your emoji (include on every reply)' },
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
        const conversationId = (args.conversation_id as string | undefined) ?? lastSessionKey ?? 'default'
        const text = args.text as string
        const name = args.name as string | undefined
        const emoji = args.emoji as string | undefined
        const id = nextMsgId()
        const runId = convToRun.get(conversationId) ?? id
        sendIpc({ v: 1, t: 'reply', sessionKey: conversationId, runId, state: 'final', text, name, emoji })
        return { content: [{ type: 'text', text: `sent (${id})` }] }
      }
      case 'edit_message': {
        const messageId = args.message_id as string
        const conversationId = (args.conversation_id as string | undefined) ?? lastSessionKey ?? 'default'
        const text = args.text as string
        sendIpc({ v: 1, t: 'edit', sessionKey: conversationId, messageId, text })
        return { content: [{ type: 'text', text: 'ok' }] }
      }
      default:
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `${req.params.name}: ${err instanceof Error ? err.message : err}` }], isError: true }
  }
})

function deliverInbound(text: string, meta: InboundMeta): void {
  // The host validates params as { content: string, meta: record(string, string) }.
  // A single non-string (e.g. an absent device_name) fails validation and the WHOLE
  // notification is dropped silently — so coerce every value and omit empties.
  const m: Record<string, string> = {}
  const put = (k: string, v: unknown): void => {
    if (v !== undefined && v !== null) m[k] = typeof v === 'string' ? v : String(v)
  }
  put('source', 'clawvibe')
  put('chat_id', meta.conversation_id)
  put('message_id', meta.message_id)
  put('user', meta.device_name)
  put('ts', meta.ts)
  put('device_id', meta.device_id)
  put('conversation_id', meta.conversation_id)
  put('context', meta.context)
  put('location', meta.location)
  if (meta.voice_data !== undefined && meta.voice_data !== null) {
    try { put('voice_data', JSON.stringify(meta.voice_data)) } catch {}
  }
  put('thinking', meta.thinking)
  put('timeout_ms', meta.timeout_ms)

  mcp.notification({
    method: 'notifications/claude/channel',
    params: { content: text, meta: m },
  }).catch(err => process.stderr.write(`clawvibe-client: notification failed: ${err}\n`))
}

// Cap on retained conversation→run correlations. Bounded so a long-lived client
// (or a burst of probes) can't grow the heap without limit.
const CONV_TO_RUN_MAX = 256

function onInbound(frame: IpcInbound): void {
  // Never retain probe keys: each probe mints a fresh unique sessionKey, so keeping
  // them leaked a Map entry per probe. Probe replies are not device-facing anyway.
  if (!frame.sessionKey.startsWith('clawvibe:probe')) {
    convToRun.set(frame.sessionKey, frame.runId)
    while (convToRun.size > CONV_TO_RUN_MAX) {
      const oldest = convToRun.keys().next().value
      if (oldest === undefined) break
      convToRun.delete(oldest)
    }
  }
  // Tracked for probes too, so a `reply` that omits conversation_id still lands on
  // the probe conversation (confirming liveness) instead of leaking to a device.
  lastSessionKey = frame.sessionKey
  deliverInbound(frame.text, frame.meta)
}

// ── IPC connection to the daemon (auto-spawn + reconnect) ─────────────────────

let sock: Socket<{ decode: (c: Uint8Array) => void }> | null = null
let shuttingDown = false

function sendIpc(frame: IpcFrame): void {
  if (!sock) { process.stderr.write('clawvibe-client: no daemon connection; dropping frame\n'); return }
  try { sock.write(encodeFrame(frame)) } catch (err) {
    process.stderr.write(`clawvibe-client: ipc write failed: ${err}\n`)
  }
}

let daemonSpawned = false

function spawnDaemon(): void {
  // Launch via `setsid` so the daemon runs in its own session, fully detached
  // from this client's process tree. Otherwise the daemon dies/destabilises when
  // the spawning agent session restarts (it is a SHARED, long-lived process).
  // Falls back to a plain detached spawn if `setsid` is unavailable.
  const attempts: string[][] = [
    ['setsid', process.execPath, DAEMON_PATH],
    [process.execPath, DAEMON_PATH],
  ]
  for (const cmd of attempts) {
    try {
      const proc = Bun.spawn({ cmd, stdio: ['ignore', 'ignore', 'ignore'], env: process.env })
      proc.unref()
      process.stderr.write(`clawvibe-client: spawned gateway daemon (${cmd[0]}) pid=${proc.pid}\n`)
      return
    } catch (err) {
      process.stderr.write(`clawvibe-client: spawn via ${cmd[0]} failed: ${err}\n`)
    }
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const RECONNECT_BASE_MS = 250
const RECONNECT_MAX_MS = 10_000

// Guards against overlapping connect loops: `close` fires asynchronously, so two
// loops could otherwise interleave and orphan sockets (the single global `sock`
// was overwritten without ending the previous one).
let connecting = false
let backoffMs = RECONNECT_BASE_MS

async function connectDaemon(): Promise<void> {
  if (connecting || shuttingDown) return
  connecting = true
  try {
    for (let attempt = 0; attempt < 15 && !shuttingDown; attempt++) {
      try {
        // Never leak a previous socket when re-entering the loop.
        if (sock) { try { sock.end() } catch {} ; sock = null }
        sock = await Bun.connect<{ decode: (c: Uint8Array) => void }>({
          unix: SOCK_FILE,
          socket: {
            open(s) {
              s.data = { decode: makeLineDecoder(f => { if (f.t === 'inbound') onInbound(f) }) }
            },
            data(s, data) { s.data.decode(data) },
            close() {
              sock = null
              if (!shuttingDown) {
                process.stderr.write('clawvibe-client: daemon connection closed; reconnecting\n')
                // Delayed + jittered: an immediate reconnect here was half of the
                // mutual-eviction storm (the other half was daemon-side eviction).
                setTimeout(() => void connectDaemon(), RECONNECT_BASE_MS + Math.random() * RECONNECT_BASE_MS)
              }
            },
            error(_s, err) { process.stderr.write(`clawvibe-client: ipc error: ${err}\n`) },
          },
        })
        // Register this agent with the daemon.
        sendIpc({ v: 1, t: 'register', agentId: AGENT_ID, connId: CONN_ID, pid: process.pid })
        process.stderr.write(`clawvibe-client: connected + registered agent=${AGENT_ID} conn=${CONN_ID} (awaiting probe confirmation)\n`)
        backoffMs = RECONNECT_BASE_MS
        return
      } catch {
        // Once per process — retrying the spawn on every reconnect forked a
        // redundant daemon (which exits(0)) on each attempt.
        if (!daemonSpawned) { daemonSpawned = true; spawnDaemon() }
        await sleep(backoffMs + Math.random() * backoffMs * 0.3)
        backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS)
      }
    }
    if (!shuttingDown) process.stderr.write('clawvibe-client: could not reach gateway daemon after retries\n')
  } finally {
    connecting = false
  }
}

// Heartbeat (socket EOF is the primary liveness signal; this is belt-and-braces).
setInterval(() => { if (sock) sendIpc({ v: 1, t: 'ping' }) }, 15_000)

// Exit when the parent Claude session ends (stdin closes). The daemon lingers.
function onParentGone(reason: string): void {
  shuttingDown = true
  process.stderr.write(`clawvibe-client: ${reason}; exiting\n`)
  try { sock?.end() } catch {}
  process.exit(0)
}
process.stdin.on('end', () => onParentGone('stdin closed (parent exited)'))
process.stdin.on('error', () => onParentGone('stdin error (parent exited)'))

process.on('unhandledRejection', err => process.stderr.write(`clawvibe-client: unhandled rejection: ${err}\n`))

// ── Start ──────────────────────────────────────────────────────────────────────

// ORDER MATTERS: the MCP transport must be live BEFORE we join the gateway.
// Registering first meant the daemon's immediate confirmation probe arrived while
// `_transport` was still null, so `mcp.notification()` threw "Not connected", the
// probe was lost, the agent was never confirmed, and the app listed zero agents.
await mcp.connect(new StdioServerTransport())
process.stderr.write(`clawvibe-client: MCP transport connected (state ${STATE_DIR})\n`)

if (EXPLICIT_AGENT) {
  await connectDaemon()
} else {
  process.stderr.write('clawvibe-client: no agent id (CLAUDE_CODE_AGENT/CLAWVIBE_AGENT_ID unset) — running inert, not joining the gateway\n')
}
