/**
 * Regression harness for issue #25.
 *
 * A channel client that CONNECTS but never answers its confirmation probe must still be
 * listed as reachable, keyed by its agentId. Before the fix, reachability was gated on
 * `confirmed`, so an agent that missed the probe fired at it during session boot was
 * omitted from the client list and surfaced only as a pin row named "(no channel)" —
 * despite sitting connected on the IPC socket, able to receive.
 *
 * Run: bun run test:reachability
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PLUGIN = process.argv[2] ?? join(import.meta.dir, '..')
const STATE = mkdtempSync(join(tmpdir(), 'clawvibe-reach-'))
const PORT = '8898'
const AGENT = 'silentagent'
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

let up = false
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) { up = true; break } } catch {}
  await sleep(100)
}
if (!up) { console.log('FATAL: daemon never came up\n' + dErr); process.exit(1) }

// A client that registers and then stays mute — the boot-race case. Its stdout is drained
// but never answered, so the probe is delivered and no reply ever comes back.
const client = Bun.spawn({
  cmd: ['bun', join(PLUGIN, 'dist/channel-client.js')],
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
})
let cOut = ''
let cErr = ''
void (async () => { for await (const ch of client.stdout as any) cOut += dec.decode(ch) })()
void (async () => { for await (const ch of client.stderr as any) cErr += dec.decode(ch) })()

// Wait for registration, then give the daemon room to probe and be ignored.
for (let i = 0; i < 50; i++) {
  if (cErr.includes('connected + registered')) break
  await sleep(100)
}
await sleep(1500)

const agents = await (await fetch(`http://127.0.0.1:${PORT}/agents`)).json() as {
  id: string; name: string; reachable: boolean
}[]

const row = agents.find(a => a.id === AGENT)
const probed = (cOut.match(/clawvibe:probe/g) ?? []).length
const results: [string, boolean, string][] = [
  ['client registered', cErr.includes('connected + registered'), cErr.split('\n').slice(-3).join(' | ')],
  ['probe was delivered and ignored', probed >= 1, `${probed} probe(s) seen on stdout`],
  ['unconfirmed client is listed', Boolean(row), JSON.stringify(agents)],
  ['listed row is reachable', row?.reachable === true, JSON.stringify(row)],
  ['row is keyed by agentId, not job id', row?.id === AGENT, JSON.stringify(row?.id)],
  ['name carries no "(no channel)" suffix', !(row?.name ?? '').includes('(no channel)'), JSON.stringify(row?.name)],
]

let failed = 0
for (const [label, ok, detail] of results) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failed++
}

client.kill()
daemon.kill()

if (failed > 0) {
  console.log(`\n${failed} check(s) failed\n--- daemon stderr ---\n${dErr}`)
  process.exit(1)
}
console.log('\nall reachability checks passed')
