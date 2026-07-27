#!/usr/bin/env bun
/**
 * ClawVibe automation CLI (the verbs beyond `qr`, which stays in qr.py).
 *
 *   clawvibe setup [--apply-tailscale]   one-shot: deps, tailscale check, link, agents up, service
 *   clawvibe agent add <id> [--emoji E] [--model M] [--prompt P]
 *   clawvibe agent rm <id> [--purge]
 *   clawvibe agent list
 *   clawvibe agents up                   idempotently start every configured agent
 *   clawvibe agents restart              down + stop the gateway daemon + up (use after a plugin upgrade)
 *   clawvibe agents down                 stop all clawvibe-* sessions
 *   clawvibe doctor                      diagnose install/ingress/agent problems
 *   clawvibe install-service             systemd --user unit that runs `agents up` at login/boot
 *
 * Managed-agent config: $CLAWVIBE_STATE_DIR/managed-agents.json = [{ id, model? }]
 * Agent identity/persona: ~/.claude/agents/<id>.md — the gateway never reads it; the
 * agent reports its own name/emoji on every `reply` (see channel-client instructions).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, unlinkSync, lstatSync, readdirSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { STATE_DIR, PORT, PID_FILE, SOCK_FILE } from './shared/access.ts'
import { syncPins, readPins } from './shared/pins.ts'

const PLUGIN_DIR = import.meta.dir
const AGENTS_DIR = join(homedir(), '.claude', 'agents')
const CONFIG = join(STATE_DIR, 'managed-agents.json')
// Desired state, distinct from liveness. `agents down` is an operator decision that a
// keep-alive loop must not undo, so it is recorded here as well as unpinned. (Unpinning
// alone is not enough in the other direction either: the runtime's own 60s sweep
// respawns pinned-but-stale sessions, so "stay down" is a two-place write.)
const PAUSED = join(STATE_DIR, 'paused.json')
const LOCAL_BIN = join(homedir(), '.local', 'bin', 'clawvibe')
const UNIT_PATH = join(homedir(), '.config', 'systemd', 'user', 'clawvibe-agents.service')
const CHANNEL = 'plugin:clawvibe@clawvibe-plugins'
const REPLY_TOOLS = ['mcp__plugin_clawvibe_clawvibe__reply', 'mcp__plugin_clawvibe_clawvibe__edit_message']
// The "never finished" wording is load-bearing, not politeness. Claude Code's bg daemon
// reaps sessions it considers SETTLED after an idle TTL; a session that is waiting for
// input is never a candidate. Two agents on this same seed diverged — one ended a turn
// reporting "both replies sent" (settled → reaped ~60 min later), the other "standing by
// for ClawVibe device message" (survived indefinitely). Pinning covers the settled case,
// but keeping the agent in a waiting state is what makes survival deterministic.
const SEED = 'You are online as a ClawVibe channel agent. Wait for device messages; when one arrives, reply to it using the clawvibe reply tool, then go straight back to waiting. This is a standing assignment, not a task: you are never finished, so always end your turn standing by rather than reporting your work complete. Take no other action while waiting.'

type ManagedAgent = { id: string; model?: string }

const C = { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, ok: (s: string) => `\x1b[32m${s}\x1b[0m`, warn: (s: string) => `\x1b[33m${s}\x1b[0m`, err: (s: string) => `\x1b[31m${s}\x1b[0m` }

function readConfig(): ManagedAgent[] {
  try { return JSON.parse(readFileSync(CONFIG, 'utf8')) as ManagedAgent[] } catch { return [] }
}
function writeConfig(a: ManagedAgent[]): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(CONFIG, JSON.stringify(a, null, 2))
}

/**
 * Identity that must never be inherited by a spawned agent.
 *
 * An inherited env var can only tell you what the PARENT was, never what you are. If
 * `clawvibe agents up` is itself run from inside a Claude session (which is normal — a
 * session, a hook, or the gateway daemon, which inherits the env of whichever client
 * spawned it), these leak into every agent we launch. `--agent` currently wins, but
 * relying on that is exactly the assumption that produced the register/eviction storm,
 * where CLAUDE_CODE_AGENT was treated as a session identity it never was. Scrub rather
 * than assume; the leak can also originate from a sibling's launch, not ours.
 */
