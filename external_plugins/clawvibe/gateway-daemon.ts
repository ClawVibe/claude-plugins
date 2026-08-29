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
  TICK_INTERVAL_MS, HANDSHAKE_TIMEOUT_MS, ACTIVE_RUN_TTL_MS, OUTBOX_TTL_MS, OUTBOX_MAX,
  HISTORY_TTL_MS, HISTORY_MAX, HISTORY_DEFAULT_LIMIT, HISTORY_DEFAULT_MAX_CHARS,
  ensureStateDirs, readAccess, writeAccess, newPairCode, newToken,
  tokenToDevice, newBootstrapToken, consumeBootstrapToken, drainApprovalSentinels,
  type ApprovedDevice,
} from './shared/access.ts'
import {
  agentIdFromSessionKey, deviceIdFromSessionKey, makeLineDecoder, encodeFrame,
  type RequestFrame, type ResponseFrame, type EventFrame, type WSData,
  type ChatState, type InboundMeta, type AgentIdentity, type IpcFrame,
} from './shared/protocol.ts'
import {
  mergeAgentList, defaultAgentId,
  type ReachableAgent, type LiveSession, type ListedAgent,
} from './shared/listing.ts'
import { pinnedLiveSessions } from './shared/sessions.ts'
import { VERSION } from './shared/version.ts'

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

type SockState = { decode: (chunk: Uint8Array) => void; agentId?: string; connId?: string }
// identity is learned from the agent's replies, not from registration, and refreshes on
// every reply (so mid-flight changes propagate). `confirmed` records that an agent has
// answered at least one probe. Since issue #25 it no longer GATES reachability or routing
// -- a live connection does that -- it only breaks ties and supplies a real display name.
type AgentConn = {
  connId: string
  agentId: string
  /** Short bg-session id (pins.json key), when the client runs in a background
   *  session. Links this connection to a pinned session so the two are listed once. */
  jobId?: string
  identity?: AgentIdentity
  sock: Socket<SockState>
  registeredAt: number
  confirmed: boolean
  lastProbeAt: number
  probeCount: number
}

// Keyed by connId (unique per client PROCESS), NOT by agentId. agentId is the agent
// *type* and collides between concurrent sessions; keying on it made each new client
// evict the incumbent, whose instant reconnect evicted the newcomer, forever.
// Several clients may therefore share one agentId — resolve via connForAgent().
/** The agent *type* every generic background job reports. Useless as an identity. */
const GENERIC_AGENT_ID = 'claude'

const agentClients = new Map<string, AgentConn>()

/** Newest live connection for an agent id, preferring a confirmed one. */
function connForAgent(agentId: string): AgentConn | undefined {
  let best: AgentConn | undefined
  for (const c of agentClients.values()) {
    if (c.agentId !== agentId) continue
    if (!best || (c.confirmed && !best.confirmed) || (c.confirmed === best.confirmed && c.registeredAt > best.registeredAt)) {
      best = c
    }
  }
  return best
}

/** Live connection for a background-session (pin) id. Used to route to pin-keyed
 *  agents, whose agentId is the useless catch-all "claude". */
function connForJob(jobId: string): AgentConn | undefined {
  let best: AgentConn | undefined
  for (const c of agentClients.values()) {
    if (c.jobId !== jobId) continue
    if (!best || (c.confirmed && !best.confirmed) || (c.confirmed === best.confirmed && c.registeredAt > best.registeredAt)) {
      best = c
    }
  }
  return best
}

/**
 * One entry per agentId (newest connection, confirmed winning ties), for app-facing
 * listings.
 *
 * A LIVE CONNECTION is the reachability test, NOT `confirmed` (issue #25). Confirmation
 * costs the agent an inference turn, and the probe that earns it races session boot: when
 * `agents up` starts every agent at once each is probed while still booting, misses it,
 * and the retry ladder then gave up permanently. Those agents were listed as pin rows
 * suffixed "(no channel)" while their clients sat connected on the IPC socket, and the
 * job-id route refused to deliver to them. Delivery is the better test: if a client is
 * connected, hand it the message.
 *
 * UNCONFIRMED clients on the generic catch-all agentId "claude" are the one exception:
 * every generic bg job reports it, so listing them by agentId would collapse unrelated
 * sessions into a single row. They stay pin-keyed (see mergeAgentList). A CONFIRMED
 * "claude" client has proven it is a real channel agent and is listed as before --
 * dropping it here regressed test:storm.
 */
