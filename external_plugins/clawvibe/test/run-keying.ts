/**
 * Regression harness for issue #24 — run bookkeeping.
 *
 * Two defects, both worst when the user sends several messages in quick
 * succession:
 *
 * 1. `activeRuns` was keyed by sessionKey, so a second `chat.send` on the same
 *    conversation overwrote the first entry. The orphaned run then received no
 *    chat event ever — not final, not error, and not even the aborted safety
 *    net, because pruneActiveRuns can only abort entries still in the map.
 *    Any client holding per-run pending state spins on it forever.
 *
 * 2. `runSeq.delete(runId)` fired on every terminal state, resetting the
 *    counter. Two replies in one run were both emitted as seq 0, so a client
 *    deduping on (runId, seq) silently discarded the second and later bubbles.
 *    Fixing this is a prerequisite for the per-device outbox (#23), which needs
 *    that dedupe to be safe.
 *
 * Run: bun run test:runs
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PLUGIN = process.argv[2] ?? join(import.meta.dir, '..')
const STATE = mkdtempSync(join(tmpdir(), 'clawvibe-runkeying-'))
const PORT = '8898'
const AGENT = 'runagent'
const DEVICE = 'device-runkeying-test'
// Short TTL + fast tick so the abort safety net is observable in a test run
// rather than five minutes later. Both default to production values.
const env = {
  ...process.env,
  CLAWVIBE_STATE_DIR: STATE, CLAWVIBE_PORT: PORT, CLAUDE_CODE_AGENT: AGENT,
  CLAWVIBE_ACTIVE_RUN_TTL_MS: '1500', CLAWVIBE_TICK_INTERVAL_MS: '300',
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

// ── Pair a fake device and hold its socket open ──────────────────────────────
const { bootstrapToken } = await (await fetch(`http://127.0.0.1:${PORT}/bootstrap-token`, {
  method: 'POST',
})).json() as { bootstrapToken: string }

const received: any[] = []
const responses = new Map<string, any>()
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`)
ws.addEventListener('message', ev => {
  const frame = JSON.parse(String(ev.data))
  received.push(frame)
  if (frame.type === 'res' && frame.id) responses.set(frame.id, frame)
})
await new Promise<void>((res, rej) => {
  ws.addEventListener('open', () => res())
  ws.addEventListener('error', e => rej(e))
  setTimeout(() => rej(new Error('ws open timeout')), 5000)
})
ws.send(JSON.stringify({
  type: 'req', id: 'c1', method: 'connect',
  params: { auth: { bootstrapToken }, device: { deviceId: DEVICE }, client: { clientDisplayName: 'test device' } },
}))
for (let i = 0; i < 50 && !responses.has('c1'); i++) await sleep(100)
const helloOk = responses.get('c1')?.ok === true

// ── Register an agent client so chat.send has somewhere to route ─────────────
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
const chatEvents = () => received.filter(f => f.type === 'event' && f.event === 'chat')

async function chatSend(id: string, message: string): Promise<string> {
  ws.send(JSON.stringify({ type: 'req', id, method: 'chat.send', params: { sessionKey, message } }))
  for (let i = 0; i < 50 && !responses.has(id); i++) await sleep(50)
  return responses.get(id)?.payload?.runId ?? ''
}

// The agent speaks straight into the IPC socket, so the test drives the exact
// frames a real channel-client would emit.
const sock = await Bun.connect({ unix: join(STATE, 'gateway.sock'), socket: { data() {}, error() {} } })
const reply = (runId: string, text: string, state = 'final') =>
  sock.write(JSON.stringify({ v: 1, t: 'reply', sessionKey, runId, state, text, name: 'Runner', emoji: '🏃' }) + '\n')

// ── Defect 1: back-to-back sends must not orphan the first run ───────────────
const run1 = await chatSend('s1', 'first message')
const run2 = await chatSend('s2', 'second message')
await sleep(200)

reply(run2, 'answer to two')
await sleep(400)
reply(run1, 'answer to one')
await sleep(600)

const forRun1 = chatEvents().filter(f => f.payload?.runId === run1)
const forRun2 = chatEvents().filter(f => f.payload?.runId === run2)

// ── Defect 2: a second reply in one run must not repeat seq 0 ────────────────
const run3 = await chatSend('s3', 'third message')
await sleep(200)
reply(run3, 'part one')
await sleep(400)
reply(run3, 'part two')
await sleep(600)
const forRun3 = chatEvents().filter(f => f.payload?.runId === run3)
const seqs3 = forRun3.map(f => f.payload?.seq)

// ── Defect 1, the part that actually bit: a run that never gets a reply must
// still reach the device as `aborted`. Keyed by sessionKey, the superseded run
// was gone from the map, so pruneActiveRuns could never abort it and the app
// spun on it forever.
const run4 = await chatSend('s4', 'fourth message')
const run5 = await chatSend('s5', 'fifth message — supersedes the fourth')
// Neither is ever answered. Wait out the (shortened) TTL plus a tick.
await sleep(2500)
const aborted = chatEvents().filter(f => f.payload?.state === 'aborted').map(f => f.payload?.runId)

const results: [string, boolean, string][] = [
  ['device paired and authenticated', helloOk, `frames=${received.length}`],
  ['agent client registered', cErr.includes('connected + registered'), cErr.split('\n').slice(-2).join(' | ')],
  ['two sends produced two distinct runIds', Boolean(run1) && Boolean(run2) && run1 !== run2, `${run1} / ${run2}`],
  ['the superseded run still delivers (not orphaned)', forRun1.length > 0,
    `${forRun1.length} event(s) for run1`],
  ['its text reached the device', forRun1.some(f => f.payload?.message?.content?.[0]?.text === 'answer to one'),
    JSON.stringify(forRun1.map(f => f.payload?.message?.content?.[0]?.text))],
  ['the newer run delivers too', forRun2.some(f => f.payload?.message?.content?.[0]?.text === 'answer to two'),
    `${forRun2.length} event(s) for run2`],
  ['replies are not cross-labelled between runs', forRun1.every(f => f.payload?.runId === run1),
    JSON.stringify(forRun1.map(f => f.payload?.runId))],
  ['two replies in one run both delivered', forRun3.length === 2, `${forRun3.length} event(s) for run3`],
  ['their seq numbers are distinct (no duplicate seq:0)', new Set(seqs3).size === seqs3.length,
    JSON.stringify(seqs3)],
  ['seq increments 0 then 1', JSON.stringify(seqs3) === '[0,1]', JSON.stringify(seqs3)],
  ['an unanswered superseded run is aborted, not orphaned', aborted.includes(run4),
    `aborted=${JSON.stringify(aborted)} run4=${run4}`],
  ['the run that superseded it is aborted too', aborted.includes(run5),
    `aborted=${JSON.stringify(aborted)} run5=${run5}`],
  ['an answered run is never aborted afterwards', !aborted.includes(run3),
    `aborted=${JSON.stringify(aborted)} run3=${run3}`],
]

console.log('\n=== issue #24 regression results ===')
let failed = 0
for (const [name, ok, detail] of results) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
}
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
if (failed > 0) console.log('\n--- daemon stderr ---\n' + dErr.slice(-3000))

try { ws.close() } catch {}
try { sock.end() } catch {}
try { client.kill() } catch {}
cleanup()
process.exit(failed === 0 ? 0 : 1)