const INHERITED_IDENTITY_VARS = ['CLAUDE_CODE_AGENT', 'CLAWVIBE_AGENT_ID', 'CLAUDE_CODE_SESSION_ID']

function scrubbedEnv(): Record<string, string | undefined> {
  const env = { ...process.env }
  for (const k of INHERITED_IDENTITY_VARS) delete env[k]
  return env
}

async function sh(cmd: string[], cwd?: string, env?: Record<string, string | undefined>): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn({ cmd, stdout: 'pipe', stderr: 'pipe', ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) })
  const out = await new Response(p.stdout).text()
  const err = await new Response(p.stderr).text()
  const code = await p.exited
  return { code, out, err }
}

/** name → session, for background sessions reported by `claude agents --json`. */
async function runningByName(): Promise<Record<string, any>> {
  const { out } = await sh(['claude', 'agents', '--json'])
  try {
    const arr = JSON.parse(out) as any[]
    const m: Record<string, any> = {}
    for (const s of arr) if (s?.name) m[s.name] = s
    return m
  } catch { return {} }
}

/**
 * Resolve a just-launched session's short id from the roster by its stable `--name`.
 *
 * Deliberately NOT parsed from `claude --bg` stdout: that line is undocumented,
 * ANSI-coloured, and free to change, and mis-parsing it means every keep-alive tick
 * sees a dead id and destructively replaces a live agent. The roster is structured and
 * version-independent. It is written asynchronously though, so poll briefly; and a
 * duplicate name must be an error, not a coin flip — adopting the wrong session is a
 * worse failure than not resolving at all.
 */
async function resolveIdByName(name: string, tries = 6): Promise<string | undefined> {
  for (let i = 0; i < tries; i++) {
    const { out } = await sh(['claude', 'agents', '--json'])
    try {
      const matches = (JSON.parse(out) as any[]).filter(s => s?.name === name && s?.id)
      if (matches.length > 1) {
        console.log(C.err(`    ambiguous: ${matches.length} sessions named "${name}" — refusing to guess`))
        return undefined
      }
      if (matches.length === 1) return matches[0].id as string
    } catch { /* roster not ready or malformed — retry */ }
    await new Promise(r => setTimeout(r, 200 * (i + 1)))
  }
  return undefined
}

function readPaused(): string[] {
  try {
    const v = JSON.parse(readFileSync(PAUSED, 'utf8')) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

function writePaused(ids: string[]): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(PAUSED, JSON.stringify([...new Set(ids)], null, 2))
  } catch (err) { console.log(C.err(`  could not record paused state: ${err}`)) }
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++ } else flags[key] = true
    } else positional.push(a)
  }
  return { positional, flags }
}

// ── agent add/rm/list ─────────────────────────────────────────────────────────

function agentDefPath(id: string): string { return join(AGENTS_DIR, `${id}.md`) }

function writeAgentDef(id: string, name: string | undefined, emoji: string | undefined, prompt: string | undefined): boolean {
  const path = agentDefPath(id)
  if (existsSync(path)) return false
  mkdirSync(AGENTS_DIR, { recursive: true })
  const display = name || id
  const em = emoji || '🤖'
  // Frontmatter `name` must equal the id (routing/--agent). The gateway never
  // reads this file — identity reaches the app via the agent's replies — so the
  // display name + emoji are baked into the BODY (the system prompt) instead, so
  // the agent reports them on every reply.
  const fm = ['---', `name: ${id}`, `description: ${display} — ClawVibe channel agent.`, '---', '']
  const persona = prompt ?? `You are ${display}, reachable over the ClawVibe mobile app. Keep replies brief and in character.`
  const channel =
    `\n\n## ClawVibe channel\n` +
    `Your display name is "${display}" and your emoji is ${em}. On EVERY \`reply\`, set the \`name\` ("${display}") and \`emoji\` (${em}) parameters.\n` +
    `When a device message arrives (a \`<channel source="clawvibe" conversation_id="...">\` tag), reply to it with the \`reply\` tool using that conversation_id. Take no other action unless asked.\n` +
    `After replying, return to standing by. You are a long-lived channel agent, never a finished task — do not report your work as complete, or the runtime will reclaim this session and you will drop out of the app.\n`
  writeFileSync(path, fm.join('\n') + persona + channel)
  return true
}