function reachableAgents(): AgentConn[] {
  const byAgent = new Map<string, AgentConn>()
  for (const c of agentClients.values()) {
    if (!c.agentId) continue
    if (c.agentId === GENERIC_AGENT_ID && !c.confirmed) continue
    const prev = byAgent.get(c.agentId)
    if (!prev
      || (c.confirmed && !prev.confirmed)
      || (c.confirmed === prev.confirmed && c.registeredAt > prev.registeredAt)) {
      byAgent.set(c.agentId, c)
    }
  }
  return [...byAgent.values()]
}

function writeIpc(sock: Socket<SockState>, frame: IpcFrame): void {
  try { sock.write(encodeFrame(frame)) } catch (err) {
    process.stderr.write(`clawvibe-daemon: ipc write failed: ${err}\n`)
  }
}

/** Choose an agent when the sessionKey carries none (legacy / device:<id>). */
function pickFallbackAgentId(): string | null {
  for (const c of agentClients.values()) if (c.confirmed) return c.agentId // prefer confirmed
  // No confirmation anywhere is not the same as no agent: an unanswered probe must not
  // strand a legacy `device:<id>` session key with nowhere to go (issue #25).
  for (const c of agentClients.values()) if (c.agentId && c.agentId !== GENERIC_AGENT_ID) return c.agentId
  return null
}

/** Send a liveness/identity probe over the channel path. Only a real --channels
 *  agent turns it into a turn and replies; the reply confirms + carries identity. */
function probeAgent(conn: AgentConn): void {
  const nonce = randomBytes(6).toString('hex')
  const sessionKey = `clawvibe:probe:${nonce}`
  const runId = nextMsgId()
  conn.lastProbeAt = Date.now()
  conn.probeCount++
  writeIpc(conn.sock, {
    v: 1, t: 'inbound', sessionKey, runId,
    text: `[CLAWVIBE_PING ${nonce}] automated liveness check — reply "pong" to this conversation with your name and emoji.`,
    meta: { device_id: '', device_name: 'clawvibe', conversation_id: sessionKey, message_id: runId, ts: new Date().toISOString() },
  })
  process.stderr.write(`clawvibe-daemon: probing agent=${conn.agentId}\n`)
}

