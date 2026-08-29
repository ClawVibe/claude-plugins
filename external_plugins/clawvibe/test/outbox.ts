/**
 * Regression harness for issue #23 — the per-device outbox.
 *
 * If the device's websocket was down when a reply arrived, the reply was
 * destroyed. No outbox, no retry, no persistence, no replay on reconnect — the
 * entire failure handling was a counter (`broadcast event=chat sent=0`). That
 * is the wifi-to-cellular handoff on a moving vehicle, and it made the loss
 * PERMANENT rather than delayed.
 *
 * Replays are byte-identical to the original frames, so they carry their
 * original (runId, seq) and the client can dedupe — which is only safe because
 * seq no longer restarts at 0 within a run (#24).
 *
 * Run: bun run test:outbox
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PLUGIN = process.argv[2] ?? join(import.meta.dir, '..')
const STATE = mkdtempSync(join(tmpdir(), 'clawvibe-outbox-'))
const PORT = '8897'
const AGENT = 'outboxagent'
const DEVICE = 'device-outbox-test'
const CAP = 3
const TTL = 2000
const env = {
  ...process.env,
  CLAWVIBE_STATE_DIR: STATE, CLAWVIBE_PORT: PORT, CLAUDE_CODE_AGENT: AGENT,
  CLAWVIBE_OUTBOX_MAX: String(CAP), CLAWVIBE_OUTBOX_TTL_MS: String(TTL),
  CLAWVIBE_TICK_INTERVAL_MS: '400',
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const dec = new TextDecoder()

const daemon = Bun.spawn({
  cmd: ['bun', join(PLUGIN, 'dist/gateway-daemon.js')],
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let dErr = ''
void (async () => { for await (const c of daemon.stderr as any) dErr += dec.decode(c) })()
const cleanup = () => { try { daemon.kill() } catch {} }

let up = false
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) { up = true; break } } catch {}
  await sleep(100)
}
if (!up) { console.log('FATAL: daemon never came up\n' + dErr); cleanup(); process.exit(1) }

const { bootstrapToken } = await (await fetch(`http://127.0.0.1:${PORT}/bootstrap-token`, {
  method: 'POST',
})).json() as { bootstrapToken: string }

let deviceToken = ''
type Conn = { ws: WebSocket; chat: any[]; ok: boolean }

/** Connect + authenticate a device socket, collecting the chat events it sees. */
async function connectDevice(id: string): Promise<Conn> {
  const conn: Conn = { ws: new WebSocket(`ws://127.0.0.1:${PORT}/`), chat: [], ok: false }
  let responded = false
  conn.ws.addEventListener('message', ev => {
    const frame = JSON.parse(String(ev.data))
    if (frame.type === 'res' && frame.id === id) {
      responded = true
      conn.ok = frame.ok === true
      const t = frame.payload?.auth?.deviceToken
      if (t) deviceToken = t
    }
    if (frame.type === 'event' && frame.event === 'chat') conn.chat.push(frame)
  })
  await new Promise<void>((res, rej) => {
    conn.ws.addEventListener('open', () => res())
    conn.ws.addEventListener('error', e => rej(e))
    setTimeout(() => rej(new Error('ws open timeout')), 5000)
  })
  conn.ws.send(JSON.stringify({
    type: 'req', id, method: 'connect',
    params: {
      // The daemon re-authenticates a device from an already-used setup code,
      // so the same bootstrap token is the reconnect path too.
      auth: deviceToken ? { token: deviceToken, bootstrapToken } : { bootstrapToken },
      device: { deviceId: DEVICE },
      client: { clientDisplayName: 'test device' },
    },
  }))
  for (let i = 0; i < 50 && !responded; i++) await sleep(50)
  return conn
}

const first = await connectDevice('c1')

// Register an agent client so chat.send has somewhere to route.
const client = Bun.spawn({
  cmd: ['bun', join(PLUGIN, 'dist/channel-client.js')],
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
})
let cErr = ''
void (async () => { for await (const ch of client.stderr as any) cErr += dec.decode(ch) })()
void (async () => { for await (const ch of client.stdout as any) dec.decode(ch) })()
for (let i = 0; i < 60; i++) {
  if (cErr.includes('connected + registered')) break
  await sleep(100)
}