function cmdAgentAdd(args: string[]): number {
  const { positional, flags } = parseFlags(args)
  const id = positional[0]
  if (!id) { console.error('usage: clawvibe agent add <id> [--name "Friendly Name"] [--emoji E] [--model M] [--prompt P]'); return 1 }
  const created = writeAgentDef(id, flags.name as string | undefined, flags.emoji as string | undefined, flags.prompt as string | undefined)
  const cfg = readConfig()
  if (!cfg.find(a => a.id === id)) {
    cfg.push({ id, ...(flags.model ? { model: flags.model as string } : {}) })
    writeConfig(cfg)
  }
  console.log(C.ok(`✓ agent "${id}" configured`) + (created ? ` (wrote ${agentDefPath(id)})` : C.dim(` (definition already existed)`)))
  console.log(C.dim(`  run \`clawvibe agents up\` to start it`))
  return 0
}

function cmdAgentRm(args: string[]): number {
  const { positional, flags } = parseFlags(args)
  const id = positional[0]
  if (!id) { console.error('usage: clawvibe agent rm <id> [--purge]'); return 1 }
  writeConfig(readConfig().filter(a => a.id !== id))
  if (flags.purge && existsSync(agentDefPath(id))) { rmSync(agentDefPath(id)); console.log(C.dim(`  removed ${agentDefPath(id)}`)) }
  console.log(C.ok(`✓ agent "${id}" unconfigured`) + C.dim(`  (run \`clawvibe agents down\` or stop \`clawvibe-${id}\` to halt a running one)`))
  return 0
}

