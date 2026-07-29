/**
 * Regression harness for issue #11.
 *   1. two clients sharing one agentId must COEXIST (no eviction storm)
 *   2. the confirmation probe must reach stdout (ordering fix: no "Not connected")
 *   3. a reply must confirm the agent, and listings must dedupe by agentId
 */
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PLUGIN = process.argv[2] ?? join(import.meta.dir, '..')
const STATE = mkdtempSync(join(tmpdir(), 'clawvibe-verify-'))
const PORT = '8899'
const env = { ...process.env, CLAWVIBE_STATE_DIR: STATE, CLAWVIBE_PORT: PORT, CLAUDE_CODE_AGENT: 'claude' }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const dec = new TextDecoder()

const daemon = Bun.spawn({ cmd: ['bun', join(PLUGIN, 'dist/gateway-daemon.js')], env, stdio: ['ignore', 'pipe', 'pipe'] })
let dErr = ''
void (async () => { for await (const c of daemon.stderr as any) dErr += dec.decode(c) })()

let up = false
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) { up = true; break } } catch {}
  await sleep(100)
}
if (!up) { console.log('FATAL: daemon never came up\n' + dErr); process.exit(1) }

type Client = { proc: any; out: string; err: string; name: string }
const clients: Client[] = []

function startClient(name: string): Client {
  const proc = Bun.spawn({ cmd: ['bun', join(PLUGIN, 'dist/channel-client.js')], env, stdio: ['pipe', 'pipe', 'pipe'] })
  const c: Client = { proc, out: '', err: '', name }
  void (async () => { for await (const ch of proc.stdout as any) c.out += dec.decode(ch) })()
  void (async () => { for await (const ch of proc.stderr as any) c.err += dec.decode(ch) })()
  return c
}

function send(c: Client, msg: unknown): void {
  c.proc.stdin.write(JSON.stringify(msg) + '\n')
  c.proc.stdin.flush?.()
}

function probeKeys(c: Client): string[] {
  const keys: string[] = []
  for (const line of c.out.split('\n')) {
    if (!line.trim()) continue
    try {
      const m = JSON.parse(line)
      if (m.method === 'notifications/claude/channel') {
        const k = m.params?.meta?.conversation_id
        if (typeof k === 'string') keys.push(k)
      }
    } catch {}
  }
  return keys
}

const rss = (): number => {
  try { return parseInt(readFileSync(`/proc/${daemon.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)![1], 10) } catch { return -1 }
}

// Two concurrent sessions of the SAME agent — the storm trigger.
clients.push(startClient('A'), startClient('B'))
await sleep(400)
// A real host sends initialize AFTER the client has already joined the gateway,
// so this reproduces the true ordering (probe may arrive pre-initialize).
for (const c of clients) {
  send(c, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '1' } } })
}
await sleep(300)
for (const c of clients) send(c, { jsonrpc: '2.0', method: 'notifications/initialized' })
await sleep(1500)

const rss1 = rss()
await sleep(4000)
const rss2 = rss()

const pkA = probeKeys(clients[0])
const pkB = probeKeys(clients[1])

// Answer A's probe through the real MCP tool path.
if (pkA.length > 0) {
  send(clients[0], { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'reply', arguments: { conversation_id: pkA[0], text: 'pong', name: 'Verified Agent', emoji: '🧪' } } })
}
await sleep(1200)
// `/agents` also carries pinned-but-unreachable sessions from the REAL machine's
// pin registry (~/.claude/jobs/pins.json is the runtime's file and is deliberately
// not redirected by CLAWVIBE_STATE_DIR). This regression is about confirmed clients,
// so scope the assertions to reachable rows.
const agentsAll = await (await fetch(`http://127.0.0.1:${PORT}/agents`)).json() as any[]
const agentsAfter = agentsAll.filter(a => a.reachable !== false)

// ── assertions ──────────────────────────────────────────────────────────────
const registers = (dErr.match(/agent registered/g) ?? []).length
const evictions = (dErr.match(/replacing stale client/g) ?? []).length
const notConnected = clients.reduce((n, c) => n + (c.err.match(/Not connected/g) ?? []).length, 0)
const probes = (dErr.match(/probing agent=/g) ?? []).length
const results: [string, boolean, string][] = [
  ['no eviction of a same-agentId peer', evictions === 0, `"replacing stale client" x${evictions}`],
  ['no register storm (exactly 2 registers)', registers === 2, `${registers} registers, ${probes} probes`],
  ['probe not lost to "Not connected"', notConnected === 0, `${notConnected} occurrences`],
  ['both clients received a probe', pkA.length >= 1 && pkB.length >= 1, `A=${pkA.length} B=${pkB.length}`],
  ['daemon heap stable', rss1 > 0 && rss2 - rss1 < 4096, `${rss1} -> ${rss2} kB over 4s`],
  ['reply confirmed exactly 1 agent (deduped)', agentsAfter.length === 1, JSON.stringify(agentsAfter)],
  ['identity came from the reply', agentsAfter[0]?.name === 'Verified Agent' && agentsAfter[0]?.emoji === '🧪', JSON.stringify(agentsAfter[0] ?? null)],
]

console.log('\n=== issue #11 regression results ===')
let failed = 0
for (const [name, ok, detail] of results) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
}

if (failed > 0) {
  console.log('\n--- daemon stderr ---\n' + dErr.slice(-3000))
  console.log('\n--- client A stderr ---\n' + clients[0].err.slice(-2000))
}

for (const c of clients) c.proc.kill()
daemon.kill()
await sleep(200)
console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
