/** Unit tests for shared/pins.ts against a throwaway CLAUDE_CONFIG_DIR. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = mkdtempSync(join(tmpdir(), 'pins-test-'))
process.env.CLAUDE_CONFIG_DIR = root
mkdirSync(join(root, 'jobs'), { recursive: true })
const PINS = join(root, 'jobs', 'pins.json')

const { readPins, syncPins } = await import(process.argv[2] ?? new URL('../shared/pins.ts', import.meta.url).pathname)

let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}
const read = () => JSON.parse(readFileSync(PINS, 'utf8')) as string[]

// 1. missing file
check('missing file -> []', (await readPins()).length === 0)
check('add to missing file creates it', (await syncPins({ add: ['aaaa1111'] })) && existsSync(PINS), JSON.stringify(read()))

// 2. foreign entries preserved  (THE critical one — real file holds other people's pins)
writeFileSync(PINS, JSON.stringify(['foreign1', 'foreign2']))
await syncPins({ add: ['mine0001'] })
check('preserves foreign entries on add', JSON.stringify(read()) === JSON.stringify(['foreign1', 'foreign2', 'mine0001']), JSON.stringify(read()))
await syncPins({ remove: ['mine0001'] })
check('preserves foreign entries on remove', JSON.stringify(read()) === JSON.stringify(['foreign1', 'foreign2']), JSON.stringify(read()))

// 3. no-op when unchanged (must not rewrite)
const before = readFileSync(PINS, 'utf8')
await syncPins({ add: ['foreign1'] })              // already present
check('adding an existing pin is a no-op', readFileSync(PINS, 'utf8') === before)
await syncPins({ remove: ['not-present'] })
check('removing an absent pin is a no-op', readFileSync(PINS, 'utf8') === before)
check('empty request short-circuits', await syncPins({}))

// 4. corrupt / wrong-shape file tolerated
writeFileSync(PINS, '{not json at all')
check('corrupt file -> readPins []', (await readPins()).length === 0)
check('corrupt file still writable', (await syncPins({ add: ['recovered'] })) && read().includes('recovered'))
writeFileSync(PINS, JSON.stringify({ not: 'an array' }))
check('non-array file -> []', (await readPins()).length === 0)
writeFileSync(PINS, JSON.stringify(['ok1', 42, null, 'ok2']))
check('non-string members filtered', JSON.stringify(await readPins()) === JSON.stringify(['ok1', 'ok2']))

// 5. concurrency: 12 parallel adds must all land (lock actually works)
writeFileSync(PINS, JSON.stringify(['base']))
const ids = Array.from({ length: 12 }, (_, i) => `conc${String(i).padStart(4, '0')}`)
await Promise.all(ids.map(id => syncPins({ add: [id] })))
const after = read()
const lost = ids.filter(id => !after.includes(id))
check('12 concurrent adds, none lost', lost.length === 0, `lost=${JSON.stringify(lost)} final=${after.length}`)
check('concurrent adds kept the base entry', after.includes('base'))

// 6a. a LIVE lock holder (refreshes its mtime, as proper-lockfile does): we must
// never break it, and must give up without clobbering.
mkdirSync(`${PINS}.lock`, { recursive: true })
const keepFresh = setInterval(() => { try { utimesSync(`${PINS}.lock`, new Date(), new Date()) } catch {} }, 400)
const held = read()
const t0 = Date.now()
const okFresh = await syncPins({ add: ['shouldnotland'] })
clearInterval(keepFresh)
check('live foreign lock -> gives up without clobbering', !okFresh && JSON.stringify(read()) === JSON.stringify(held), `${Date.now() - t0}ms`)
check('live foreign lock was NOT broken', existsSync(`${PINS}.lock`))

// 6b. a STALE lock (older than 5s) must be broken and the write must land
utimesSync(`${PINS}.lock`, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
const t = Date.now()
const okStale = await syncPins({ add: ['afterstale'] })
check('stale lock broken within ~5s', okStale && read().includes('afterstale'), `${Date.now() - t}ms`)

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