function handleIpcFrame(sock: Socket<SockState>, frame: IpcFrame): void {
  switch (frame.t) {
    case 'register': {
      const { agentId, connId, jobId } = frame
      // NO eviction: a duplicate agentId is a legitimate second session, not a stale
      // client. Ending the incumbent here (and its instant reconnect) was the storm.
      // Re-registration of the SAME connId is the same process reconnecting, so carry
      // its confirmation + identity forward rather than forcing a re-probe.
      const prev = agentClients.get(connId)
      sock.data.agentId = agentId
      sock.data.connId = connId
      const conn: AgentConn = {
        connId,
        agentId,
        jobId: jobId ?? prev?.jobId,
        sock,
        registeredAt: Date.now(),
        confirmed: prev?.confirmed ?? false,
        identity: prev?.identity,
        lastProbeAt: prev?.lastProbeAt ?? 0,
        probeCount: prev?.probeCount ?? 0,
      }
      agentClients.set(connId, conn)
      writeIpc(sock, { v: 1, t: 'register.ok', agentId })
      if (conn.confirmed) {
        process.stderr.write(`clawvibe-daemon: agent re-registered id=${agentId} conn=${connId} (already confirmed)\n`)
      } else {
        process.stderr.write(`clawvibe-daemon: agent registered id=${agentId} conn=${connId} (probing for confirmation)\n`)
        probeAgent(conn)
      }
      return
    }
    case 'reply': {
      // Refresh identity + confirm liveness from ANY reply (incl. mid-flight changes).
      const connId = sock.data?.connId
      const conn = connId ? agentClients.get(connId) : undefined
      if (conn) {
        if (frame.name !== undefined || frame.emoji !== undefined) {
          conn.identity = {
            name: frame.name ?? conn.identity?.name ?? conn.agentId,
            emoji: frame.emoji ?? conn.identity?.emoji ?? null,
          }
        }
        if (!conn.confirmed) {
          conn.confirmed = true
          process.stderr.write(`clawvibe-daemon: agent confirmed id=${conn.agentId} name="${conn.identity?.name ?? conn.agentId}"\n`)
        }
      }
      // A probe reply confirms liveness/identity (handled above) but is not device-facing.
      if (frame.sessionKey.startsWith('clawvibe:probe')) return

      // An agent may message a device unprompted, with no active run (#29).
      // activeRuns was doing two jobs: proving the conversation is live, and
      // carrying deviceId for routing. Only routing is needed to deliver, and
      // the sessionKey already names its device — so a missing run is no
      // longer a reason to discard the message. It used to be, silently,
      // while the fire-and-forget reply told the agent "sent".
      // Prefer the run the agent is actually answering; fall back to the newest
      // open run on the conversation for replies that carry no runId.
      const run = (frame.runId ? activeRuns.get(frame.runId) : undefined) ?? currentRun(frame.sessionKey)
      const targetDeviceId = run?.deviceId ?? deviceIdFromSessionKey(frame.sessionKey) ?? undefined
      if (!targetDeviceId) {
        // Not falling back to every connected device: the key names its
        // device, so guessing would risk another user's phone.
        process.stderr.write(`clawvibe-daemon: reply dropped, no device in session ${frame.sessionKey}\n`)
        return
      }
      if (!run) {
        process.stderr.write(`clawvibe-daemon: unprompted reply for ${frame.sessionKey} -> device ${targetDeviceId}\n`)
      }
      broadcastChatEvent(
        frame.runId || run?.runId || `unprompted-${crypto.randomUUID()}`,
        frame.sessionKey, frame.state,
        { text: frame.text, errorMessage: frame.errorMessage, targetDeviceId })
      return
    }
    case 'edit': {
      // Same reasoning as `reply`: an edit to an unprompted message has no run
      // either, and dropping it would strand the message it edits (#29).
      const run = currentRun(frame.sessionKey)
      const targetDeviceId = run?.deviceId ?? deviceIdFromSessionKey(frame.sessionKey) ?? undefined
      if (!targetDeviceId) return
      broadcastChatEvent(frame.messageId, frame.sessionKey, 'final', {
        text: frame.text,
        targetDeviceId,
      })
      return
    }
    case 'ping':
      return
  }
}

