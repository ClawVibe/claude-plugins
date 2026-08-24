/**
 * Regression harness for issue #29.
 *
 * An agent must be able to message a device with NO active run — i.e. when the
 * user has not messaged that agent in the last five minutes, or ever.
 *
 * Before the fix, `reply` looked the sessionKey up in `activeRuns` (populated
 * only by a device's own `chat.send`, pruned after a 5-minute TTL) and returned
 * early when it found nothing. The message was discarded at the daemon and
 * never reached the device, while the fire-and-forget reply told the agent
 * "sent" — invisible on both sides.
 *
 * The sessionKey already names its device ("agent:<id>:clawvibe:app:<deviceId>"),
 * so routing never actually needed the run.
 *
 * Run: bun run test:unprompted
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PLUGIN = process.argv[2] ?? join(import.meta.dir, '..')
const STATE = mkdtempSync(join(tmpdir(), 'clawvibe-unprompted-'))
const PORT = '8899'
const AGENT = 'pushyagent'
const DEVICE = 'device-unprompted-test'
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

// Speak straight into the IPC socket: no chat.send has ever happened for this
// session key, so activeRuns is guaranteed empty. This is the cold-start case.
const sessionKey = `agent:${AGENT}:clawvibe:app:${DEVICE}`
const UNIQUE = 'unprompted-hello-42'
const sock = await Bun.connect({
  unix: join(STATE, 'gateway.sock'),
  socket: { data() {}, error() {} },
})
sock.write(JSON.stringify({
  v: 1, t: 'reply', sessionKey, state: 'final', text: UNIQUE,
  name: 'Pushy', emoji: '📣',
}) + '\n')
await sleep(1200)

const chatEvents = received.filter(f => f.type === 'event' && f.event === 'chat')
const delivered = chatEvents.find(f => f.payload?.message?.content?.[0]?.text === UNIQUE)
  ?? chatEvents.find(f => JSON.stringify(f.payload ?? {}).includes(UNIQUE))

const results: [string, boolean, string][] = [
  ['device paired and authenticated', helloOk, `frames=${received.length}`],
  ['agent client registered', cErr.includes('connected + registered'), cErr.split('\n').slice(-2).join(' | ')],
  ['daemon did NOT report unknown session', !dErr.includes('reply for unknown session'),
    dErr.split('\n').filter(l => l.includes('unknown session')).join(' | ') || 'none'],
  ['daemon logged the unprompted delivery', dErr.includes('unprompted reply for'),
    dErr.split('\n').filter(l => l.includes('unprompted')).join(' | ') || 'none'],
  ['device received a chat event', chatEvents.length > 0, `${chatEvents.length} chat event(s)`],
  ['the unprompted text reached the device', Boolean(delivered),
    JSON.stringify(delivered?.payload ?? chatEvents[0]?.payload ?? null)?.slice(0, 300) ?? 'nothing'],
  ['it carried the right sessionKey', delivered?.payload?.sessionKey === sessionKey,
    JSON.stringify(delivered?.payload?.sessionKey)],
]

console.log('\n=== issue #29 regression results ===')
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
