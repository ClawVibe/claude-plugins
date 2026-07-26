/**
 * Claude Code background-session pin registry.
 *
 * WHY THIS EXISTS — this is what keeps channel agents alive.
 * Claude Code's bg daemon sweeps every 60s and retires background sessions whose
 * last input is older than a 60-minute TTL. The retirement check short-circuits, in
 * order: attached → host-managed → PINNED → idle-TTL. A pinned session is therefore
 * exempt from the reaper outright, and the same sweep additionally respawns pinned
 * sessions that have gone stale. Without a pin, a ClawVibe agent dies ~60-80 min
 * after its last message and vanishes from `claude agents --json --all` entirely —
 * not merely stopped, but unrevivable, because the session record is gone too.
 *
 * ⚠️ THIS IS THE RUNTIME'S FILE, NOT OURS. `~/.claude/jobs/pins.json` is owned and
 * written by Claude Code itself, and the always-on behaviour is arguably a side
 * effect of a UI feature (FleetView's ctrl+t "pin to top"). It is undocumented and
 * unversioned, so treat every access here as best-effort:
 *   - other actors (the operator via the UI, other tooling) keep their own pins in
 *     the same flat array — ALWAYS read-modify-write, never blind-overwrite;
 *   - the runtime writes it under a `proper-lockfile` advisory lock, so we take the
 *     same lock or we will clobber it;
 *   - every failure is logged and swallowed. An unpinned agent still works, it just
 *     won't survive the idle reaper. A pin failure must never abort a spawn.
 *
 * Pinning is not absolute: under sustained memory pressure the daemon sheds pinned
 * sessions as a last resort (and the TTL collapses to 60s). A supervisor backstop is
 * still needed for that case — but it is a backstop, not the primary mechanism.
 */

import { mkdir, stat, rm, readFile, writeFile, rename } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
export const PINS_FILE = join(CONFIG_DIR, 'jobs', 'pins.json')
const LOCK_PATH = `${PINS_FILE}.lock`

// Mirrors proper-lockfile as the runtime configures it (stale: 5000, minTimeout: 20),
// except for the retry count: the runtime uses 5 (~0.6s total). We use 8 (~5.1s), which
// exceeds the staleness threshold, so an abandoned lock is broken inside a single call
// rather than needing a later one. Our cost of giving up is higher than the runtime's —
// a skipped pin means the agent silently dies an hour later.
const LOCK_STALE_MS = 5_000
const LOCK_MAX_WAIT_MS = 6_000
const LOCK_MIN_TIMEOUT_MS = 20

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const warn = (msg: string) => process.stderr.write(`clawvibe-pins: ${msg}\n`)

/**
 * proper-lockfile takes the lock by creating a DIRECTORY, which is atomic on POSIX.
 *
 * Deadline-bounded rather than attempt-bounded, deliberately: an attempt-counted loop
 * can spend its LAST attempt breaking a stale lock and then fall out without retrying
 * the mkdir — removing another process's lock file and still failing to acquire. Any
 * successful stale-break must be followed by another acquisition attempt.
 */
async function acquireLock(): Promise<boolean> {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS
  let backoff = LOCK_MIN_TIMEOUT_MS
  for (;;) {
    try {
      await mkdir(LOCK_PATH)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Held by someone else — break it only if it is provably stale. A live
      // proper-lockfile holder refreshes the mtime, so it will not look stale.
      let broke = false
      try {
        const st = await stat(LOCK_PATH)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await rm(LOCK_PATH, { recursive: true, force: true })
          broke = true
        }
      } catch { /* vanished between mkdir and stat — fall through and retry */ }
      if (broke) continue // retry mkdir immediately; never end the loop on a break
      if (Date.now() >= deadline) return false
      await sleep(Math.min(backoff, 500) + Math.random() * LOCK_MIN_TIMEOUT_MS)
      backoff *= 2
    }
  }
}

async function releaseLock(): Promise<void> {
  try { await rm(LOCK_PATH, { recursive: true, force: true }) } catch { /* best effort */ }
}

/** Current pin set. Tolerates a missing, empty, corrupt, or non-array file. */
export async function readPins(): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(PINS_FILE, 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

/**
 * Read-modify-write the pin set, preserving every entry we do not own.
 * Best-effort by contract: returns false on any failure, never throws.
 */
export async function syncPins(opts: { add?: string[]; remove?: string[] }): Promise<boolean> {
  const add = (opts.add ?? []).filter(Boolean)
  const remove = new Set((opts.remove ?? []).filter(Boolean))
  if (add.length === 0 && remove.size === 0) return true

  let locked = false
  try {
    locked = await acquireLock()
    if (!locked) { warn(`could not acquire ${LOCK_PATH} — skipping (agent still runs, just unpinned)`); return false }

    const before = await readPins()
    let pins = before.filter(id => !remove.has(id))
    for (const id of add) if (!pins.includes(id)) pins.push(id)

    // No-op guard: avoid pointless writes (and pointless lock churn).
    if (pins.length === before.length && pins.every((id, i) => id === before[i])) return true

    await mkdir(join(CONFIG_DIR, 'jobs'), { recursive: true })
    const tmp = `${PINS_FILE}.tmp-${process.pid}`
    await writeFile(tmp, JSON.stringify(pins))
    await rename(tmp, PINS_FILE) // atomic replace
    warn(`pins ${before.length} -> ${pins.length}${add.length ? ` (+${add.join(',')})` : ''}${remove.size ? ` (-${[...remove].join(',')})` : ''}`)
    return true
  } catch (err) {
    warn(`syncPins failed: ${err}`) // swallow — never break the caller
    return false
  } finally {
    if (locked) await releaseLock()
  }
}

export async function isPinned(id: string): Promise<boolean> {
  return (await readPins()).includes(id)
}