const sessionKey = `agent:${AGENT}:clawvibe:app:${DEVICE}`
const sock = await Bun.connect({ unix: join(STATE, 'gateway.sock'), socket: { data() {}, error() {} } })
const reply = (runId: string, text: string, state = 'final') =>
  sock.write(JSON.stringify({ v: 1, t: 'reply', sessionKey, runId, state, text, name: 'Outbox', emoji: '📮' }) + '\n')
const textsOf = (c: Conn) => c.chat.map(f => f.payload?.message?.content?.[0]?.text)

async function closeAndSettle(c: Conn) {
  c.ws.close()
  await sleep(400)
}

// ── Phase A: a reply produced while the device is away must survive ──────────
await closeAndSettle(first)
reply('run-a', 'message you were not there for')
await sleep(400)
const queuedLogged = dErr.includes('queued=1')
const second = await connectDevice('c2')
await sleep(500)
const replayedA = textsOf(second)

// ── Phase B: the outbox is bounded, keeping the NEWEST entries ───────────────
await closeAndSettle(second)
for (let i = 1; i <= 5; i++) { reply(`run-b${i}`, `burst ${i}`); await sleep(60) }
await sleep(300)
const third = await connectDevice('c3')
await sleep(500)
const replayedB = textsOf(third)

// ── Phase C: stale entries expire rather than arriving hours late ────────────
await closeAndSettle(third)
reply('run-c', 'too old to be worth replaying')
await sleep(TTL + 900)
const fourth = await connectDevice('c4')
await sleep(500)
const replayedC = textsOf(fourth)

const results: [string, boolean, string][] = [
  ['device paired and authenticated', first.ok, `token=${deviceToken ? 'issued' : 'none'}`],
  ['agent client registered', cErr.includes('connected + registered'), cErr.split('\n').slice(-2).join(' | ')],
  ['daemon queued the undeliverable reply instead of dropping it', queuedLogged,
    dErr.split('\n').filter(l => l.includes('queued=')).slice(-1)[0] ?? 'no queued= log line'],
  ['it was replayed on reconnect', replayedA.includes('message you were not there for'),
    JSON.stringify(replayedA)],
  ['the replay kept its original runId', second.chat.some(f => f.payload?.runId === 'run-a'),
    JSON.stringify(second.chat.map(f => f.payload?.runId))],
  ['the daemon logged the replay', dErr.includes('outbox replayed'),
    dErr.split('\n').filter(l => l.includes('outbox replayed')).slice(-1)[0] ?? 'none'],
  [`the outbox is capped at ${CAP}`, replayedB.length === CAP, `${replayedB.length}: ${JSON.stringify(replayedB)}`],
  ['the cap drops the OLDEST, keeping the newest', JSON.stringify(replayedB) === '["burst 3","burst 4","burst 5"]',
    JSON.stringify(replayedB)],
  ['stale entries are not replayed', replayedC.length === 0, JSON.stringify(replayedC)],
  // Half-open sockets report readyState 1, so the daemon logged sent=1 for a
  // frame that reached nobody and the outbox never engaged. Server-side
  // ping/pong is what makes `sent` honest. A healthy socket that answers must
  // survive many ticks untouched — a false positive here would disconnect a
  // working phone every 30s.
  ['server-side ping does not evict a healthy socket', !dErr.includes('no pong'),
    dErr.split('\n').filter(l => l.includes('no pong')).join(' | ') || 'none'],
  ['the outbox is drained, not re-sent forever', (await (async () => {
    await closeAndSettle(fourth)
    const fifth = await connectDevice('c5')
    await sleep(400)
    const n = fifth.chat.length
    try { fifth.ws.close() } catch {}
    return n
  })()) === 0, 'a second reconnect must receive nothing'],
]

console.log('\n=== issue #23 regression results ===')
let failed = 0
for (const [name, ok, detail] of results) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
}
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
if (failed > 0) console.log('\n--- daemon stderr ---\n' + dErr.slice(-4000))

try { sock.end() } catch {}
try { client.kill() } catch {}
cleanup()
process.exit(failed === 0 ? 0 : 1)
