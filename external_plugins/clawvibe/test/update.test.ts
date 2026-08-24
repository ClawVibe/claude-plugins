/**
 * Regression tests for `clawvibe update`.
 *
 * The bug worth pinning: the installer used to rmSync() the destination BEFORE the
 * replacement tree was known-good. Since that destination is the directory the running
 * daemon and every agent client execute from, a failed export left no plugin installed
 * at all and broke every subsequent spawn. These tests drive the real CLI as a
 * subprocess against a throwaway HOME and a local git remote, so no network is needed
 * and nothing on the real machine is touched.
 *
 *   bun run test:update
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const CLI = join(import.meta.dir, '..', 'cli.ts')
const root = mkdtempSync(join(tmpdir(), 'cv-update-'))
const HOME = join(root, 'home')
const REPO = join(root, 'marketplace')
const BARE = join(root, 'origin.git')
const PLUGIN = join(REPO, 'external_plugins', 'clawvibe')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

async function git(args: string[], cwd = REPO): Promise<void> {
  const p = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  const code = await p.exited
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${await new Response(p.stderr).text()}`)
}

/** Write a plugin tree. `dist` false simulates a ref whose bundle was never committed. */
function writePluginTree(version: string, opts: { dist?: boolean; marker?: string } = {}): void {
  const { dist = true, marker = 'original' } = opts
  rmSync(PLUGIN, { recursive: true, force: true })
  mkdirSync(join(PLUGIN, '.claude-plugin'), { recursive: true })
  mkdirSync(join(PLUGIN, 'bin'), { recursive: true })
  writeFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'clawvibe', version }))
  writeFileSync(join(PLUGIN, 'bin', 'clawvibe'), '#!/usr/bin/env bash\necho stub\n', { mode: 0o755 })
  writeFileSync(join(PLUGIN, 'MARKER'), marker)
  if (dist) {
    mkdirSync(join(PLUGIN, 'dist'), { recursive: true })
    writeFileSync(join(PLUGIN, 'dist', 'channel-client.js'), `// ${marker}\n`)
    writeFileSync(join(PLUGIN, 'dist', 'gateway-daemon.js'), `// ${marker}\n`)
  }
}

async function commitAll(msg: string): Promise<string> {
  await git(['add', '-A'])
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg])
  await git(['push', '-q', '--force', 'origin', 'main'])
  const p = Bun.spawn({ cmd: ['git', 'rev-parse', 'HEAD'], cwd: REPO, stdout: 'pipe' })
  await p.exited
  return (await new Response(p.stdout).text()).trim()
}

async function update(args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn({
    cmd: ['bun', CLI, 'update', ...args],
    env: { ...process.env, HOME, CLAWVIBE_STATE_DIR: join(HOME, 'state') },
    stdout: 'pipe', stderr: 'pipe',
  })
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text())
  return { code: await p.exited, out: out.replace(/\x1b\[[0-9;]*m/g, '') }
}

const installDir = (v: string) => join(HOME, '.claude', 'plugins', 'cache', 'clawvibe-plugins', 'clawvibe', v)
const marker = (v: string) => { try { return readFileSync(join(installDir(v), 'MARKER'), 'utf8') } catch { return '<missing>' } }

try {
  // ── a local "GitHub": a real git repo the CLI treats as its marketplace clone.
  mkdirSync(REPO, { recursive: true })
  await git(['init', '-q', '--bare', '-b', 'main', BARE], root)
  await git(['init', '-q', '-b', 'main'])
  await git(['remote', 'add', 'origin', BARE])
  writePluginTree('9.9.9', { marker: 'original' })
  await commitAll('initial')

  mkdirSync(join(HOME, '.claude', 'plugins'), { recursive: true })
  writeFileSync(
    join(HOME, '.claude', 'plugins', 'known_marketplaces.json'),
    JSON.stringify({ 'clawvibe-plugins': { installLocation: REPO } }),
  )
  // A pre-existing entry for an unrelated plugin: registering ours must not evict it.
  writeFileSync(
    join(HOME, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'telegram@claude-plugins-official': [{ scope: 'user', version: '0.0.7' }] } }),
  )

  // 1. first install
  let r = await update(['--ref', 'main', '--no-restart'])
  check('first install succeeds', r.code === 0, r.code === 0 ? '' : r.out)
  check('installed tree present', existsSync(join(installDir('9.9.9'), 'dist', 'channel-client.js')))
  check('installed the committed tree', marker('9.9.9') === 'original', marker('9.9.9'))

  const regPath = join(HOME, '.claude', 'plugins', 'installed_plugins.json')
  const reg = JSON.parse(readFileSync(regPath, 'utf8'))
  check('registered our plugin', reg.plugins['clawvibe@clawvibe-plugins']?.[0]?.version === '9.9.9')
  check('preserved the unrelated plugin entry', !!reg.plugins['telegram@claude-plugins-official'])

  // 2. idempotent
  r = await update(['--ref', 'main', '--no-restart'])
  check('re-run is a no-op', r.code === 0 && r.out.includes('already installed'))

  // 3. THE REGRESSION: same version, new commit, but the ref has no dist/ bundle.
  //    The install must fail — and must leave the previous, working install untouched.
  writePluginTree('9.9.9', { dist: false, marker: 'broken' })
  await commitAll('drop dist')
  r = await update(['--ref', 'main', '--no-restart'])
  check('install of a dist-less ref fails', r.code === 1)
  check('  ...and says why', r.out.includes('missing') && r.out.includes('dist'), r.out.trim().split('\n').pop() ?? '')
  check('  ...and the PREVIOUS install survives', existsSync(join(installDir('9.9.9'), 'dist', 'channel-client.js')))
  check('  ...unmodified', marker('9.9.9') === 'original', marker('9.9.9'))
  check('  ...leaving no staging dirs behind', !existsSync(`${installDir('9.9.9')}.incoming-`.slice(0, -1) + '0') &&
    !readFileSync(regPath, 'utf8').includes('incoming'))

  // 4. same version, different commit, valid tree → reinstalls rather than trusting the number
  writePluginTree('9.9.9', { marker: 'second' })
  await commitAll('same version, new content')
  r = await update(['--ref', 'main', '--no-restart'])
  check('reinstalls on same-version-different-commit', r.code === 0 && r.out.includes('different commit'))
  check('  ...and the new content is live', marker('9.9.9') === 'second', marker('9.9.9'))

  // 5. a version that would escape the cache directory must be refused outright
  writePluginTree('../../../pwned', { marker: 'evil' })
  await commitAll('hostile version')
  r = await update(['--ref', 'main', '--no-restart'])
  check('rejects a path-traversing version', r.code === 1 && r.out.includes('cannot read version'))
  check('  ...and the good install still stands', marker('9.9.9') === 'second', marker('9.9.9'))

  // 6. unknown ref
  r = await update(['--ref', 'no-such-ref', '--no-restart'])
  check('unknown ref exits non-zero', r.code === 1 && r.out.includes('no such ref'))
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
