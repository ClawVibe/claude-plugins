#!/usr/bin/env bun
/**
 * Stop hook: fail a channel turn that never called the reply tool (issue #39).
 *
 * An agent can write a perfect answer into its transcript and never call
 * `mcp__plugin_clawvibe_clawvibe__reply` / `mcp__plugin_telegram_telegram__reply`.
 * The device gets silence and the agent believes it answered. Prompt discipline
 * has not held, so this is the mechanical backstop.
 *
 * Contract: reads the Stop hook payload on stdin, and on a miss prints
 * `{"decision":"block","reason":...}` on stdout, which Claude Code feeds back to
 * the model so the turn continues.
 *
 * This hook must NEVER break a turn. Every failure path exits 0.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const STATE_DIR =
  process.env.CLAWVIBE_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'clawvibe')
const LOG_FILE = join(STATE_DIR, 'reply-guard.log')

/** Outbound channel tools. `edit_message` counts: editing a message the agent
 *  already sent is a legitimate way to answer. Deliberately matches ANY channel
 *  plugin, not just clawvibe/telegram. */
const REPLY_TOOL = /^mcp__plugin_.+__(reply|edit_message)$/

function log(line: string): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* logging must never be fatal */
  }
}

function allow(): never {
  process.exit(0)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

type Rec = {
  type?: string
  isSidechain?: boolean
  origin?: { kind?: string; server?: string }
  message?: { content?: unknown }
}

function main(raw: string): void {
  let input: Record<string, unknown>
  try {
    input = JSON.parse(raw)
  } catch {
    return allow()
  }

  // Loop safety. `stop_hook_active` is set when we are already inside a blocked
  // stop, so block at most once per turn: record the miss and let it go.
  // An unconditional block burns tokens forever.
  if (input.stop_hook_active === true) {
    log('miss-after-block: agent still did not reply after being blocked once; allowing stop')
    return allow()
  }

  const transcriptPath = input.transcript_path
  if (typeof transcriptPath !== 'string' || !transcriptPath) return allow()

  let lines: string[]
  try {
    lines = readFileSync(transcriptPath, 'utf8').split('\n')
  } catch {
    return allow()
  }

  const recs: Rec[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      recs.push(JSON.parse(line))
    } catch {
      /* a partially written trailing line is normal; skip it */
    }
  }

  // The most recent PROMPT — not the most recent user record. Tool results are
  // also `type: "user"`, but their content is a block array; a prompt's content
  // is a plain string. Subagent (sidechain) records are not our turn.
  let promptIdx = -1
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i]
    if (r.type === 'user' && !r.isSidechain && typeof r.message?.content === 'string') {
      promptIdx = i
      break
    }
  }
  if (promptIdx === -1) return allow()

  // Only channel turns are in scope. Intercom-woken turns and interactive CLI
  // turns are exempt — they have no device waiting on a reply tool.
  const prompt = recs[promptIdx]
  if (prompt.origin?.kind !== 'channel') return allow()

  const content = prompt.message?.content as string
  // The inbound tag carries both `conversation_id` (clawvibe) and `chat_id`
  // (telegram); either identifies what went unanswered.
  const target =
    /conversation_id="([^"]+)"/.exec(content)?.[1] ??
    /chat_id="([^"]+)"/.exec(content)?.[1] ??
    '(unknown)'
  const server = prompt.origin?.server ?? '(unknown server)'

  // Match on "any outbound reply tool fired", NOT on conversation_id equality.
  // One inbound can legitimately produce replies on a different conversation, or
  // several; stricter matching produces false positives.
  for (let i = promptIdx + 1; i < recs.length; i++) {
    const r = recs[i]
    if (r.type !== 'assistant' || r.isSidechain) continue
    const blocks = r.message?.content
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      if (b && typeof b === 'object' && b.type === 'tool_use' && REPLY_TOOL.test(String(b.name))) {
        return allow()
      }
    }
  }

  log(`blocked: no reply tool called for ${server} ${target}`)
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason:
        `You ended your turn without calling the channel reply tool, so the user received NOTHING. ` +
        `Text in your transcript is not delivered — only the reply tool sends. ` +
        `Send your answer now for ${server}, target "${target}", then end your turn standing by.`,
    }) + '\n',
  )
  process.exit(0)
}

readStdin().then(main).catch(allow)
