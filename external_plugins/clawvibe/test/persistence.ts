/**
 * Regression harness for issue #43 — outbox persistence across a daemon restart.
 *
 * #23 made a queued reply survive the PHONE going away. It did not make it
 * survive the DAEMON going away, and the daemon goes away routinely: `clawvibe
 * update` swaps the install, `agents restart` SIGTERMs it, and it exit(0)s on
 * EADDRINUSE. Anything queued for an absent device was gone with no trace —
 * the same silent-loss shape #23 set out to remove.
 *
 * What this asserts, beyond "it comes back":
 *   - bounds are re-applied at LOAD, not just at enqueue (a daemon down for a
 *     day must not resurrect a day-old backlog),
 *   - files for device ids nobody can authenticate as again are swept,
 *   - the file is removed once the queue is actually delivered.
 *
 * Run: bun run test:persistence
 */
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PLUGIN = process.argv[2] ?? join(import.meta.dir, '..')
const STATE = mkdtempSync(join(tmpdir(), 'clawvibe-persist-'))
const PORT = '8895'
const AGENT = 'persistagent'
const DEVICE = 'device-persist-test'
const GHOST = 'device-that-repaired-away'
const CAP = 4
const TTL = 60_000
const env = {
  ...process.env,
  CLAWVIBE_STATE_DIR: STATE, CLAWVIBE_PORT: PORT, CLAUDE_CODE_AGENT: AGENT,
  CLAWVIBE_OUTBOX_MAX: String(CAP), CLAWVIBE_OUTBOX_TTL_MS: String(TTL),
  CLAWVIBE_OUTBOX_PERSIST_DEBOUNCE_MS: '150',
  CLAWVIBE_TICK_INTERVAL_MS: '400',
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const dec = new TextDecoder()
const PENDING = join(STATE, 'pending')
const spillFile = (id: string) => join(PENDING, `${encodeURIComponent(id)}.jsonl`)
const spillLines = (id: string) =>
  existsSync(spillFile(id)) ? readFileSync(spillFile(id), 'utf8').split('\n').filter(l => l.trim()) : []

// ── Daemon lifecycle ─────────────────────────────────────────────────────────
let daemon: ReturnType<typeof Bun.spawn> | undefined
let dErr = ''

async function startDaemon(): Promise<boolean> {
  daemon = Bun.spawn({
    cmd: ['bun', join(PLUGIN, 'dist/gateway-daemon.js')],
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const proc = daemon
  void (async () => { for await (const c of proc.stderr as any) dErr += dec.decode(c) })()
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return true } catch {}
    await sleep(100)
  }
  return false
}

/** SIGTERM, not SIGKILL: `agents restart` is a graceful stop, so test that path. */
async function stopDaemon(): Promise<void> {
  try { daemon?.kill('SIGTERM') } catch {}
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/health`) } catch { await sleep(150); return }
    await sleep(100)
  }
}

let client: ReturnType<typeof Bun.spawn> | undefined
const cleanup = () => {
  try { daemon?.kill() } catch {}
  try { client?.kill() } catch {}
}

if (!await startDaemon()) { console.log('FATAL: daemon never came up\n' + dErr); cleanup(); process.exit(1) }

const { bootstrapToken } = await (await fetch(`http://127.0.0.1:${PORT}/bootstrap-token`, {
  method: 'POST',
})).json() as { bootstrapToken: string }

let deviceToken = ''
type Conn = { ws: WebSocket; chat: any[]; ok: boolean }

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
      auth: deviceToken ? { token: deviceToken, bootstrapToken } : { bootstrapToken },
      device: { deviceId: DEVICE },
      client: { clientDisplayName: 'test device' },
    },
  }))
  for (let i = 0; i < 60 && !responded; i++) await sleep(50)
  return conn
}

const textsOf = (c: Conn) => c.chat.map(f => f.payload?.message?.content?.[0]?.text)

