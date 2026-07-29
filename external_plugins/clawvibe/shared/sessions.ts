/**
 * Live background-session roster, from `claude agents --json --all`.
 *
 * This is the only authoritative answer to "does this id name a real session?".
 * `pins.json` is not (pins outlive the sessions they pinned) and neither is the
 * `~/.claude/jobs/` folder (subagent scratch dirs live there too, with no session
 * behind them). See shared/listing.ts for why that matters.
 *
 * Best-effort by contract, like shared/pins.ts: `claude` may not be on the daemon's
 * PATH at all (notably in the ClawCode container, where the daemon is started by an
 * entrypoint rather than a login shell). A failure yields an empty roster, which
 * degrades the agent list back to confirmed-clients-only — the pre-existing
 * behaviour — instead of breaking it.
 */

import { readPins } from './pins.ts'
import type { LiveSession } from './listing.ts'

const ROSTER_TIMEOUT_MS = 5_000

let warnedFailure = false

/** All background sessions the runtime currently knows about, including stopped ones. */
export async function liveSessions(): Promise<LiveSession[]> {
  try {
    const p = Bun.spawn({
      cmd: ['claude', 'agents', '--json', '--all'],
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const timer = setTimeout(() => { try { p.kill() } catch {} }, ROSTER_TIMEOUT_MS)
    const out = await new Response(p.stdout).text()
    const code = await p.exited
    clearTimeout(timer)
    if (code !== 0) throw new Error(`claude agents exited ${code}`)

    const parsed = JSON.parse(out) as unknown
    if (!Array.isArray(parsed)) return []
    warnedFailure = false
    return parsed
      .filter((s): s is { id: string; name?: string } => !!s && typeof (s as any).id === 'string')
      .map(s => ({ id: s.id, name: s.name ?? null }))
  } catch (err) {
    // Log once per failure streak: this polls every 30s and a missing `claude`
    // binary is a permanent condition, not an incident worth a line each time.
    if (!warnedFailure) {
      warnedFailure = true
      process.stderr.write(`clawvibe-daemon: session roster unavailable (${err}) — listing confirmed agents only\n`)
    }
    return []
  }
}

/**
 * Pinned sessions that actually exist: pins.json ∩ the live roster.
 *
 * Dead pins are dropped, never deleted — other actors (the operator via FleetView's
 * ctrl+t, other tooling) keep their own entries in that array and it is the runtime's
 * file, not ours.
 */
export async function pinnedLiveSessions(): Promise<LiveSession[]> {
  const [pins, sessions] = await Promise.all([readPins(), liveSessions()])
  if (pins.length === 0) return []
  const pinned = new Set(pins)
  return sessions.filter(s => pinned.has(s.id))
}
