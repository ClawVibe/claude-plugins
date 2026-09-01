/**
 * Regression tests for targeted agent restart (#51).
 *
 * The failure these pin down is collateral damage: `agents restart` used to be the only
 * way to reload one agent's definition, and it stops the whole fleet and the gateway to
 * do it. The targeted form must touch ONLY the named agents — every other clawvibe-*
 * session has to survive untouched — and must refuse an unknown id BEFORE it stops
 * anything, so a typo can never leave an agent down.
 *
 * The CLI is driven as a real subprocess against a throwaway HOME/state dir, with a
 * `claude` shim on PATH standing in for the runtime. Nothing real is started or stopped.
 *
 *   bun run test:restart
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const CLI = join(import.meta.dir, '..', 'cli.ts')
const root = mkdtempSync(join(tmpdir(), 'cv-restart-'))
const HOME = join(root, 'home')
const STATE = join(root, 'state')
const BIN = join(root, 'bin')
const SESSIONS = join(root, 'sessions.json')
const LOG = join(root, 'shim.log')

const AGENTS = ['spongebob', 'patrick', 'nemo', 'rovo']

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

/**
 * Stand-in for the `claude` CLI: a roster it can list, stop and add to, plus a log of
 * every call. Only the three shapes cli.ts uses are implemented; anything else is a
 * loud failure rather than a silent success, so a change in how agents are launched
 * shows up here instead of passing vacuously.
 */
function writeShim(): void {
  mkdirSync(BIN, { recursive: true })
  const shim = `#!/usr/bin/env bun
import { readFileSync, writeFileSync, appendFileSync } from 'fs'
const SESSIONS = ${JSON.stringify(SESSIONS)}
const LOG = ${JSON.stringify(LOG)}
const args = process.argv.slice(2)
const read = () => JSON.parse(readFileSync(SESSIONS, 'utf8'))
const write = (s) => writeFileSync(SESSIONS, JSON.stringify(s))
if (args[0] === 'agents' && args[1] === '--json') { console.log(JSON.stringify(read())); process.exit(0) }
if (args[0] === 'stop') {
  appendFileSync(LOG, 'stop ' + args[1] + '\\n')
  write(read().filter((s) => s.id !== args[1]))
  process.exit(0)
}
const i = args.indexOf('--name')
if (i >= 0) {
  const name = args[i + 1]
  appendFileSync(LOG, 'start ' + name + '\\n')
  const s = read(); s.push({ id: 'new-' + name, name }); write(s)
  process.exit(0)
}
appendFileSync(LOG, 'UNEXPECTED ' + args.join(' ') + '\\n')
process.exit(1)
`
  const p = join(BIN, 'claude')
  writeFileSync(p, shim)
  chmodSync(p, 0o755)
}

function reset(): void {
  mkdirSync(HOME, { recursive: true })
  mkdirSync(STATE, { recursive: true })
  writeFileSync(SESSIONS, JSON.stringify(AGENTS.map(id => ({ id: `sess-${id}`, name: `clawvibe-${id}` }))))
  writeFileSync(LOG, '')
  writeFileSync(join(STATE, 'managed-agents.json'), JSON.stringify(AGENTS.map(id => ({ id }))))
}

async function cli(args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn({
    cmd: ['bun', CLI, ...args],
    cwd: HOME,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      HOME,
      PATH: `${BIN}:${process.env.PATH}`,
      CLAWVIBE_STATE_DIR: STATE,
      CLAUDE_CONFIG_DIR: join(HOME, '.claude'),
      // Nothing should ever answer here; a targeted restart must not consult the gateway.
      CLAWVIBE_PORT: '8999',
    },
  })
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text())
  return { code: await p.exited, out }
}

const log = () => readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean)
const sessionNames = () => (JSON.parse(readFileSync(SESSIONS, 'utf8')) as any[]).map(s => s.name).sort()
const pausedIds = (): string[] => {
  const p = join(STATE, 'paused.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as string[] : []
}

// ── 1. unknown id is rejected before anything is stopped ─────────────────────
writeShim()
reset()
{
  const { code, out } = await cli(['agents', 'restart', 'rovo', 'nope'])
  check('unknown id fails', code === 1, `code=${code}`)
  check('unknown id is named', out.includes('nope'))
  check('nothing was stopped', log().filter(l => l.startsWith('stop')).length === 0, log().join(' | '))
  check('all agents still running', sessionNames().length === AGENTS.length)
}

// ── 2. targeted restart touches only the named agent ─────────────────────────
reset()
{
  const { code } = await cli(['agents', 'restart', 'rovo'])
  const l = log()
  check('targeted restart succeeds', code === 0)
  check('stopped exactly one session', l.filter(x => x.startsWith('stop')).length === 1, l.join(' | '))
  check('stopped rovo', l.includes('stop sess-rovo'))
  check('started rovo again', l.includes('start clawvibe-rovo'))
  check('started nothing else', l.filter(x => x.startsWith('start')).length === 1, l.join(' | '))
  check('fleet intact', sessionNames().join(',') === AGENTS.map(a => `clawvibe-${a}`).sort().join(','))
  check('rovo is not left paused', !pausedIds().includes('rovo'), JSON.stringify(pausedIds()))
}

// ── 3. several ids at once, and the singular alias ───────────────────────────
reset()
{
  await cli(['agents', 'restart', 'rovo', 'nemo'])
  const l = log()
  check('two stopped', l.filter(x => x.startsWith('stop')).length === 2, l.join(' | '))
  check('two started', l.filter(x => x.startsWith('start')).length === 2, l.join(' | '))
  check('spongebob untouched', !l.some(x => x.includes('spongebob')))
}
reset()
{
  const { code } = await cli(['agent', 'restart', 'nemo'])
  check('singular alias works', code === 0 && log().includes('stop sess-nemo'), log().join(' | '))
}
{
  const { code } = await cli(['agent', 'restart'])
  check('singular alias needs an id', code === 1)
}

// ── 4. targeted down stops only that agent and leaves it paused ──────────────
reset()
{
  const { code } = await cli(['agents', 'down', 'patrick'])
  check('targeted down succeeds', code === 0)
  check('only patrick stopped', log().join(',') === 'stop sess-patrick', log().join(' | '))
  check('patrick recorded as paused', pausedIds().join(',') === 'patrick', JSON.stringify(pausedIds()))
}

// ── 5. no ids still means the whole fleet ────────────────────────────────────
reset()
{
  await cli(['agents', 'down'])
  check('bare down stops everything', log().filter(x => x.startsWith('stop')).length === AGENTS.length, log().join(' | '))
}
reset()
{
  await cli(['agents', 'up'])
  check('bare up is idempotent', log().length === 0, log().join(' | '))
}

console.log(failures === 0 ? '\nall passed' : `\n${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