async function cmdAgentList(): Promise<number> {
  const cfg = readConfig()
  if (cfg.length === 0) { console.log(C.dim('no managed agents — add one with `clawvibe agent add <id>`')); return 0 }
  const running = await runningByName()
  let registered: Set<string> = new Set()
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/agents`, { signal: AbortSignal.timeout(2000) })
    registered = new Set((await r.json() as any[]).map(a => a.id))
  } catch {}
  const pins = new Set(await readPins())
  const paused = new Set(readPaused())
  console.log(`managed agents (${cfg.length}):`)
  for (const a of cfg) {
    const sess = running[`clawvibe-${a.id}`]
    const run = sess ? C.ok('running') : (paused.has(a.id) ? C.dim('paused') : C.warn('stopped'))
    const reg = registered.has(a.id) ? C.ok('registered') : C.dim('not registered')
    // Unpinned + running is the silent failure: fine now, gone in ~1h.
    const pin = sess ? (pins.has(sess.id) ? C.ok('pinned') : C.err('UNPINNED — will idle-stop')) : C.dim('—')
    console.log(`  ${a.id}${a.model ? C.dim(' [' + a.model + ']') : ''}  ${run}  ${reg}  ${pin}`)
  }
  return 0
}

// ── agents up/down ──────────────────────────────────────────────────────────

async function cmdAgentsUp(): Promise<number> {
  const cfg = readConfig()
  if (cfg.length === 0) { console.log(C.dim('no managed agents configured')); return 0 }
  const running = await runningByName()
  let started = 0, skipped = 0
  const toPin: string[] = []
  for (const a of cfg) {
    const name = `clawvibe-${a.id}`
    const live = running[name]
    if (live) {
      // Already up — but it may predate pinning, or have been unpinned by `agents down`.
      // Pin maintenance belongs in the spawn path, so make it idempotent here too.
      skipped++
      if (live.id) toPin.push(live.id)
      console.log(C.dim(`  ${a.id}: already running`))
      continue
    }
    const cmd = [
      'claude', '--bg', '--channels', CHANNEL, '--agent', a.id,
      // `auto`, not `acceptEdits`: a channel agent runs unattended, so there is nobody
      // to answer a prompt. Valid modes on 2.1.220 are acceptEdits | auto |
      // bypassPermissions | manual | dontAsk | plan — verified against the CLI before
      // changing, since an invalid launch flag makes every spawn fail silently.
      '--permission-mode', 'auto', '--allowed-tools', ...REPLY_TOOLS,
      ...(a.model ? ['--model', a.model] : []),
      '--name', name, SEED,
    ]
    // Launch from $HOME (a trusted dir) so the bg session doesn't block on a
    // directory-trust prompt; a channel agent has no project-specific cwd.
    // Identity vars are scrubbed so the new agent cannot inherit ours.
    const { code, err } = await sh(cmd, homedir(), scrubbedEnv())
    if (code !== 0) { console.log(C.err(`  ${a.id}: failed (${err.trim().slice(0, 120)})`)); continue }
    started++
    const id = await resolveIdByName(name)
    if (id) { toPin.push(id); console.log(C.ok(`  ${a.id}: started`) + C.dim(` (${id})`)) }
    else console.log(C.ok(`  ${a.id}: started`) + C.warn(' (id unresolved — will not be pinned, so it will idle-stop in ~1h)'))
  }

  // Pin last, in one locked read-modify-write, so a slow/contended pins.json costs
  // one lock acquisition rather than one per agent. Best-effort: never fails the command.
  if (toPin.length > 0) await syncPins({ add: toPin })

  // Explicitly bringing agents up clears any operator "stay down" decision.
  const stillPaused = readPaused().filter(id => !cfg.some(a => a.id === id))
  if (stillPaused.length !== readPaused().length) writePaused(stillPaused)

  console.log(`agents up — ${started} started, ${skipped} already running, ${toPin.length} pinned`)
  return 0
}

async function cmdAgentsDown(): Promise<number> {
  const running = await runningByName()
  let stopped = 0
  const toUnpin: string[] = []
  const paused = new Set(readPaused())
  for (const [name, sess] of Object.entries(running)) {
    if (!name.startsWith('clawvibe-')) continue
    await sh(['claude', 'stop', sess.id])
    stopped++
    if (sess.id) toUnpin.push(sess.id)
    paused.add(name.slice('clawvibe-'.length))
    console.log(C.dim(`  stopped ${name}`))
  }
  // Unpinning is not optional here: a pinned session is respawned by the runtime's own
  // 60s sweep, so stopping without unpinning means it comes straight back.
  if (toUnpin.length > 0) await syncPins({ remove: toUnpin })
  writePaused([...paused])
  console.log(`agents down — ${stopped} stopped, ${toUnpin.length} unpinned (daemon lingers)`)
  return 0
}

// ── agents restart (the upgrade path) ────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function pluginVersion(): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: string }).version
  } catch { return undefined }
}

async function daemonHealth(): Promise<{ up: boolean; version?: string }> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) })
    if (!r.ok) return { up: false }
    return { up: true, version: (await r.json() as { version?: string }).version }
  } catch { return { up: false } }
}

/**
 * Stop the gateway daemon and CONFIRM the port is free.
 *
 * This is the whole reason `agents restart` exists. The daemon deliberately lingers
 * across agent restarts (so pairing keeps working), and it is a singleton guarded by
 * the port — so a *newer* daemon exits(0) on EADDRINUSE rather than taking over. After
 * a plugin upgrade that means `agents down && agents up` silently reattaches the new
 * clients to the OLD daemon bundle, and /health keeps reporting the previous version.
 * Confirming the port is actually free is therefore load-bearing, not politeness.
 */
async function stopDaemon(): Promise<void> {
  let pid = 0
  try { pid = parseInt(readFileSync(PID_FILE, 'utf8'), 10) } catch { /* no pid file */ }
  if (Number.isInteger(pid) && pid > 1) {
    try { process.kill(pid, 'SIGTERM'); console.log(C.dim(`  stopping gateway daemon pid=${pid}`)) } catch { /* already gone */ }
  } else if ((await daemonHealth()).up) {
    console.log(C.warn(`  a gateway is answering on :${PORT} but ${PID_FILE} is missing — cannot identify it`))
  }

  for (let i = 0; i < 20 && (await daemonHealth()).up; i++) await sleep(250)

  if ((await daemonHealth()).up && pid > 1) {
    console.log(C.warn('  daemon ignored SIGTERM — sending SIGKILL'))
    try { process.kill(pid, 'SIGKILL') } catch {}
    for (let i = 0; i < 12 && (await daemonHealth()).up; i++) await sleep(250)
  }

  const left = await daemonHealth()
  if (left.up) {
    // Not necessarily ours: another state dir, user, or container can own :8791.
    console.log(C.err(`  ⚠ something is STILL serving :${PORT} (version ${left.version ?? '?'}) — agents will attach to it, not to a fresh daemon`))
  } else {
    try { if (existsSync(SOCK_FILE)) unlinkSync(SOCK_FILE) } catch {}
    try { if (existsSync(PID_FILE)) rmSync(PID_FILE) } catch {}
    console.log(C.dim('  gateway stopped'))
  }
}

async function cmdAgentsRestart(): Promise<number> {
  console.log('agents restart:')
  await cmdAgentsDown()
  await stopDaemon()
  const rc = await cmdAgentsUp()

  // The daemon is spawned by the first agent client, so give it a moment, then check
  // that the version now serving matches the plugin this CLI was run from. A mismatch
  // is the stale-daemon trap above and is worth shouting about.
  for (let i = 0; i < 20 && !(await daemonHealth()).up; i++) await sleep(250)
  const h = await daemonHealth()
  const want = pluginVersion()
  if (!h.up) console.log(C.warn(`  no gateway on :${PORT} yet — it spawns with the first agent client`))
  else if (want && h.version !== want) {
    // The daemon is spawned by a channel CLIENT, which comes from the plugin Claude Code
    // has installed — not from wherever this CLI was run. So a mismatch means one of:
    //   1. a stale daemon still owns the port (the newer one exit(0)'d on EADDRINUSE), or
    //   2. the installed plugin is a different version than this CLI (e.g. running a dev
    //      checkout, or `claude plugin update` hasn't been run yet).
    console.log(C.err(`  ⚠ gateway is serving ${h.version} but this CLI ships ${want}`))
    console.log(C.dim(`     either a stale daemon owns :${PORT}, or the installed plugin isn't ${want} yet`))
    console.log(C.dim(`     check: claude plugin list | grep clawvibe`))
    return 1
  } else console.log(C.ok(`  gateway ${h.version ?? '?'} ✓`))
  return rc
}

