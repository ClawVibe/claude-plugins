/**
 * What the app's agent picker shows.
 *
 * Two sources, deliberately unequal:
 *
 *  1. CONFIRMED clients — an agent that answered the probe. These are the only
 *     agents that can actually receive a message, because delivery needs a live
 *     channel client, which only exists when the session was launched with
 *     `--channels`. Unchanged behaviour, and always reachable.
 *
 *  2. PINNED LIVE SESSIONS — the runtime's pin registry (`~/.claude/jobs/pins.json`)
 *     intersected with the sessions `claude agents --json --all` actually reports.
 *
 * The intersection in (2) is load-bearing, not hygiene. Neither input is an agent
 * list on its own:
 *   - pins OUTLIVE their sessions. When the reaper takes a session hard, the job
 *     dir and the session record go with it but the pin stays, so pins.json
 *     accumulates corpses (observed: 2 of 4 pins were dead agents).
 *   - the jobs FOLDER is not sessions either — subagent scratch dirs live there
 *     too (a `tmp/` dir with no state.json), and they are not background agents.
 * Only `claude agents --json` distinguishes a real live session from either.
 *
 * A pinned session with no confirmed client is listed but NOT reachable: it has no
 * `--channels`, so an inbound message can never become a turn for it. We surface it
 * rather than hiding it (the operator pinned it, so they expect to see it), but we
 * mark it in the display name, because the app has no concept of an offline agent
 * and would otherwise show a row that silently swallows every message.
 */

export type LiveSession = { id: string; name?: string | null }

/** A probe-confirmed, connected agent client. */
export type ConfirmedAgent = {
  agentId: string
  jobId?: string
  name: string
  emoji: string | null
}

export type ListedAgent = {
  id: string
  name: string
  emoji: string | null
  reachable: boolean
}

/** Suffix on rows the app cannot actually send to. */
export const UNREACHABLE_SUFFIX = ' (no channel)'

/**
 * Merge confirmed clients with pinned live sessions into the app-facing list.
 *
 * Confirmed agents keep `agentId` as their id — NOT the job id — so that session
 * keys already stored on paired devices (`agent:spongebob:clawvibe:app:<dev>`) keep
 * routing. Pin-only rows have no meaningful agent id to use (every generic bg job
 * reports agentId "claude", the agent *type*, so they would all collapse into one
 * row), and are keyed by their unique job id instead.
 */
export function mergeAgentList(
  confirmed: ConfirmedAgent[],
  pinnedLive: LiveSession[],
): ListedAgent[] {
  const rows: ListedAgent[] = confirmed.map(c => ({
    id: c.agentId,
    name: c.name,
    emoji: c.emoji,
    reachable: true,
  }))

  // A confirmed client IS its pinned session — dedupe on the job id so a managed
  // agent (pinned by `agents up` AND confirmed) appears exactly once, as the
  // reachable row.
  const claimed = new Set(confirmed.map(c => c.jobId).filter((j): j is string => !!j))

  for (const s of pinnedLive) {
    if (claimed.has(s.id)) continue
    claimed.add(s.id) // tolerate duplicate pin entries
    rows.push({
      id: s.id,
      name: (s.name?.trim() || s.id) + UNREACHABLE_SUFFIX,
      emoji: null,
      reachable: false,
    })
  }

  return rows
}

/** Default selection for the app: a reachable agent if there is one at all. */
export function defaultAgentId(rows: ListedAgent[]): string {
  return (rows.find(r => r.reachable) ?? rows[0])?.id ?? 'default'
}
