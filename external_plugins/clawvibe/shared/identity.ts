/**
 * Resolve an agent's display identity (name + emoji) for the agent registry.
 *
 * Source of truth: the agent's own definition at ~/.claude/agents/<id>.md
 * (or <cwd>/.claude/agents/<id>.md) frontmatter. Falls back to env, then the id.
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { AgentIdentity } from './protocol.ts'

/** Minimal YAML frontmatter parser: returns the key/value block between the leading `---` fences. */
function parseFrontmatter(md: string): Record<string, string> {
  const out: Record<string, string> = {}
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(md)
  if (!m) return out
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (!kv) continue
    let val = kv[2].trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[kv[1].toLowerCase()] = val
  }
  return out
}

function readAgentFrontmatter(agentId: string): Record<string, string> | null {
  const candidates = [
    join(homedir(), '.claude', 'agents', `${agentId}.md`),
    join(process.cwd(), '.claude', 'agents', `${agentId}.md`),
  ]
  for (const path of candidates) {
    try {
      return parseFrontmatter(readFileSync(path, 'utf8'))
    } catch {
      // try next
    }
  }
  return null
}

/**
 * Resolve {name, emoji} for an agent id.
 * Precedence: agents/<id>.md frontmatter → env (CLAWVIBE_AGENT_NAME/EMOJI) → {name: id, emoji: null}.
 */
export function loadAgentIdentity(agentId: string): AgentIdentity {
  const fm = readAgentFrontmatter(agentId) ?? {}
  const envName = process.env.CLAWVIBE_AGENT_NAME
  const envEmoji = process.env.CLAWVIBE_AGENT_EMOJI

  const name = fm.name || envName || agentId
  const emoji = fm.emoji || envEmoji || null
  return { name, emoji }
}