// ── doctor ────────────────────────────────────────────────────────────────────

type Check = { label: string; level: 'ok' | 'warn' | 'fail' | 'info'; detail: string; fix?: string }

/** Newest installed plugin version dir, for spotting a stale CLI symlink. */
function newestInstalledDir(): string | undefined {
  const base = join(homedir(), '.claude', 'plugins', 'cache', 'clawvibe-plugins', 'clawvibe')
  try {
    const dirs = readdirSync(base).filter(d => /^\d+\.\d+\.\d+$/.test(d))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    return dirs.length ? join(base, dirs[dirs.length - 1]) : undefined
  } catch { return undefined }
}

async function tailscaleState(): Promise<Check> {
  const { code, out } = await sh(['tailscale', 'serve', 'status', '--json'])
  if (code !== 0) return { label: 'tailscale ingress', level: 'info', detail: 'tailscale unavailable — fine for localhost-only use' }
  let tcp: any = {}, web: Record<string, unknown> = {}
  try { const j = JSON.parse(out); tcp = (j.TCP ?? {})[String(PORT)] ?? {}; web = j.Web ?? {} } catch {}
  if (tcp.TCPForward && tcp.TerminateTLS) {
    return { label: 'tailscale ingress', level: 'ok', detail: `TLS-terminated TCP :${PORT} → ${tcp.TCPForward}` }
  }
  const hasWeb = Object.keys(web).some(k => k.includes(`:${PORT}`))
  return {
    label: 'tailscale ingress',
    level: 'fail',
    detail: hasWeb
      ? `:${PORT} is an --https WEB PROXY (HTTP/2) — WebSockets will connect then drop with code 1006`
      : `:${PORT} has no TLS-terminated TCP forward — the app cannot reach this gateway over the tailnet`,
    fix: `sudo tailscale serve --https=${PORT} off && sudo tailscale serve --bg --tls-terminated-tcp=${PORT} tcp://localhost:${PORT}`,
  }
}

