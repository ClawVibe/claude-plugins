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
import { join } from 'path'
import type { Socket } from 'bun'

import { STATE_DIR, SOCK_FILE, ensureStateDirs } from './shared/access.ts'
import { loadAgentIdentity } from './shared/identity.ts'
import {
  makeLineDecoder, encodeFrame,
  type IpcFrame, type IpcInbound, type InboundMeta, type AgentIdentity,
} from './shared/protocol.ts'

const AGENT_ID = process.env.CLAUDE_CODE_AGENT || process.env.CLAWVIBE_AGENT_ID || 'default'
const IDENTITY: AgentIdentity = loadAgentIdentity(AGENT_ID)
const DAEMON_PATH = join(import.meta.dir, 'gateway-daemon.ts')

ensureStateDirs()

// ── MCP server + tools ─────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'clawvibe', version: '0.0.1' },
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
      `Reply with the \`reply\` tool, passing conversation_id from the inbound channel tag to reply in the same thread.`,
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
        const conversationId = (args.conversation_id as string | undefined) ?? lastSessionKey ?? 'default'
        const text = args.text as string
        const id = nextMsgId()
        const runId = convToRun.get(conversationId) ?? id
        sendIpc({ v: 1, t: 'reply', sessionKey: conversationId, runId, state: 'final', text })
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
  mcp.notification({
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
        ...(meta.voice_data ? { voice_data: JSON.stringify(meta.voice_data) } : {}),
        ...(meta.thinking ? { thinking: meta.thinking } : {}),
        ...(meta.timeout_ms ? { timeout_ms: String(meta.timeout_ms) } : {}),
      },
    },
  }).catch(err => process.stderr.write(`clawvibe-client: notification failed: ${err}\n`))
}

function onInbound(frame: IpcInbound): void {
  convToRun.set(frame.sessionKey, frame.runId)
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

function spawnDaemon(): void {
  try {
    const proc = Bun.spawn({
      cmd: [process.execPath, DAEMON_PATH],
      stdio: ['ignore', 'ignore', 'inherit'],
      env: process.env,
      // Detach so the daemon outlives this session (it is shared).
    })
    proc.unref()
    process.stderr.write(`clawvibe-client: spawned gateway daemon pid=${proc.pid}\n`)
  } catch (err) {
    process.stderr.write(`clawvibe-client: failed to spawn daemon: ${err}\n`)
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function connectDaemon(): Promise<void> {
  for (let attempt = 0; attempt < 15 && !shuttingDown; attempt++) {
    try {
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
              void connectDaemon()
            }
          },
          error(_s, err) { process.stderr.write(`clawvibe-client: ipc error: ${err}\n`) },
        },
      })
      // Register this agent with the daemon.
      sendIpc({ v: 1, t: 'register', agentId: AGENT_ID, identity: IDENTITY, pid: process.pid })
      process.stderr.write(`clawvibe-client: connected + registered agent=${AGENT_ID} name="${IDENTITY.name}"\n`)
      return
    } catch {
      if (attempt === 0) spawnDaemon() // first failure: daemon likely absent
      await sleep(200)
    }
  }
  if (!shuttingDown) process.stderr.write('clawvibe-client: could not reach gateway daemon after retries\n')
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

await connectDaemon()
await mcp.connect(new StdioServerTransport())
process.stderr.write(`clawvibe-client: MCP transport connected (state ${STATE_DIR})\n`)
