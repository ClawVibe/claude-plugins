#!/usr/bin/env bun
/**
 * Regression check for the Stop reply-guard hook (issue #39).
 *
 * Builds synthetic transcripts, runs the real hook as a subprocess with a real
 * Stop payload on stdin, and asserts on its stdout. Run: `bun run test:guard`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOOK = join(import.meta.dir, '..', 'hooks', 'reply-guard.ts')
const dir = mkdtempSync(join(tmpdir(), 'clawvibe-guard-'))
let failures = 0

function channelPrompt(convId: string, server = 'plugin:clawvibe:clawvibe') {
  return {
    type: 'user',
    isSidechain: false,
    origin: { kind: 'channel', server },
    promptSource: 'system',
    message: {
      role: 'user',
      content: `<channel source="${server}" chat_id="${convId}" message_id="m1" conversation_id="${convId}">\nhi\n</channel>`,
    },
  }
}
const humanPrompt = { type: 'user', isSidechain: false, message: { role: 'user', content: 'do a thing' } }
const assistantText = { type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'here is my answer' }] } }
const toolUse = (name: string) => ({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name, input: {} }] } })
/** Tool results are also type:"user" — content is a block array, not a string. */
const toolResult = { type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }

async function run(name: string, recs: unknown[], payload: Record<string, unknown> = {}) {
  const path = join(dir, `${name}.jsonl`)
  // A partially written trailing line is normal in a live transcript.
  writeFileSync(path, recs.map((r) => JSON.stringify(r)).join('\n') + '\n{"type":"assist')
  const proc = Bun.spawn(['bun', HOOK], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  proc.stdin.write(JSON.stringify({ hook_event_name: 'Stop', session_id: 's', transcript_path: path, stop_hook_active: false, ...payload }))
  proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return { code: proc.exitCode, out: out.trim() }
}

function check(label: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('reply-guard')

{
  const r = await run('miss', [channelPrompt('clawvibe:abc'), assistantText])
  const parsed = r.out ? JSON.parse(r.out) : null
  check('blocks a channel turn with no reply tool', parsed?.decision === 'block', r.out)
  check('reason names the unanswered target', String(parsed?.reason ?? '').includes('clawvibe:abc'), parsed?.reason)
  check('exits 0 even when blocking', r.code === 0, `code ${r.code}`)
}
{
  const r = await run('replied', [channelPrompt('clawvibe:abc'), assistantText, toolUse('mcp__plugin_clawvibe_clawvibe__reply')])
  check('allows a channel turn that replied', r.out === '', r.out)
}
{
  const r = await run('edited', [channelPrompt('clawvibe:abc'), toolUse('mcp__plugin_telegram_telegram__edit_message')])
  check('edit_message counts as answering', r.out === '', r.out)
}
{
  const r = await run('crosschannel', [channelPrompt('clawvibe:abc'), toolUse('mcp__plugin_telegram_telegram__reply')])
  check('any outbound reply tool counts (no conversation_id equality)', r.out === '', r.out)
}
{
  const r = await run('human', [humanPrompt, assistantText])
  check('interactive CLI turn is exempt', r.out === '', r.out)
}
{
  // An intercom wake is a normal prompt with no channel origin.
  const r = await run('intercom', [{ type: 'user', isSidechain: false, message: { role: 'user', content: '[intercom from spongebob] ping' } }, assistantText])
  check('intercom-woken turn is exempt', r.out === '', r.out)
}
{
  const r = await run('loop', [channelPrompt('clawvibe:abc'), assistantText], { stop_hook_active: true })
  check('does not block twice (stop_hook_active)', r.out === '', r.out)
}
{
  // Tool results must not be mistaken for the most recent prompt.
  const r = await run('toolresult', [channelPrompt('clawvibe:abc'), toolUse('Bash'), toolResult, assistantText])
  const parsed = r.out ? JSON.parse(r.out) : null
  check('tool_result records are not treated as prompts', parsed?.decision === 'block', r.out)
}
{
  const r = await run('probe', [channelPrompt('clawvibe:probe:d18f69fe'), assistantText])
  check('liveness probes are in scope, not exempt', r.out.includes('block'), r.out)
}
{
  // A subagent replying on a sidechain must not satisfy our turn.
  const sidechainReply = { ...toolUse('mcp__plugin_clawvibe_clawvibe__reply'), isSidechain: true }
  const r = await run('sidechain', [channelPrompt('clawvibe:abc'), sidechainReply])
  check('sidechain reply does not count', r.out.includes('block'), r.out)
}
{
  const r = await run('notranscript', [], { transcript_path: '/nonexistent/nope.jsonl' })
  check('unreadable transcript never breaks the turn', r.code === 0 && r.out === '', `${r.code} ${r.out}`)
}

rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