/**
 * One-shot diagnostic. Exists because every failure this plugin has produced in the
 * field is silent: no CLI on PATH, a stale daemon serving an old bundle, an --https
 * Tailscale proxy that pairs fine then drops, an agent that is running but UNPINNED,
 * or one that reported itself done and got reaped. Each is invisible individually and
 * obvious in a list, so print the list.
 */
async function cmdDoctor(): Promise<number> {
  const checks: Check[] = []
  const version = pluginVersion()

  checks.push({ label: 'plugin', level: 'info', detail: `${version ?? '?'} at ${PLUGIN_DIR}` })
  const bundleOk = existsSync(join(PLUGIN_DIR, 'dist', 'channel-client.js')) && existsSync(join(PLUGIN_DIR, 'dist', 'gateway-daemon.js'))
  checks.push({ label: 'bundle', level: bundleOk ? 'ok' : 'fail', detail: bundleOk ? 'dist/ present' : 'dist/ missing', fix: bundleOk ? undefined : 'bun run build' })

  // CLI reachability — the fresh-install trap: install puts files in a version-keyed
  // cache but nothing ever puts `clawvibe` on PATH.
  const newest = newestInstalledDir()
  let linkTarget: string | undefined
  try { linkTarget = realpathSync(LOCAL_BIN) } catch {}
  if (!linkTarget) {
    checks.push({ label: 'clawvibe on PATH', level: 'fail', detail: `${LOCAL_BIN} does not exist`, fix: `${newest ? join(newest, 'bin', 'clawvibe') : '<cache>/bin/clawvibe'} setup` })
  } else if (newest && !linkTarget.startsWith(newest)) {
    checks.push({ label: 'clawvibe on PATH', level: 'warn', detail: `symlink points at ${linkTarget.replace(homedir(), '~')}, but ${newest.split('/').pop()} is installed`, fix: `ln -sfn ${join(newest, 'bin', 'clawvibe')} ${LOCAL_BIN}` })
  } else {
    checks.push({ label: 'clawvibe on PATH', level: 'ok', detail: linkTarget.replace(homedir(), '~') })
  }
  const onPath = (process.env.PATH ?? '').split(':').includes(join(homedir(), '.local', 'bin'))
  checks.push({ label: '~/.local/bin in PATH', level: onPath ? 'ok' : 'warn', detail: onPath ? 'yes' : 'no — the symlink exists but your shell cannot find it', fix: onPath ? undefined : `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc  # or ~/.bashrc` })

  for (const [bin, why] of [['bun', 'required — the CLI and gateway run on it'], ['python3', 'required for `clawvibe qr`']] as const) {
    const { code, out } = await sh(['sh', '-lc', `command -v ${bin}`])
    checks.push({ label: bin, level: code === 0 ? 'ok' : 'fail', detail: code === 0 ? out.trim() : `not found — ${why}`, fix: code === 0 ? undefined : (bin === 'bun' ? 'curl -fsSL https://bun.sh/install | bash' : 'install python3') })
  }

  // Gateway: is it up, and is it the version we think we installed?
  const h = await daemonHealth()
  if (!h.up) checks.push({ label: 'gateway', level: 'warn', detail: `nothing serving :${PORT} — it spawns with the first agent client`, fix: 'clawvibe agents up' })
  else if (version && h.version !== version) checks.push({ label: 'gateway', level: 'fail', detail: `serving ${h.version} but ${version} is installed — a stale daemon owns :${PORT}`, fix: 'clawvibe agents restart' })
  else checks.push({ label: 'gateway', level: 'ok', detail: `${h.version} on :${PORT}` })

  checks.push(await tailscaleState())

  // Agents: configured / running / registered / pinned / settled.
  const cfg = readConfig()
  if (cfg.length === 0) {
    checks.push({ label: 'agents', level: 'warn', detail: 'none configured', fix: 'clawvibe agent add <id> --name "Name" --emoji 🤖' })
  } else {
    const running = await runningByName()
    const pins = new Set(await readPins())
    let registered = new Set<string>()
    try { registered = new Set(((await (await fetch(`http://127.0.0.1:${PORT}/agents`, { signal: AbortSignal.timeout(2000) })).json()) as any[]).map(a => a.id)) } catch {}
    for (const a of cfg) {
      const s = running[`clawvibe-${a.id}`]
      if (!s) { checks.push({ label: `agent ${a.id}`, level: 'warn', detail: 'not running', fix: 'clawvibe agents up' }); continue }
      const pinned = pins.has(s.id)
      const reg = registered.has(a.id)
      const bits = [`running (${s.id})`, reg ? 'registered' : 'NOT registered', pinned ? 'pinned' : 'UNPINNED']
      checks.push({
        label: `agent ${a.id}`,
        level: pinned && reg ? 'ok' : (pinned ? 'warn' : 'fail'),
        detail: bits.join(', ') + (pinned ? '' : ' — will be reaped once it settles'),
        fix: pinned ? (reg ? undefined : 'agent has not answered its liveness probe yet; give it a few seconds, or check it is a --channels session') : 'clawvibe agents restart',
      })
    }
  }

  let devices = 0
  try { devices = Object.keys((JSON.parse(readFileSync(join(STATE_DIR, 'access.json'), 'utf8')) as any).approved ?? {}).length } catch {}
  checks.push({ label: 'paired devices', level: devices > 0 ? 'ok' : 'info', detail: String(devices), fix: devices ? undefined : 'clawvibe qr' })
  checks.push({ label: 'state dir', level: 'info', detail: STATE_DIR })

  const mark = { ok: C.ok('✓'), warn: C.warn('!'), fail: C.err('✗'), info: C.dim('·') }
  console.log('clawvibe doctor:')
  for (const c of checks) {
    console.log(`  ${mark[c.level]} ${c.label.padEnd(22)} ${c.detail}`)
    if (c.fix) console.log(C.dim(`      fix: ${c.fix}`))
  }
  const fails = checks.filter(c => c.level === 'fail').length
  const warns = checks.filter(c => c.level === 'warn').length
  console.log(fails ? C.err(`\n${fails} problem(s), ${warns} warning(s)`) : warns ? C.warn(`\n${warns} warning(s)`) : C.ok('\nall good'))
  return fails > 0 ? 1 : 0
}

