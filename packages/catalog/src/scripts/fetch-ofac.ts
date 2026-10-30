/**
 * Fetch the official OFAC SDN list and write the local cache.
 *
 * This is the only script in the package that opens a socket, and it is
 * deliberately manual rather than wired into a boot path: a sanctions list that
 * silently re-downloads on start is a sanctions list whose contents nobody
 * looked at. Run it, read the diff in the entry count, commit nothing.
 *
 *   node dist/scripts/fetch-ofac.js
 *
 * The cache is written to data/screening/ofac/sdn-cache.json, overwriting the
 * non-authoritative placeholder that ships in the repository. DO NOT COMMIT THE
 * RESULT: the real list is roughly 17k entries, it changes on OFAC's schedule
 * and not on ours, and a copy checked into a repository would look
 * authoritative for exactly as long as it took to go stale. See the assumptions
 * note - the root .gitignore should carry data/screening/ofac/sdn-cache.json,
 * and this package cannot add it.
 */
import { nodeFetchClient } from '../http.js'
import { fetchSdnCache, writeSdnCache, loadSdnCache } from '../ofac.js'

async function main(): Promise<void> {
  const nowUnix = Math.floor(Date.now() / 1000)

  let previousCount = 0
  let previousDate = 'none'
  try {
    const existing = loadSdnCache()
    previousCount = existing.entryCount
    previousDate = existing.publishedOnDate
  } catch {
    // No usable cache yet. That is the expected state on a fresh checkout.
  }

  const cache = await fetchSdnCache({ client: nodeFetchClient(), nowUnix })
  const path = writeSdnCache(cache)

  process.stdout.write(
    `wrote ${path}\n` +
      `  published ${cache.publishedOnDate} (was ${previousDate})\n` +
      `  ${cache.entryCount} entries (was ${previousCount})\n` +
      `  sealed ${cache.entriesHash.slice(0, 12)}\n`,
  )
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
