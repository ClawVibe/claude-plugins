/**
 * Regression harness for issue #55: only the first reply per turn reached the phone.
 *
 * The iOS app's sessionKey is "agent:<id>:clawvibe:app:<conversation UUID>", but
 * the device authenticates as "device-<hex>". The first reply ('final') closed
 * the run; later replies fell back to deviceIdFromSessionKey, got the UUID, and
 * were queued for a device that does not exist. chat.history refused the real
 * owner for the same reason.
 *
 * Run: bun run test:multireply
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PLUGIN = process.argv[2] ?? join(import.meta.dir, '..')
const STATE = mkdtempSync(join(tmpdir(), 'clawvibe-multireply-'))
const PORT = '8898'
const AGENT = 'multiagent'
const DEVICE = 'device-multireply-test'
const env = { ...process.env, CLAWVIBE_STATE_DIR: STATE, CLAWVIBE_PORT: PORT, CLAUDE_CODE_AGENT: AGENT }
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
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`)
let helloOk = false
ws.addEventListener('message', ev => {
  const frame = JSON.parse(String(ev.data))
  received.push(frame)
  if (frame.type === 'res' && frame.ok) helloOk = true
})
await new Promise<void>((res, rej) => {
  ws.addEventListener('open', () => res())
  ws.addEventListener('error', e => rej(e))
  setTimeout(() => rej(new Error('ws open timeout')), 5000)
})
ws.send(JSON.stringify({
  type: 'req', id: 'c1', method: 'connect',
  params: {
    auth: { bootstrapToken },
    device: { deviceId: DEVICE },
    client: { clientDisplayName: 'test device' },
  },
}))
for (let i = 0; i < 50 && !helloOk; i++) await sleep(100)

// ── Register an agent client, then have it reply out of the blue ─────────────
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

// The iOS app's sessionKey carries its own conversation UUID, NOT the deviceId.
const CONV = '1898385E-C735-4540-B2CB-2E9F1A28CC4A'
const sessionKey = `agent:${AGENT}:clawvibe:app:${CONV}`
ws.send(JSON.stringify({
  type: 'req', id: 's1', method: 'chat.send',
  params: { sessionKey, message: 'hello, reply three times' },
}))
await sleep(500)

const sock = await Bun.connect({
  unix: join(STATE, 'gateway.sock'),
  socket: { data() {}, error() {} },
})
const TEXTS = ['multi-ack-1', 'multi-full-2', 'multi-extra-3']
for (const text of TEXTS) {
  // No runId, state 'final' each time: the first one closes the run, exactly
  // as the plugin's reply tool behaves.
  sock.write(JSON.stringify({ v: 1, t: 'reply', sessionKey, state: 'final', text, name: 'Multi', emoji: '🔁' }) + '\n')
  await sleep(300)
}
await sleep(800)

const historyRes = new Promise<any>(res => {
  ws.addEventListener('message', ev => {
    const f = JSON.parse(String(ev.data))
    if (f.type === 'res' && f.id === 'h1') res(f)
  })
  setTimeout(() => res(null), 3000)
})
ws.send(JSON.stringify({ type: 'req', id: 'h1', method: 'chat.history', params: { sessionKey } }))
const history = await historyRes

const chatEvents = received.filter(f => f.type === 'event' && f.event === 'chat')
const got = (t: string) => chatEvents.some(f => JSON.stringify(f.payload ?? {}).includes(t))
let persisted: Record<string, string> = {}
try { persisted = JSON.parse(await Bun.file(join(STATE, 'session-devices.json')).text()) } catch {}
const histText = JSON.stringify(history?.payload ?? {})

const results: [string, boolean, string][] = [
  ['device paired and authenticated', helloOk, `frames=${received.length}`],
  ['agent client registered', cErr.includes('connected + registered'), cErr.split('\n').slice(-2).join(' | ')],
  ...TEXTS.map((t, i) => [`reply ${i + 1} of ${TEXTS.length} reached the device`, got(t), t] as [string, boolean, string]),
  ['nothing queued for a phantom device', !dErr.includes(`device ${CONV}`),
    dErr.split('\n').filter(l => l.includes(CONV) && l.includes('device ')).join(' | ') || 'none'],
  ['chat.history not refused for the real owner', !dErr.includes('chat.history refused'),
    dErr.split('\n').filter(l => l.includes('refused')).join(' | ') || 'none'],
  ['chat.history returns the later replies', histText.includes('multi-extra-3'), histText.slice(0, 200)],
  ['session->device mapping persisted', persisted[sessionKey] === DEVICE, JSON.stringify(persisted)],
]

console.log('\n=== multi-reply routing regression results ===')
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