// ── setup ─────────────────────────────────────────────────────────────────────

function linkCli(): void {
  mkdirSync(join(homedir(), '.local', 'bin'), { recursive: true })
  try { if (lstatSync(LOCAL_BIN)) unlinkSync(LOCAL_BIN) } catch {}
  symlinkSync(join(PLUGIN_DIR, 'bin', 'clawvibe'), LOCAL_BIN)
}

async function checkTailscale(apply: boolean): Promise<void> {
  const { code, out } = await sh(['tailscale', 'serve', 'status', '--json'])
  if (code !== 0) { console.log(C.warn('  tailscale not available — skipping ingress check')); return }
  let tcp: any = {}
  try { tcp = (JSON.parse(out).TCP ?? {})[String(PORT)] ?? {} } catch {}
  if (tcp.TCPForward && tcp.TerminateTLS) { console.log(C.ok(`  tailscale: :${PORT} is TLS-terminated TCP ✓`)); return }
  const cmds = [`sudo tailscale serve --https=${PORT} off`, `sudo tailscale serve --bg --tls-terminated-tcp=${PORT} tcp://localhost:${PORT}`]
  console.log(C.warn(`  tailscale: :${PORT} is NOT a TLS-terminated TCP forward (an HTTPS/HTTP-2 proxy breaks WebSockets → 1006 drops). Fix:`))
  for (const c of cmds) console.log(C.dim('    ' + c))
  if (apply) {
    console.log(C.dim('  applying…'))
    for (const c of cmds) { const r = await sh(c.replace(/^sudo /, 'sudo ').split(' ')); if (r.code !== 0) console.log(C.err('    ' + (r.err.trim() || 'failed'))) }
  }
}

