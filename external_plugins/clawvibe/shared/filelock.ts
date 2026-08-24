/**
 * Directory-based advisory file lock.
 *
 * Extracted verbatim from shared/pins.ts, which needed it because Claude Code writes
 * ~/.claude/jobs/pins.json under a `proper-lockfile` lock and a bare write would
 * clobber it. The same hazard applies to every runtime file we share with the host —
 * installed_plugins.json especially, where losing a concurrent writer's entry
 * uninstalls an unrelated plugin — so the primitive lives here rather than being
 * copy-pasted per caller.
 *
 * Compatible with proper-lockfile by construction: it takes the lock by creating a
 * DIRECTORY at `<file>.lock`, which is atomic on POSIX, and treats a lock whose mtime
 * is older than the staleness threshold as abandoned.
 *
 * NOTE: shared/pins.ts still carries its own private copy of this logic. It predates
 * this module and is byte-for-byte the same; it is left alone deliberately, because
 * pins.ts is bundled into dist/ and switching it over would force a dist rebuild in a
 * change that otherwise touches only cli.ts. Consolidate it the next time dist/ is
 * rebuilt for another reason — `bun run test:pins` covers that refactor.
 */

import { mkdir, stat, rm } from 'fs/promises'

// Mirrors proper-lockfile as the runtime configures it (stale: 5000, minTimeout: 20),
// except for the retry budget: the runtime uses 5 attempts (~0.6s). We wait past the
// staleness threshold instead, so an abandoned lock is broken inside a single call
// rather than needing a later one.
const LOCK_STALE_MS = 5_000
const LOCK_MAX_WAIT_MS = 6_000
const LOCK_MIN_TIMEOUT_MS = 20

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export function lockPathFor(target: string): string { return `${target}.lock` }

/**
 * Deadline-bounded rather than attempt-bounded, deliberately: an attempt-counted loop
 * can spend its LAST attempt breaking a stale lock and then fall out without retrying
 * the mkdir — removing another process's lock file and still failing to acquire. Any
 * successful stale-break must be followed by another acquisition attempt.
 */
export async function acquireLock(target: string, maxWaitMs = LOCK_MAX_WAIT_MS): Promise<boolean> {
  const lockPath = lockPathFor(target)
  const deadline = Date.now() + maxWaitMs
  let backoff = LOCK_MIN_TIMEOUT_MS
  for (;;) {
    try {
      await mkdir(lockPath)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Held by someone else — break it only if it is provably stale. A live
      // proper-lockfile holder refreshes the mtime, so it will not look stale.
      let broke = false
      try {
        const st = await stat(lockPath)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true })
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

export async function releaseLock(target: string): Promise<void> {
  try { await rm(lockPathFor(target), { recursive: true, force: true }) } catch { /* best effort */ }
}

/** Run `fn` holding the lock for `target`. Returns undefined if the lock is unavailable. */
export async function withLock<T>(target: string, fn: () => Promise<T> | T): Promise<T | undefined> {
  if (!await acquireLock(target)) return undefined
  try { return await fn() } finally { await releaseLock(target) }
}
