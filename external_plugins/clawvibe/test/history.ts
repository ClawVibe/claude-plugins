/**
 * Regression harness for issue #44 — chat.history.
 *
 * The iOS app's reconnect backfill (branch issue/bug-325-reconnect-backfill)
 * has been calling `chat.history` against a gateway that answered
 * "unknown method" every time — six failures in a row after every re-auth, in
 * the daemon log. The client side was already written; only the server was
 * missing.
 *
 * Contract, from ChatHistoryParams + GatewayService.decodeHistoryTexts:
 *   request  { sessionKey, limit?, maxChars? }
 *   response permissive, but we answer { messages: [{ role, content:[{text}],
 *            timestamp, runId, seq }] } — the live chat event shape.
 *
 * Run: bun run test:history
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PLUGIN = process.argv[2] ?? join(import.meta.dir, '..')
const STATE = mkdtempSync(join(tmpdir(), 'clawvibe-history-'))
const PORT = '8896'
const AGENT = 'histagent'
const DEVICE = 'device-history-test'
const OTHER_DEVICE = 'device-someone-else'
const env = {
  ...process.env,
  CLAWVIBE_STATE_DIR: STATE, CLAWVIBE_PORT: PORT, CLAUDE_CODE_AGENT: AGENT,
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

const responses = new Map<string, any>()
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`)
ws.addEventListener('message', ev => {
  const frame = JSON.parse(String(ev.data))
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
  sock.write(JSON.stringify({ v: 1, t: 'reply', sessionKey, runId, state, text, name: 'Hist', emoji: '📜' }) + '\n')

async function rpc(id: string, method: string, params: Record<string, unknown>) {
  ws.send(JSON.stringify({ type: 'req', id, method, params }))
  for (let i = 0; i < 60 && !responses.has(id); i++) await sleep(50)
  return responses.get(id)
}

// ── Produce some history ─────────────────────────────────────────────────────
for (let i = 1; i <= 6; i++) { reply(`run-${i}`, `message ${i}`); await sleep(70) }
// A delta must not be recorded as a message of its own.
reply('run-delta', 'half a thou', 'delta')
await sleep(400)

const full = await rpc('h1', 'chat.history', { sessionKey, limit: 20, maxChars: 20000 })
const msgs = full?.payload?.messages ?? []
const texts = msgs.map((m: any) => m?.content?.[0]?.text)

const limited = await rpc('h2', 'chat.history', { sessionKey, limit: 2, maxChars: 20000 })
const limitedTexts = (limited?.payload?.messages ?? []).map((m: any) => m?.content?.[0]?.text)

// Each message is 9 chars ("message N"), so 20 chars fits two.
const capped = await rpc('h3', 'chat.history', { sessionKey, limit: 20, maxChars: 20 })
const cappedTexts = (capped?.payload?.messages ?? []).map((m: any) => m?.content?.[0]?.text)

const foreign = await rpc('h4', 'chat.history', {
  sessionKey: `agent:${AGENT}:clawvibe:app:${OTHER_DEVICE}`, limit: 20, maxChars: 20000,
})
const unknownSession = await rpc('h5', 'chat.history', { sessionKey: `agent:nobody:clawvibe:app:${DEVICE}` })
const noParams = await rpc('h6', 'chat.history', {})
const defaulted = await rpc('h7', 'chat.history', { sessionKey })

const first = msgs[0] ?? {}

const results: [string, boolean, string][] = [
  ['device paired and authenticated', helloOk, `ok=${helloOk}`],
  ['agent client registered', cErr.includes('connected + registered'), cErr.split('\n').slice(-2).join(' | ')],
  // The daemon reports "unknown method" in the RESPONSE, not on stderr — so
  // this has to be asserted against the frame the client actually receives.
  ['chat.history is no longer an unknown method',
    !String(full?.error?.message ?? '').includes('unknown method'),
    JSON.stringify(full?.error ?? 'none')],
  ['it answers ok', full?.ok === true, JSON.stringify(full?.error ?? full?.ok)],
  ['it returns the recorded messages', texts.join(',') === 'message 1,message 2,message 3,message 4,message 5,message 6',
    JSON.stringify(texts)],
  ['delta frames are not recorded as messages', !texts.includes('half a thou'), JSON.stringify(texts)],
  ['messages come back oldest-first', texts[0] === 'message 1', JSON.stringify(texts.slice(0, 2))],
  ['role is assistant', first.role === 'assistant', JSON.stringify(first.role)],
  ['content matches the live chat event shape', first?.content?.[0]?.type === 'text', JSON.stringify(first?.content)],
  ['timestamp is an ISO 8601 string', typeof first.timestamp === 'string' && !Number.isNaN(Date.parse(first.timestamp)),
    JSON.stringify(first.timestamp)],
  ['runId and seq are included for later dedupe', typeof first.runId === 'string' && typeof first.seq === 'number',
    JSON.stringify({ runId: first.runId, seq: first.seq })],
  ['limit truncates from the OLD end', limitedTexts.join(',') === 'message 5,message 6', JSON.stringify(limitedTexts)],
  ['maxChars is enforced, not just limit', cappedTexts.join(',') === 'message 5,message 6', JSON.stringify(cappedTexts)],
  ['a device cannot read another device\'s session', (foreign?.payload?.messages ?? []).length === 0,
    JSON.stringify(foreign?.payload)],
  ['the refusal is logged', dErr.includes('chat.history refused'),
    dErr.split('\n').filter(l => l.includes('refused')).slice(-1)[0] ?? 'none'],
  ['an unknown session is empty, not an error', unknownSession?.ok === true && (unknownSession?.payload?.messages ?? []).length === 0,
    JSON.stringify(unknownSession?.payload ?? unknownSession?.error)],
  ['a missing sessionKey is rejected', noParams?.ok === false, JSON.stringify(noParams?.error ?? noParams?.ok)],
  ['limit and maxChars default when omitted', (defaulted?.payload?.messages ?? []).length === 6,
    `${(defaulted?.payload?.messages ?? []).length} message(s)`],
]

console.log('\n=== issue #44 regression results ===')
let failed = 0
for (const [name, ok, detail] of results) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
}
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
if (failed > 0) console.log('\n--- daemon stderr ---\n' + dErr.slice(-4000))

try { ws.close() } catch {}
try { sock.end() } catch {}
try { client.kill() } catch {}
cleanup()
process.exit(failed === 0 ? 0 : 1)