async function cmdSetup(args: string[]): Promise<number> {
  const { flags } = parseFlags(args)
  console.log('ClawVibe setup:')
  // 1. deps / bundle
  if (!existsSync(join(PLUGIN_DIR, 'dist', 'channel-client.js'))) {
    console.log(C.dim('  building bundle…'))
    await sh(['bun', 'run', '--cwd', PLUGIN_DIR, 'build'])
  }
  console.log(C.ok('  bundle present ✓'))
  // 2. stable CLI symlink
  linkCli()
  const localBin = join(homedir(), '.local', 'bin')
  if ((process.env.PATH ?? '').split(':').includes(localBin)) {
    console.log(C.ok(`  linked ${LOCAL_BIN} ✓`))
  } else {
    // Silently creating a symlink the shell can't find is how "command not found"
    // survives a successful-looking setup.
    console.log(C.warn(`  linked ${LOCAL_BIN} — but ~/.local/bin is NOT on your PATH`))
    console.log(C.dim(`    add: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   # or ~/.bashrc`))
  }
  // 3. tailscale ingress
  await checkTailscale(flags['apply-tailscale'] === true)
  // 4. agents
  await cmdAgentsUp()
  // 5. hint
  console.log('')
  console.log('next: `clawvibe agent add <id> --emoji 🤖` then `clawvibe agents up`; `clawvibe qr` to pair; `clawvibe install-service` to persist across reboot.')
  return 0
}

// ── install-service (systemd --user) ──────────────────────────────────────────

async function cmdInstallService(): Promise<number> {
  if (process.platform !== 'linux') { console.error('install-service supports systemd (Linux) only; on macOS use a launchd agent.'); return 1 }
  const claudeDir = (await sh(['bash', '-lc', 'command -v claude'])).out.trim().replace(/\/claude$/, '')
  const bunDir = (await sh(['bash', '-lc', 'command -v bun'])).out.trim().replace(/\/bun$/, '')
  const path = [claudeDir, bunDir, join(homedir(), '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':')
  const unit = [
    '[Unit]',
    'Description=ClawVibe channel agents',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    `Environment=PATH=${path}`,
    `ExecStart=${LOCAL_BIN} agents up`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
  mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true })
  writeFileSync(UNIT_PATH, unit)
  if (!existsSync(LOCAL_BIN)) linkCli()
  await sh(['systemctl', '--user', 'daemon-reload'])
  const { code, err } = await sh(['systemctl', '--user', 'enable', '--now', 'clawvibe-agents.service'])
  if (code !== 0) { console.error(C.err('failed to enable service: ' + err.trim())); console.log(C.dim(`unit written to ${UNIT_PATH}`)); return 1 }
  console.log(C.ok('✓ clawvibe-agents.service enabled') + C.dim(`  (${UNIT_PATH})`))
  console.log(C.dim('  for start-at-boot without login: `sudo loginctl enable-linger ' + (process.env.USER ?? '$USER') + '`'))
  console.log(C.dim('  Claude Code must be authenticated for this user.'))
  return 0
}

// ── dispatch ───────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const [verb, sub, ...rest] = process.argv.slice(2)
  switch (verb) {
    case 'setup': return cmdSetup([sub, ...rest].filter(Boolean))
    case 'doctor': return cmdDoctor()
    case 'tailscale-check': { console.log('ClawVibe ingress check:'); await checkTailscale(false); return 0 }
    case 'install-service': return cmdInstallService()
    case 'agents':
      if (sub === 'up') return cmdAgentsUp()
      if (sub === 'down') return cmdAgentsDown()
      if (sub === 'restart') return cmdAgentsRestart()
      console.error('usage: clawvibe agents <up|down|restart>'); return 1
    case 'agent':
      if (sub === 'add') return cmdAgentAdd(rest)
      if (sub === 'rm') return cmdAgentRm(rest)
      if (sub === 'list') return cmdAgentList()
      console.error('usage: clawvibe agent <add|rm|list> …'); return 1
    default:
      console.error(`unknown command: ${verb}`); return 1
  }
}

process.exit(await main())
