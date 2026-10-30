/**
 * Seal the data directory.
 *
 * Run this after editing ANY price. It:
 *
 *   1. recomputes each rate card's `sourceHash` over its own contents,
 *   2. recomputes the operator rate schedule's `sealHash`,
 *   3. re-points every SKU's `rateCardRef.sourceHash` at the card it prices
 *      against,
 *   4. copies each sealed card into the append-only archive,
 *   5. loads the catalog through the full validator - so a bad edit fails HERE,
 *      in a developer's terminal, rather than at a client's boot - and
 *   6. writes the day's catalog snapshot.
 *
 * The seal is what makes a hand-edited price detectable: change 299 to 349 and
 * forget this script, and nothing loads. That is the intended experience.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sealHash } from '../hash.js'
import { dataPaths, OPERATOR_SCHEDULE_BASENAME } from '../paths.js'
import { loadCatalog } from '../load.js'
import { snapshotCatalog } from '../archive.js'

function readJson(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function main(): void {
  const paths = dataPaths()
  const changed: string[] = []

  // 1 & 4. Rate cards, and their archive copies.
  const sealedByVendor = new Map<string, string>()
  for (const name of readdirSync(paths.rateCardDir).sort()) {
    if (!name.endsWith('.json') || name === OPERATOR_SCHEDULE_BASENAME) continue
    const path = join(paths.rateCardDir, name)
    const card = readJson(path)
    const seal = sealHash(card, 'sourceHash')
    if (card.sourceHash !== seal) {
      card.sourceHash = seal
      writeJson(path, card)
      changed.push(path)
    }
    const vendorId = String(card.vendorId)
    sealedByVendor.set(vendorId, seal)

    const archiveDir = join(paths.rateCardArchiveDir, vendorId)
    mkdirSync(archiveDir, { recursive: true })
    writeJson(
      join(archiveDir, `${String(card.archivedAtUnix)}-${seal.slice(0, 12)}.json`),
      card,
    )
  }

  // 2. Published operator rate schedule.
  const schedule = readJson(paths.operatorRateSchedule)
  const scheduleSeal = sealHash(schedule, 'sealHash')
  if (schedule.sealHash !== scheduleSeal) {
    schedule.sealHash = scheduleSeal
    writeJson(paths.operatorRateSchedule, schedule)
    changed.push(paths.operatorRateSchedule)
  }

  // 3. Re-point every pass-through SKU at its card.
  const skusFile = readJson(paths.skus)
  const skus = skusFile.skus
  if (!Array.isArray(skus)) throw new Error('skus.json has no skus array')
  let skusChanged = false
  for (const raw of skus) {
    if (typeof raw !== 'object' || raw === null) continue
    const sku = raw as Record<string, unknown>
    const ref = sku.rateCardRef
    if (typeof ref !== 'object' || ref === null) continue
    const refRecord = ref as Record<string, unknown>
    const seal = sealedByVendor.get(String(refRecord.vendorId))
    if (seal === undefined) {
      throw new Error(
        `sku ${String(sku.id)} pins a rate card for vendor "${String(refRecord.vendorId)}", which has no card file`,
      )
    }
    if (refRecord.sourceHash !== seal) {
      refRecord.sourceHash = seal
      skusChanged = true
    }
  }
  if (skusChanged) {
    writeJson(paths.skus, skusFile)
    changed.push(paths.skus)
  }

  // 5. Full validation. A bad edit dies here.
  const { catalog } = loadCatalog()

  // 6. Today's snapshot, dated from the newest price observation in the
  //    catalog rather than from the wall clock, so re-running the script does
  //    not litter the archive with a snapshot per invocation.
  const takenAt = Math.max(
    ...catalog.entries.map((entry) => entry.priceProvenance.observedAtUnix),
  )
  const snapshot = snapshotCatalog(catalog, takenAt)
  mkdirSync(paths.snapshotDir, { recursive: true })
  writeJson(
    join(paths.snapshotDir, `${snapshot.takenOnDate}-${snapshot.snapshotId.slice(0, 12)}.json`),
    snapshot,
  )

  process.stdout.write(
    `sealed ${sealedByVendor.size} rate card(s), ${catalog.skuIds.length} sku(s)\n` +
      (changed.length === 0 ? 'no files changed\n' : `updated:\n  ${changed.join('\n  ')}\n`) +
      `snapshot ${snapshot.snapshotId.slice(0, 12)} at ${snapshot.takenOnDate}\n`,
  )
}

main()
