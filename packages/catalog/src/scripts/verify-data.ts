/**
 * Verify the data directory and print what a client would actually be offered.
 *
 * This is the human-readable form of the load-time invariants: it exits
 * non-zero on anything that would refuse to start, and on success it prints the
 * menu tier by tier. The menu is the point - reading it is how you notice that
 * a tier has been quietly sold something its budget cannot buy.
 */
import { loadCatalog } from '../load.js'
import { loadFactsheetSchema } from '../factsheet.js'
import { loadScreeningSeed } from '../screening.js'
import { loadSdnCache } from '../ofac.js'
import { monthlyProcurementBudgetUsd, maxSingleLineCents, minViableSpendCents } from '../tiers.js'
import { usdFromCents } from '../money.js'
import { TIER_ORDER } from '../protocol.js'

function main(): void {
  const { catalog, dataDir } = loadCatalog()
  const lines: string[] = [`data dir: ${dataDir}`, '']

  for (const tier of TIER_ORDER) {
    const budget = monthlyProcurementBudgetUsd(tier)
    const ceiling = usdFromCents(maxSingleLineCents(tier))
    const offered = catalog.entriesForTier(tier)
    lines.push(
      `${tier}: ${budget.toFixed(2)} USD/month procurement at the default dial, ` +
        `single-line ceiling ${ceiling.toFixed(2)} USD, ${offered.length} sku(s) offered`,
    )
    for (const entry of offered) {
      lines.push(
        `    ${entry.sku.id.padEnd(32)} ${entry.sku.unitCostUsd.toFixed(2).padStart(10)} USD  ` +
          `min viable ${usdFromCents(minViableSpendCents(entry)).toFixed(2)} USD  [${entry.pricing}]`,
      )
    }
    lines.push('')
  }

  const disabled = catalog.entries.filter((entry) => !entry.enabled)
  if (disabled.length > 0) {
    lines.push('disabled:')
    for (const entry of disabled) {
      lines.push(`    ${entry.sku.id}: ${entry.disabledReason ?? '(no reason recorded)'}`)
    }
    lines.push('')
  }

  const factsheet = loadFactsheetSchema()
  lines.push(`factsheet schema: ${factsheet.fieldIds.length} field(s)`)
  const stale = factsheet.fields.filter((field) => field.serveWhenStale)
  lines.push(
    stale.length === 0
      ? '    no field may be served stale'
      : `    served when stale: ${stale.map((f) => f.id).join(', ')}`,
  )

  const seed = loadScreeningSeed()
  lines.push('')
  lines.push(
    `screening seed: hate lexicon ${seed.hashedLexicon.status} (${seed.hashedLexicon.size} hashed term(s), ` +
      `${seed.hashedLexiconFile.plaintextPhrases.length} published phrase(s)), ` +
      `${seed.marks.entries.length} mark(s), drainer feed ${seed.drainerHosts.status} ` +
      `(${seed.drainerHosts.blockedHosts.length} host(s))`,
  )

  const sdn = loadSdnCache()
  lines.push(
    `ofac sdn cache: ${sdn.authoritative ? 'AUTHORITATIVE' : 'NOT AUTHORITATIVE'}, ` +
      `${sdn.entryCount} entry(ies), published ${sdn.publishedOnDate}`,
  )
  if (!sdn.authoritative) {
    lines.push(
      '    no CLEAR verdict can be issued until "npm run fetch:ofac -w @fee-split-vaults/catalog" has run',
    )
  }

  process.stdout.write(`${lines.join('\n')}\n`)
}

main()