/** The agent client has to be re-registered after a daemon restart. */
async function startClient(): Promise<void> {
  client = Bun.spawn({
    cmd: ['bun', join(PLUGIN, 'dist/channel-client.js')],
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const proc = client
  let cErr = ''
  void (async () => { for await (const ch of proc.stderr as any) cErr += dec.decode(ch) })()
  void (async () => { for await (const ch of proc.stdout as any) dec.decode(ch) })()
  for (let i = 0; i < 80; i++) {
    if (cErr.includes('connected + registered')) return
    await sleep(100)
  }
}

const sessionKey = `agent:${AGENT}:clawvibe:app:${DEVICE}`
async function openIpc() {
  return Bun.connect({ unix: join(STATE, 'gateway.sock'), socket: { data() {}, error() {} } })
}

const first = await connectDevice('c1')
await startClient()
let sock = await openIpc()
const reply = (runId: string, text: string) =>
  sock.write(JSON.stringify({
    v: 1, t: 'reply', sessionKey, runId, state: 'final', text, name: 'Persist', emoji: '💾',
  }) + '\n')

// ── Phase A: queue for an absent device, and confirm it hits the disk ────────
first.ws.close()
await sleep(400)
reply('run-a1', 'queued before the restart')
reply('run-a2', 'also queued before the restart')
await sleep(500)
const spilledLines = spillLines(DEVICE)
// Captured here, not at the end: by then everything has been delivered and the
// directory is correctly empty again.
const pendingDirDuringQueue = existsSync(PENDING) ? readdirSync(PENDING) : []
const spilledPayloads = spilledLines.map(l => {
  try { return JSON.parse(l) } catch { return {} as any }
})

// ── Phase B: SIGTERM, restart, and it must still be owed ────────────────────
await stopDaemon()
const survivedOnDisk = spillLines(DEVICE).length
dErr = ''
if (!await startDaemon()) { console.log('FATAL: daemon did not restart\n' + dErr); cleanup(); process.exit(1) }
const restoreLogged = /outbox restored \d+ event\(s\)/.test(dErr)
await startClient()
sock = await openIpc()

const second = await connectDevice('c2')
await sleep(600)
const replayedAfterRestart = textsOf(second)
// Delivered means owed no longer: the file must not linger to be replayed twice.
await sleep(400)
const fileGoneAfterDelivery = !existsSync(spillFile(DEVICE))

// ── Phase C: bounds are re-applied at LOAD, and dead devices are swept ──────
second.ws.close()
await sleep(300)
await stopDaemon()

const now = Date.now()
// The daemon owns this directory; create it anyway so a build that never makes
// it reports failing assertions instead of an ENOENT crash.
mkdirSync(PENDING, { recursive: true })
const frame = (text: string, runId: string) => JSON.stringify({
  type: 'event', event: 'chat',
  payload: { runId, seq: 0, state: 'final', message: { role: 'assistant', content: [{ type: 'text', text }] } },
})
writeFileSync(spillFile(DEVICE), [
  // Written while fresh, but the daemon was "down" far longer than the TTL.
  { payload: frame('stale', 'run-stale'), ts: now - TTL - 60_000 },
  // Six live entries against a cap of four: the OLDEST two must not come back.
  ...[1, 2, 3, 4, 5, 6].map(i => ({ payload: frame(`loaded ${i}`, `run-c${i}`), ts: now - 1000 + i })),
].map(e => JSON.stringify(e)).join('\n') + '\n')
// A phone that re-paired has a new device_id; the old file must not accumulate.
writeFileSync(spillFile(GHOST), JSON.stringify({ payload: '{"type":"event"}', ts: now }) + '\n')
// A daemon killed mid-write leaves a tmp file; it must be cleaned, not loaded.
writeFileSync(`${spillFile(DEVICE)}.tmp`, 'half a li')

dErr = ''
if (!await startDaemon()) { console.log('FATAL: daemon did not restart (phase C)\n' + dErr); cleanup(); process.exit(1) }
await startClient()
const ghostSwept = !existsSync(spillFile(GHOST))
const tmpSwept = !existsSync(`${spillFile(DEVICE)}.tmp`)
const sweepLogged = /swept 1 unknown device file/.test(dErr)

const third = await connectDevice('c3')
await sleep(700)
const replayedLoaded = textsOf(third)

// ── Results ─────────────────────────────────────────────────────────────────
const results: [string, boolean, string][] = [
  ['a queue for an absent device is written to disk', spilledLines.length === 2, `${spilledLines.length} line(s)`],
  ['the spill lives under pending/ keyed by device',
    pendingDirDuringQueue.includes(`${encodeURIComponent(DEVICE)}.jsonl`),
    JSON.stringify(pendingDirDuringQueue)],
  ['each line is the frame plus its timestamp',
    spilledPayloads.every(e => typeof e.payload === 'string' && typeof e.ts === 'number'),
    JSON.stringify(spilledPayloads[0] ?? null).slice(0, 120)],
  ['the spill survives a SIGTERM shutdown', survivedOnDisk === 2, `${survivedOnDisk} line(s)`],
  ['the restarted daemon logs what it restored', restoreLogged,
    dErr.split('\n').filter(l => l.includes('outbox restored'))[0] ?? 'none'],
  ['a reply queued before the restart is delivered after it',
    replayedAfterRestart.join(',') === 'queued before the restart,also queued before the restart',
    JSON.stringify(replayedAfterRestart)],
  ['the file is removed once the queue is delivered', fileGoneAfterDelivery, String(fileGoneAfterDelivery)],
  ['entries past the TTL are dropped at load, not replayed late',
    !replayedLoaded.includes('stale'), JSON.stringify(replayedLoaded)],
  ['OUTBOX_MAX is enforced at load, keeping the newest',
    replayedLoaded.join(',') === 'loaded 3,loaded 4,loaded 5,loaded 6', JSON.stringify(replayedLoaded)],
  ['a file for an unknown device is swept', ghostSwept, String(ghostSwept)],
  ['the sweep is logged', sweepLogged, dErr.split('\n').filter(l => l.includes('swept'))[0] ?? 'none'],
  ['a half-written tmp file is discarded', tmpSwept, String(tmpSwept)],
]

console.log('\n=== issue #43 regression results ===')
let failed = 0
for (const [name, ok, detail] of results) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
}
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
if (failed > 0) console.log('\n--- daemon stderr ---\n' + dErr.slice(-4000))

try { third.ws.close() } catch {}
try { sock.end() } catch {}
cleanup()
process.exit(failed === 0 ? 0 : 1)