function onIpcClose(sock: Socket<SockState>): void {
  const connId = sock.data?.connId
  if (connId && agentClients.get(connId)?.sock === sock) {
    agentClients.delete(connId)
    process.stderr.write(`clawvibe-daemon: agent deregistered id=${sock.data?.agentId} conn=${connId}\n`)
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
// Per-device outbox (#23). A chat event that reached nobody used to be counted
// (`sent=0`) and destroyed — the wifi-to-cellular handoff case on a moving
// vehicle, which made the loss permanent rather than delayed. Bounded by
// OUTBOX_MAX and OUTBOX_TTL_MS: a phone that never comes back must not be able
// to leak the daemon's heap.
const outbox = new Map<string, { payload: string; ts: number }[]>()
// Last pong per device socket. reapDeadSockets only inspected `readyState`, and
// a half-open socket reports 1 — so the daemon logged `sent=1` for a frame that
// reached nobody, and the outbox would never engage for the very case it exists
// for. WeakMap so a closed socket needs no cleanup.
const lastPong = new WeakMap<ServerWebSocket<WSData>, number>()
// Bounded per-sessionKey transcript, for chat.history (#44). The outbox is the
// PUSH path — bounded, expiring, and useless to a device that was away longer
// than its TTL. This is the PULL path: the client asks for what it missed. Both
// are fed from the single recording point in broadcastChatEvent; they are
// indexed differently (device vs session) and hold different things (whole
// frames vs assistant text), so they are deliberately separate maps rather than
// one store contorted to serve both.
// This is a convenience cache, NOT durable storage: bounded by HISTORY_MAX and
// expired by HISTORY_TTL_MS.
const history = new Map<string, { runId: string; seq: number; text: string; ts: number }[]>()
// Keyed by runId, NOT sessionKey (#24). Keying by sessionKey meant a second
// chat.send on the same conversation overwrote the first entry, and the orphaned
// run then received no chat event ever — not final, not error, and not even the
// aborted safety net, because pruneActiveRuns can only abort entries still in
// the map. deviceId lets replies route back to the originating device.
const activeRuns = new Map<string, { runId: string; sessionKey: string; ts: number; deviceId: string }>()
// sessionKey -> runIds in start order. Lets a reply that carries no runId (and
// every `edit`) resolve "the current run on this conversation" without making
// the run map itself lossy.
const runsBySession = new Map<string, Set<string>>()
// Per-run chat event sequence. Deliberately NOT deleted on a terminal state
// (#24): doing so reset the counter, so a second reply in the same run was
// emitted as seq 0 again and any client deduping on (runId, seq) silently
// discarded it. Expired on TTL instead, which also stops the map growing.
const runSeq = new Map<string, { n: number; ts: number }>()

let msgSeq = 0
let eventSeq = 0
function nextMsgId(): string { return `m${Date.now()}-${++msgSeq}` }
function nextEventSeq(): number { return ++eventSeq }
function nextRunSeq(runId: string): number {
  const n = (runSeq.get(runId)?.n ?? -1) + 1
  runSeq.set(runId, { n, ts: Date.now() })
  return n
}

function startRun(sessionKey: string, runId: string, deviceId: string): void {
  activeRuns.set(runId, { runId, sessionKey, ts: Date.now(), deviceId })
  let set = runsBySession.get(sessionKey)
  if (!set) { set = new Set(); runsBySession.set(sessionKey, set) }
  set.add(runId)
}

/** The most recently started run still open on this conversation, if any. */
function currentRun(sessionKey: string) {
  const set = runsBySession.get(sessionKey)
  if (!set) return undefined
  let latest: { runId: string; sessionKey: string; ts: number; deviceId: string } | undefined
  for (const id of set) {
    const run = activeRuns.get(id)
    if (run && (!latest || run.ts >= latest.ts)) latest = run
  }
  return latest
}

function endRun(runId: string): void {
  const run = activeRuns.get(runId)
  if (!run) return
  activeRuns.delete(runId)
  const set = runsBySession.get(run.sessionKey)
  if (set) { set.delete(runId); if (set.size === 0) runsBySession.delete(run.sessionKey) }
}

function enqueueOutbox(deviceId: string, payload: string): void {
  const q = outbox.get(deviceId) ?? []
  q.push({ payload, ts: Date.now() })
  // Drop oldest first: a replay of the most recent messages is worth more than
  // a complete replay of a stale backlog.
  while (q.length > OUTBOX_MAX) q.shift()
  outbox.set(deviceId, q)
}

function recordHistory(sessionKey: string, runId: string, seq: number, text: string): void {
  const q = history.get(sessionKey) ?? []
  q.push({ runId, seq, text, ts: Date.now() })
  while (q.length > HISTORY_MAX) q.shift()
  history.set(sessionKey, q)
}

function pruneHistory(): void {
  const now = Date.now()
  for (const [sessionKey, q] of history) {
    const kept = q.filter(e => now - e.ts <= HISTORY_TTL_MS)
    if (kept.length === 0) history.delete(sessionKey)
    else if (kept.length !== q.length) history.set(sessionKey, kept)
  }
}

function pruneOutbox(): void {
  const now = Date.now()
  for (const [deviceId, q] of outbox) {
    const kept = q.filter(e => now - e.ts <= OUTBOX_TTL_MS)
    if (kept.length === 0) outbox.delete(deviceId)
    else if (kept.length !== q.length) outbox.set(deviceId, kept)
  }
}

/**
 * Replay undelivered chat events to a device that just authenticated.
 *
 * Replays are byte-identical to the original frames, so they carry their
 * original `(runId, seq)` and the client can dedupe on it — which is only safe
 * because seq no longer restarts at 0 within a run (#24).
 */
function flushOutbox(ws: ServerWebSocket<WSData>, deviceId: string): void {
  const q = outbox.get(deviceId)
  if (!q || q.length === 0) return
  outbox.delete(deviceId)
  const now = Date.now()
  let replayed = 0
  for (const entry of q) {
    if (now - entry.ts > OUTBOX_TTL_MS) continue
    try { if (ws.readyState === 1) { ws.send(entry.payload); replayed++ } } catch (err) {
      process.stderr.write(`clawvibe-daemon: outbox replay failed: ${err}\n`)
    }
  }
  process.stderr.write(`clawvibe-daemon: outbox replayed ${replayed}/${q.length} event(s) to device=${deviceId}\n`)
}

/**
 * Close device sockets that stopped answering pings, then ping the rest.
 *
 * Without this a half-open socket keeps `readyState === 1` forever, so
 * broadcasts are counted as delivered and never reach the outbox.
 */
function pingDeviceSockets(): void {
  const now = Date.now()
  const deadline = TICK_INTERVAL_MS * 2.5
  for (const set of clients.values()) {
    for (const ws of set) {
      if (ws.readyState !== 1) continue
      const seen = lastPong.get(ws)
      if (seen !== undefined && now - seen > deadline) {
        process.stderr.write(`clawvibe-daemon: no pong in ${Math.round((now - seen) / 1000)}s, closing device=${ws.data.device_id}\n`)
        try { ws.close(4002, 'no pong') } catch {}
        continue
      }
      if (seen === undefined) lastPong.set(ws, now)
      try { ws.ping() } catch {}
    }
  }
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
  for (const run of [...activeRuns.values()]) {
    if (now - run.ts > ACTIVE_RUN_TTL_MS) {
      // Don't leave the app spinning on a run that never produced a final.
      // broadcastChatEvent ends the run for us (terminal state).
      broadcastChatEvent(run.runId, run.sessionKey, 'aborted', { targetDeviceId: run.deviceId })
    }
  }
  // Sequence counters outlive their run so a late reply keeps counting up
  // instead of restarting at 0; they expire on the same TTL.
  for (const [runId, v] of runSeq) {
    if (now - v.ts > ACTIVE_RUN_TTL_MS) runSeq.delete(runId)
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
  // Retain, don't destroy (#23). Only targeted chat events: a broadcast with no
  // target has no device to replay to, and ticks/presence are worthless late.
  if (targetDeviceId && sent === 0 && frame.event === 'chat') {
    enqueueOutbox(targetDeviceId, payload)
  }
  if (frame.event !== 'tick') {
    process.stderr.write(
      `clawvibe-daemon: broadcast event=${frame.event} sent=${sent} skipped=${skipped}` +
      (targetDeviceId && sent === 0 && frame.event === 'chat'
        ? ` queued=${outbox.get(targetDeviceId)?.length ?? 0}`
        : '') + `\n`,
    )
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
  const seq = payload.seq as number
  if (opts.text !== undefined) {
    payload.message = {
      role: 'assistant',
      content: [{ type: 'text', text: opts.text }],
      timestamp: new Date().toISOString(),
    }
    // Only completed messages. Recording `delta` frames too would replay a
    // message as a pile of fragments.
    if (state === 'final') recordHistory(sessionKey, runId, seq, opts.text)
  }
  if (opts.errorMessage !== undefined) payload.errorMessage = opts.errorMessage
  // Close the run, but keep its sequence counter (see runSeq above): a further
  // reply on this runId must continue the sequence, not restart it.
  if (state === 'final' || state === 'error' || state === 'aborted') endRun(runId)

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
  pingDeviceSockets()
  reapDeadSockets()
  pruneActiveRuns()
  pruneOutbox()
  pruneHistory()
  refreshPinnedSnapshot()
  broadcastEvent({ type: 'event', event: 'tick', payload: null, seq: nextEventSeq(), stateVersion: null })
}, TICK_INTERVAL_MS)

// ── Inbound routing (daemon → agent client) ──────────────────────────────────

function routeInbound(sessionKey: string, runId: string, text: string, meta: InboundMeta): boolean {
  const agentId = agentIdFromSessionKey(sessionKey) ?? pickFallbackAgentId()
  // agentId first, job id second: a device paired before pin-keyed listing still
  // holds `agent:spongebob:…` session keys, and those must keep routing.
  //
  // Neither path requires CONFIRMED any more (issue #25). It was required here on the
  // theory that a pin-keyed target has no --channels and its client would swallow the
  // frame until the 5-minute activeRuns TTL. In practice it also refused agents that were
  // launched WITH --channels and merely missed their boot-time probe, which is the far
  // more common case. An undeliverable send now surfaces as that TTL abort instead of an
  // instant refusal — trying and timing out beats refusing to try.
  const byJob = agentId ? connForJob(agentId) : undefined
  const conn = (agentId ? connForAgent(agentId) : undefined) ?? byJob
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

  process.stderr.write(
    `clawvibe-daemon: connect auth=[${Object.keys(auth ?? {}).join(',') || 'none'}]\n`,
  )

  let device: ApprovedDevice | undefined

  if (bootstrapToken) {
    if (consumeBootstrapToken(bootstrapToken)) {
      // Fresh pairing: auto-approve this device and issue a device token.
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
      // Already-used setup code: the iOS app re-presents it on reconnect (e.g.
      // after switching servers) instead of the issued device token. Re-auth the
      // device this code originally paired, and the HelloOk below re-hands it the
      // device token. Only succeeds if that device is still approved.
      const a = readAccess()
      const bt = a.bootstrapTokens?.[bootstrapToken]
      device = bt?.paired_device_id ? a.approved[bt.paired_device_id] : undefined
      if (device) {
        process.stderr.write(`clawvibe-daemon: bootstrap reused → re-auth device=${device.device_id}\n`)
      } else {
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
    }
  } else {
    device = tokenToDevice(token)
    process.stderr.write(`clawvibe-daemon: token auth → ${device ? 'OK device=' + device.device_id : 'REJECTED (token not in access.json)'}\n`)
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
      server: { name: 'clawvibe', version: VERSION },
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
  // After hello_ok, never before: the app must have its session before it can
  // make sense of a replayed chat event.
  flushOutbox(ws, device.device_id)
}

/**
 * chat.history — the reconnect backfill the iOS app has been calling since
 * `issue/bug-325-reconnect-backfill`, against a gateway that answered
 * "unknown method" every time (#44).
 *
 * Request params come from the protocol-generated `ChatHistoryParams`:
 * `{ sessionKey, limit?, maxChars? }`. The client's decoder is deliberately
 * permissive, but we return the same shape live chat events use, plus runId and
 * seq so the client can dedupe backfill against live delivery later.
 */
function handleChatHistory(ws: ServerWebSocket<WSData>, req: RequestFrame): void {
  const params = req.params ?? {}
  const sessionKey = params.sessionKey as string | undefined
  if (typeof sessionKey !== 'string' || !sessionKey) {
    sendFrame(ws, { type: 'res', id: req.id, ok: false, error: { message: 'sessionKey required' } })
    return
  }

  // A sessionKey names its own device. Without this check any authenticated
  // socket could read another device's transcript just by asking for its key.
  // Answer empty rather than erroring: the requester learns nothing about
  // whether that session exists.
  const owner = deviceIdFromSessionKey(sessionKey)
  if (owner && owner !== ws.data.device_id) {
    process.stderr.write(`clawvibe-daemon: chat.history refused, device=${ws.data.device_id} asked for session owned by ${owner}\n`)
    sendFrame(ws, { type: 'res', id: req.id, ok: true, payload: { messages: [] } })
    return
  }

  const rawLimit = typeof params.limit === 'number' ? params.limit : HISTORY_DEFAULT_LIMIT
  const limit = Math.max(0, Math.min(Math.floor(rawLimit), HISTORY_MAX))
  const rawMaxChars = typeof params.maxChars === 'number' ? params.maxChars : HISTORY_DEFAULT_MAX_CHARS
  const maxChars = Math.max(0, Math.floor(rawMaxChars))

  const now = Date.now()
  const all = (history.get(sessionKey) ?? []).filter(e => now - e.ts <= HISTORY_TTL_MS)

  // Select newest-first so truncation drops the OLDEST, then reverse: the
  // client wants them in conversation order. maxChars is enforced as well as
  // limit — it exists to stop a 20k-character backfill, so honouring only
  // `limit` would miss the point.
  const picked: typeof all = []
  let chars = 0
  for (let i = all.length - 1; i >= 0 && picked.length < limit; i--) {
    const entry = all[i]
    if (picked.length > 0 && chars + entry.text.length > maxChars) break
    chars += entry.text.length
    picked.push(entry)
  }
  picked.reverse()

  process.stderr.write(`clawvibe-daemon: chat.history session=${sessionKey} -> ${picked.length}/${all.length} message(s), ${chars} chars\n`)
  sendFrame(ws, {
    type: 'res', id: req.id, ok: true,
    payload: {
      messages: picked.map(e => ({
        role: 'assistant',
        // Same shape as a live chat event's `message`, so the client's decoder
        // needs no special case. Timestamps are ISO 8601 strings, matching live
        // events — deliberately NOT the numeric epoch the client's
        // TalkHistoryTimestamp helper tolerates, which exists only because the
        // gateway has been inconsistent about this in the past.
        content: [{ type: 'text', text: e.text }],
        timestamp: new Date(e.ts).toISOString(),
        runId: e.runId,
        seq: e.seq,
      })),
    },
  })
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
  startRun(sessionKey, runId, deviceId)

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

// Lazy re-probe of connected-but-unconfirmed agents (decision: probe on register +
// reconfirm lazily when the app asks for the list). Backed off per connection and
// capped: every probe costs the agent a real inference turn, so a client that never
// answers (e.g. the plugin loaded without --channels) must not be probed forever.
const REPROBE_BASE_MS = 5_000
const REPROBE_MAX_MS = 300_000
const REPROBE_GIVE_UP_MS = 60 * 60 * 1000

function reprobeUnconfirmed(): void {
  const now = Date.now()
  for (const c of agentClients.values()) {
    if (c.confirmed) continue
    if (now - c.registeredAt > REPROBE_GIVE_UP_MS) continue
    const interval = Math.min(REPROBE_BASE_MS * 2 ** c.probeCount, REPROBE_MAX_MS)
    if (now - c.lastProbeAt > interval) probeAgent(c)
  }
}

// ── Pinned-session snapshot ──────────────────────────────────────────────────
//
// Resolving pins.json ∩ `claude agents --json` costs a subprocess spawn, so it is
// NEVER done in an RPC handler. The daemon keeps a snapshot, refreshed on the 30s
// tick and kicked (throttled) whenever the app asks for the list; handlers stay
// synchronous and serve whatever the last refresh produced. A stale-by-30s list is
// the right trade against blocking the gateway on a child process.

let pinnedSnapshot: LiveSession[] = []
let lastPinnedRefresh = 0
let pinnedRefreshInFlight = false
const PINNED_KICK_MS = 5_000

function refreshPinnedSnapshot(): void {
  if (pinnedRefreshInFlight) return
  pinnedRefreshInFlight = true
  lastPinnedRefresh = Date.now()
  void pinnedLiveSessions()
    .then(s => { pinnedSnapshot = s })
    .catch(err => process.stderr.write(`clawvibe-daemon: pinned refresh failed: ${err}\n`))
    .finally(() => { pinnedRefreshInFlight = false })
}

function kickPinnedRefresh(): void {
  if (Date.now() - lastPinnedRefresh > PINNED_KICK_MS) refreshPinnedSnapshot()
}

/** The app-facing agent list: connected clients + pinned live sessions. */
function listedAgents(): ListedAgent[] {
  const reachable: ReachableAgent[] = reachableAgents().map(c => ({
    agentId: c.agentId,
    jobId: c.jobId,
    // An unconfirmed client has no identity yet (identity arrives with its first reply),
    // so fall back to the runtime's session name before the bare agent id.
    name: c.identity?.name
      ?? (c.jobId ? pinnedSnapshot.find(s => s.id === c.jobId)?.name?.trim() || undefined : undefined)
      ?? c.agentId,
    emoji: c.identity?.emoji ?? null,
  }))
  return mergeAgentList(reachable, pinnedSnapshot)
}

function handleAgentsList(ws: ServerWebSocket<WSData>, req: RequestFrame): void {
  reprobeUnconfirmed()
  kickPinnedRefresh()
  const agents = listedAgents()
  const defaultId = defaultAgentId(agents)
  sendFrame(ws, {
    type: 'res', id: req.id, ok: true,
    payload: {
      defaultId,
      mainKey: `agent:${defaultId}`,
      scope: 'all',
      agents: agents.map(a => ({
        id: a.id,
        name: a.name,
        identity: { name: a.name, emoji: a.emoji },
        workspace: null,
        model: null,
        // Extra field: older app builds ignore it, newer ones can grey the row.
        // The name suffix is what makes it visible either way.
        reachable: a.reachable,
      })),
    },
  })
}

function handleAgentIdentityGet(ws: ServerWebSocket<WSData>, req: RequestFrame): void {
  const params = req.params ?? {}
  const agentId = (params.agentId as string) ?? 'default'
  const c = connForAgent(agentId)
  if (!c || !c.confirmed) {
    // Pin-keyed rows have no confirmed client by definition — answer from the
    // snapshot so the app can still render the name it was just listed under,
    // rather than erroring on an agent it can see in the picker.
    const pinned = pinnedSnapshot.find(s => s.id === agentId)
    if (pinned) {
      const row = listedAgents().find(a => a.id === agentId)
      sendFrame(ws, {
        type: 'res', id: req.id, ok: true,
        payload: { agentId, name: row?.name ?? pinned.name ?? agentId, avatar: null, emoji: null },
      })
      return
    }
    sendFrame(ws, { type: 'res', id: req.id, ok: false, error: { message: `agent not found: ${agentId}` } })
    return
  }
  sendFrame(ws, {
    type: 'res', id: req.id, ok: true,
    payload: { agentId: c.agentId, name: c.identity?.name ?? c.agentId, avatar: null, emoji: c.identity?.emoji ?? null },
  })
}

function handleRPC(ws: ServerWebSocket<WSData>, req: RequestFrame): void {
  switch (req.method) {
    case 'connect': return handleConnect(ws, req)
    case 'chat.send': return handleChatSend(ws, req)
    case 'health': return handleHealth(ws, req)
    case 'agents.list': return handleAgentsList(ws, req)
    case 'agent.identity.get': return handleAgentIdentityGet(ws, req)
    case 'chat.history': return handleChatHistory(ws, req)
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
      startRun(sessionKey, runId, ws.data.device_id)
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
        return Response.json({ ok: true, server: 'clawvibe', version: VERSION })
      }

      // Agent discovery (HTTP) — confirmed (probe-answered) agents plus pinned
      // live sessions, which are listed but not reachable.
      if (url.pathname === '/agents' && req.method === 'GET') {
        reprobeUnconfirmed()
        kickPinnedRefresh()
        return Response.json(listedAgents())
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
      pong(ws) {
        lastPong.set(ws, Date.now())
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

// Populate the pinned-session snapshot immediately, so the first agents.list after
// a daemon start isn't answered from an empty one.
refreshPinnedSnapshot()

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
