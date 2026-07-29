#!/usr/bin/env bun
/**
 * Agent-list merge rules. Run: bun run test:listing
 *
 * Guards the invariants that make the list trustworthy:
 *   - a managed agent that is both pinned and confirmed appears ONCE, reachable
 *   - a pinned session with no client is listed, but never as reachable
 *   - confirmed agents keep their agentId (paired devices' session keys)
 *   - the default is a reachable agent whenever one exists
 */

import { mergeAgentList, defaultAgentId, UNREACHABLE_SUFFIX } from '../shared/listing.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  ✓ ${label}`) }
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

const spongebob = { agentId: 'spongebob', jobId: 'aaaa1111', name: 'SpongeBob', emoji: '🧽' }
const honcho = { id: '2f776398', name: 'Honcho Rebuild' }

console.log('dedupe: pinned AND confirmed is one reachable row')
{
  const rows = mergeAgentList([spongebob], [{ id: 'aaaa1111', name: 'clawvibe-spongebob' }])
  check('single row', rows.length === 1, `got ${rows.length}`)
  check('keyed by agentId, not job id', rows[0]?.id === 'spongebob', rows[0]?.id)
  check('reachable', rows[0]?.reachable === true)
  check('reply identity wins over session name', rows[0]?.name === 'SpongeBob', rows[0]?.name)
}

console.log('pinned-only session is listed but not reachable')
{
  const rows = mergeAgentList([], [honcho])
  check('one row', rows.length === 1)
  check('keyed by job id', rows[0]?.id === '2f776398', rows[0]?.id)
  check('not reachable', rows[0]?.reachable === false)
  check('name marked', rows[0]?.name === `Honcho Rebuild${UNREACHABLE_SUFFIX}`, rows[0]?.name)
}

console.log('mixed: confirmed first, default prefers reachable')
{
  const rows = mergeAgentList([spongebob], [honcho])
  check('two rows', rows.length === 2, `got ${rows.length}`)
  check('default is the reachable one', defaultAgentId(rows) === 'spongebob', defaultAgentId(rows))
}

console.log('pin-only list still yields a usable default')
{
  const rows = mergeAgentList([], [honcho])
  check('falls back to first row', defaultAgentId(rows) === '2f776398', defaultAgentId(rows))
  check('empty list → "default"', defaultAgentId([]) === 'default')
}

console.log('edge cases')
{
  // Two generic bg jobs both report agentId "claude" — they must NOT collapse.
  const rows = mergeAgentList([], [{ id: '68da5fb3', name: 'Job A' }, { id: '230d05dd', name: 'Job B' }])
  check('distinct generic jobs stay distinct', rows.length === 2, `got ${rows.length}`)

  const dupes = mergeAgentList([], [honcho, honcho])
  check('duplicate pin entries dedupe', dupes.length === 1, `got ${dupes.length}`)

  const unnamed = mergeAgentList([], [{ id: 'abcd0000', name: null }])
  check('nameless session falls back to id', unnamed[0]?.name === `abcd0000${UNREACHABLE_SUFFIX}`, unnamed[0]?.name)

  const blank = mergeAgentList([], [{ id: 'abcd0001', name: '   ' }])
  check('blank name falls back to id', blank[0]?.name === `abcd0001${UNREACHABLE_SUFFIX}`, blank[0]?.name)

  // A confirmed FOREGROUND session has no jobId; it must not swallow pinned rows.
  const noJob = mergeAgentList([{ agentId: 'patrick', name: 'Patrick', emoji: '⭐' }], [honcho])
  check('jobId-less confirmed agent does not hide pins', noJob.length === 2, `got ${noJob.length}`)
}

console.log(failures === 0 ? '\nall listing checks passed' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
