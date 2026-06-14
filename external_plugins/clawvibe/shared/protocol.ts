/**
 * Shared wire + IPC types for the ClawVibe split (gateway daemon ⇆ channel client).
 *
 * - "Gateway wire" types are the OpenClaw protocol spoken to the iOS app over WebSocket.
 * - "IPC" types are the newline-delimited-JSON protocol spoken between the gateway
 *   daemon and each per-session channel client over a Unix domain socket.
 *
 * Pure module: types + small pure helpers only, no side effects.
 */

// ── Gateway wire protocol (iOS app ⇆ daemon) ─────────────────────────────────

export type RequestFrame = {
  type: 'req'
  id: string
  method: string
  params?: Record<string, unknown>
}

export type ResponseFrame = {
  type: 'res'
  id: string
  ok: boolean
  payload?: unknown
  error?: { message: string; details?: Record<string, unknown> }
}

export type EventFrame = {
  type: 'event'
  event: string
  payload: unknown
  seq: number | null
  stateVersion: unknown
}

export type WSData = {
  device_id: string
  device_name: string
  authenticated: boolean
  sessionKey?: string
}

export type ChatState = 'delta' | 'final' | 'error' | 'aborted'

/** Inbound message metadata delivered to a Claude session via notifications/claude/channel. */
export type InboundMeta = {
  device_id: string
  device_name: string
  conversation_id: string
  message_id: string
  ts: string
  context?: string
  location?: string
  voice_data?: unknown
  thinking?: string
  timeout_ms?: number
}

// ── Agent identity ───────────────────────────────────────────────────────────

export type AgentIdentity = { name: string; emoji: string | null }

// ── IPC protocol (channel client ⇆ daemon, NDJSON over Unix socket) ──────────

export const IPC_VERSION = 1

/** client → daemon: announce this agent client and its identity. */
export type IpcRegister = {
  v: 1
  t: 'register'
  agentId: string
  identity: AgentIdentity
  pid: number
}

/** daemon → client: registration accepted. */
export type IpcRegisterOk = { v: 1; t: 'register.ok'; agentId: string }

/** client → daemon: send an assistant message back to the originating device. */
export type IpcReply = {
  v: 1
  t: 'reply'
  sessionKey: string
  runId: string
  state: ChatState
  text?: string
  errorMessage?: string
}

/** client → daemon: edit a previously sent message. */
export type IpcEdit = {
  v: 1
  t: 'edit'
  sessionKey: string
  messageId: string
  text: string
}

/** client → daemon: liveness heartbeat. */
export type IpcPing = { v: 1; t: 'ping' }

/** daemon → client: a device message routed to this agent. */
export type IpcInbound = {
  v: 1
  t: 'inbound'
  sessionKey: string
  runId: string
  text: string
  meta: InboundMeta
}

export type IpcClientToDaemon = IpcRegister | IpcReply | IpcEdit | IpcPing
export type IpcDaemonToClient = IpcRegisterOk | IpcInbound
export type IpcFrame = IpcClientToDaemon | IpcDaemonToClient

// ── sessionKey routing ───────────────────────────────────────────────────────

/**
 * The iOS app encodes the target agent in the sessionKey:
 *   "agent:<agentId>:clawvibe:app:<deviceId>"
 * Returns the agentId, or null for `device:<id>` / malformed keys (caller applies a fallback).
 */
export function agentIdFromSessionKey(sessionKey: string | undefined | null): string | null {
  if (!sessionKey) return null
  const m = /^agent:([^:]+):/.exec(sessionKey)
  return m ? m[1] : null
}

// ── NDJSON framing ───────────────────────────────────────────────────────────

/** Serialize an IPC frame to a single newline-terminated line. */
export function encodeFrame(frame: IpcFrame): string {
  return JSON.stringify(frame) + '\n'
}

/**
 * Returns a stateful chunk handler that buffers partial reads and invokes
 * `onFrame` once per complete newline-delimited JSON object. One socket `data`
 * event is NOT guaranteed to be exactly one frame, so buffering is required.
 */
export function makeLineDecoder(onFrame: (frame: IpcFrame) => void): (chunk: Uint8Array | string) => void {
  let buf = ''
  const decoder = new TextDecoder()
  return (chunk: Uint8Array | string) => {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      try {
        onFrame(JSON.parse(line) as IpcFrame)
      } catch {
        // ignore malformed line
      }
    }
  }
}
