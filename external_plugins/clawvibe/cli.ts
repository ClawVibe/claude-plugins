#!/usr/bin/env bun
/**
 * ClawVibe automation CLI (the verbs beyond `qr`, which stays in qr.py).
 *
 *   clawvibe setup [--apply-tailscale]   one-shot: deps, tailscale check, link, agents up, service
 *   clawvibe agent add <id> [--emoji E] [--model M] [--prompt P]
 *   clawvibe agent rm <id> [--purge]
 *   clawvibe agent list
 *   clawvibe agents up                   idempotently start every configured agent
 *   clawvibe agents down                 stop all clawvibe-* sessions
 *   clawvibe install-service             systemd --user unit that runs `agents up` at login/boot
 *
 * Managed-agent config: $CLAWVIBE_STATE_DIR/managed-agents.json = [{ id, model? }]
 * Agent identity/persona: ~/.claude/agents/<id>.md (read by channel-client via shared/identity).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, unlinkSync, lstatSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { STATE_DIR, PORT } from './shared/access.ts'

const PLUGIN_DIR = import.meta.dir
const AGENTS_DIR = join(homedir(), '.claude', 'agents')
const CONFIG = join(STATE_DIR, 'managed-agents.json')
const LOCAL_BIN = join(homedir(), '.local', 'bin', 'clawvibe')
const UNIT_PATH = join(homedir(), '.config', 'systemd', 'user', 'clawvibe-agents.service')
const CHANNEL = 'plugin:clawvibe@clawvibe-plugins'
const REPLY_TOOLS = ['mcp__plugin_clawvibe_clawvibe__reply', 'mcp__plugin_clawvibe_clawvibe__edit_message']
const SEED = 'You are online as a ClawVibe channel agent. Wait for device messages; when one arrives, reply to it using the clawvibe reply tool. Take no other action until a message arrives.'

type ManagedAgent = { id: string; model?: string }

const C = { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, ok: (s: string) => `\x1b[32m${s}\x1b[0m`, warn: (s: string) => `\x1b[33m${s}\x1b[0m`, err: (s: string) => `\x1b[31m${s}\x1b[0m` }

function readConfig(): ManagedAgent[] {
  try { return JSON.parse(readFileSync(CONFIG, 'utf8')) as ManagedAgent[] } catch { return [] }
}
function writeConfig(a: ManagedAgent[]): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(CONFIG, JSON.stringify(a, null, 2))
}

async function sh(cmd: string[], cwd?: string): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn({ cmd, stdout: 'pipe', stderr: 'pipe', ...(cwd ? { cwd } : {}) })
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

function writeAgentDef(id: string, emoji: string | undefined, prompt: string | undefined): boolean {
  const path = agentDefPath(id)
  if (existsSync(path)) return false
  mkdirSync(AGENTS_DIR, { recursive: true })
  const fm = ['---', `name: ${id}`, `description: ${id} — ClawVibe channel agent.`]
  if (emoji) fm.push(`emoji: ${emoji}`)
  fm.push('---', '')
  const body = prompt ??
    `You are ${id}, reachable over the ClawVibe mobile app.\n\n` +
    'When a device message arrives (a `<channel source="clawvibe" conversation_id="...">` tag), ' +
    'reply to it using the `reply` tool, passing the `conversation_id` from the inbound tag so it ' +
    'lands in the same thread. Keep replies brief. Do not take other actions unless asked.\n'
  writeFileSync(path, fm.join('\n') + body)
  return true
}

function cmdAgentAdd(args: string[]): number {
  const { positional, flags } = parseFlags(args)
  const id = positional[0]
  if (!id) { console.error('usage: clawvibe agent add <id> [--emoji E] [--model M] [--prompt P]'); return 1 }
  const created = writeAgentDef(id, flags.emoji as string | undefined, flags.prompt as string | undefined)
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
  console.log(`managed agents (${cfg.length}):`)
  for (const a of cfg) {
    const sess = running[`clawvibe-${a.id}`]
    const run = sess ? C.ok('running') : C.warn('stopped')
    const reg = registered.has(a.id) ? C.ok('registered') : C.dim('not registered')
    console.log(`  ${a.id}${a.model ? C.dim(' [' + a.model + ']') : ''}  ${run}  ${reg}`)
  }
  return 0
}

// ── agents up/down ──────────────────────────────────────────────────────────

async function cmdAgentsUp(): Promise<number> {
  const cfg = readConfig()
  if (cfg.length === 0) { console.log(C.dim('no managed agents configured')); return 0 }
  const running = await runningByName()
  let started = 0, skipped = 0
  for (const a of cfg) {
    if (running[`clawvibe-${a.id}`]) { skipped++; console.log(C.dim(`  ${a.id}: already running`)); continue }
    const cmd = [
      'claude', '--bg', '--channels', CHANNEL, '--agent', a.id,
      '--permission-mode', 'acceptEdits', '--allowed-tools', ...REPLY_TOOLS,
      ...(a.model ? ['--model', a.model] : []),
      '--name', `clawvibe-${a.id}`, SEED,
    ]
    // Launch from $HOME (a trusted dir) so the bg session doesn't block on a
    // directory-trust prompt; a channel agent has no project-specific cwd.
    const { code, err } = await sh(cmd, homedir())
    if (code === 0) { started++; console.log(C.ok(`  ${a.id}: started`)) }
    else console.log(C.err(`  ${a.id}: failed (${err.trim().slice(0, 120)})`))
  }
  console.log(`agents up — ${started} started, ${skipped} already running`)
  return 0
}

async function cmdAgentsDown(): Promise<number> {
  const running = await runningByName()
  let stopped = 0
  for (const [name, sess] of Object.entries(running)) {
    if (!name.startsWith('clawvibe-')) continue
    await sh(['claude', 'stop', sess.id])
    stopped++; console.log(C.dim(`  stopped ${name}`))
  }
  console.log(`agents down — ${stopped} stopped (daemon lingers)`)
  return 0
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
  linkCli(); console.log(C.ok(`  linked ${LOCAL_BIN} ✓`) + C.dim('  (ensure ~/.local/bin is on PATH)'))
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
    case 'install-service': return cmdInstallService()
    case 'agents':
      if (sub === 'up') return cmdAgentsUp()
      if (sub === 'down') return cmdAgentsDown()
      console.error('usage: clawvibe agents <up|down>'); return 1
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
