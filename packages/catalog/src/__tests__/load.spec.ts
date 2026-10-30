/**
 * The loader refuses to start.
 *
 * Each test writes a deliberately broken data directory into a temp folder and
 * asserts that `loadCatalog` throws rather than serving it. The one that
 * matters most is the first: no predicate, no purchase.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CatalogError } from '../errors.js'
import { loadCatalog } from '../load.js'
import { dataPaths, defaultDataDir } from '../paths.js'
import { sealHash } from '../hash.js'

const created: string[] = []

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

type Json = Record<string, unknown>

function readShipped(path: string): Json {
  return JSON.parse(readFileSync(path, 'utf8')) as Json
}

/**
 * Copies the real data directory into a temp dir, applies a mutation, and
 * re-seals whatever the mutation touched. Starting from the shipped data means
 * every test changes exactly one thing.
 */
function stagedDataDir(mutate: (files: {
  vendors: Json
  skus: Json
  card: Json
  schedule: Json
}) => void): string {
  const shipped = dataPaths(defaultDataDir())
  const files = {
    vendors: readShipped(shipped.vendors),
    skus: readShipped(shipped.skus),
    card: readShipped(join(shipped.rateCardDir, 'dexscreener.json')),
    schedule: readShipped(shipped.operatorRateSchedule),
  }
  mutate(files)

  const dir = mkdtempSync(join(tmpdir(), 'venue-catalog-'))
  created.push(dir)
  mkdirSync(join(dir, 'rate-cards'), { recursive: true })
  writeFileSync(join(dir, 'vendors.json'), JSON.stringify(files.vendors), 'utf8')
  writeFileSync(join(dir, 'skus.json'), JSON.stringify(files.skus), 'utf8')
  writeFileSync(join(dir, 'rate-cards', 'dexscreener.json'), JSON.stringify(files.card), 'utf8')
  writeFileSync(
    join(dir, 'rate-cards', 'operator-published-rates.json'),
    JSON.stringify(files.schedule),
    'utf8',
  )
  return dir
}

/** Re-seals a card or schedule after a mutation, the way `npm run seal` does. */
function reseal(document: Json, field: 'sourceHash' | 'sealHash'): void {
  document[field] = sealHash(document, field)
}

function skuList(files: { skus: Json }): Json[] {
  const skus = files.skus.skus
  if (!Array.isArray(skus)) throw new Error('fixture: skus.json has no skus array')
  return skus as Json[]
}

function findSku(files: { skus: Json }, id: string): Json {
  const found = skuList(files).find((sku) => sku.id === id)
  if (found === undefined) throw new Error(`fixture: no sku ${id}`)
  return found
}

describe('no predicate, no purchase', () => {
  it('refuses to start when a SKU has no delivery predicate at all', () => {
    const dir = stagedDataDir((files) => {
      delete findSku(files, 'dexscreener_eti').predicate
    })
    expect(() => loadCatalog({ dataDir: dir })).toThrow(CatalogError)
    expect(() => loadCatalog({ dataDir: dir })).toThrow(/no_predicate/)
    expect(() => loadCatalog({ dataDir: dir })).toThrow(/no predicate, no purchase/)
  })

  it('refuses a misspelled predicate key rather than silently dropping it', () => {
    // The failure this catches: `predicat:` leaves a SKU predicate-less and a
    // permissive validator never notices.
    const dir = stagedDataDir((files) => {
      const sku = findSku(files, 'dexscreener_eti')
      sku.predicat = sku.predicate
      delete sku.predicate
    })
    expect(() => loadCatalog({ dataDir: dir })).toThrow(/unknown_field/)
  })

  it('refuses a predicate that schedules no verification', () => {
    const dir = stagedDataDir((files) => {
      const predicate = findSku(files, 'dexscreener_eti').predicate as Json
      predicate.verifyAtOffsetsSeconds = []
    })
    expect(() => loadCatalog({ dataDir: dir })).toThrow(/no_verification_schedule/)
  })

  it('refuses a KOL post that is not re-checked at T+7d', () => {
    const dir = stagedDataDir((files) => {
      const predicate = findSku(files, 'kol_mid_a_post').predicate as Json
      predicate.verifyAtOffsetsSeconds = [3600, 86_400]
    })
    expect(() => loadCatalog({ dataDir: dir })).toThrow(/missing_kol_recheck/)
  })

  it('refuses trending with a predictable check schedule', () => {
    const dir = stagedDataDir((files) => {
      const params = (findSku(files, 'dextools_trending_24h').predicate as Json).params as Json
      params.randomized = 0
    })
    expect(() => loadCatalog({ dataDir: dir })).toThrow(/trending_checks_not_randomized/)
  })

  it('refuses trending without pro-rata clawback', () => {
    const dir = stagedDataDir((files) => {
      const params = (findSku(files, 'dextools_trending_24h').predicate as Json).params as Json
      params.clawback = 'none'
    })
    expect(() => loadCatalog({ dataDir: dir })).toThrow(/no_clawback/)
  })

  it('refuses a manual attestation standing in for a media buy', () => {
    const dir = stagedDataDir((files) => {
      const sku = findSku(files, 'dexscreener_boost_10')
      sku.predicate = {
        kind: 'manual_attestation',
        verifyAtOffsetsSeconds: [86_400],
        params: { evidenceKind: 'we_looked_at_it' },
      }
    })
    expect(() => loadCatalog({ dataDir: dir })).toThrow(/manual_attestation_on_media/)
  })
})

describe('seals', () => {
  it('refuses a price edited in the rate card without re-sealing', () => {
    const dir = stagedDataDir((files) => {
      const prices = files.card.listPriceUsd as Record<string, number>
      prices.dexscreener_eti = 349
      // deliberately NOT re-sealed
    })
    expect(() => loadCatalog({ dataDir: dir })).toThrow(/seal_mismatch/)
  })

  it('refuses a published rate edited without re-sealing', () => {
    const dir = stagedDataDir((files) => {
      const rates = files.schedule.unitRateUsd as Record<string, number>
      rates.operator_moderation_hour = 90
    })
    expect(() => loadCatalog({ dataDir: dir })).toThrow(/schedule_seal_mismatch/)
  })

  it('catches a markup introduced by re-sealing the SKU but not the card', () => {
    // The realistic attack: bump the catalog price, re-seal so the file loads,
    // and hope nobody compares it to the vendor's own list.
    const dir = stagedDataDir((files) => {
      findSku(files, 'dexscreener_eti').unitCostUsd = 349
    })
    expect(() => loadCatalog({ dataDir: dir })).toThrow(/markup_detected/)
  })
})

describe('structural refusals', () => {
  it('refuses a vendor carrying a payout address', () => {
    const dir = stagedDataDir((files) => {
      const vendors = files.vendors.vendors as Json[]
      const dexscreener = vendors.find((vendor) => vendor.id === 'dexscreener')
      if (dexscreener !== undefined) dexscreener.payoutAddress = `0x${'2'.repeat(40)}`
    })
    expect(() => loadCatalog({ dataDir: dir })).toThrow(/payout_address_in_data/)
  })

  it('refuses a SKU offered at a tier that cannot fund it', () => {
    const dir = stagedDataDir((files) => {
      findSku(files, 'dexscreener_boost_500').availableAtTiers = ['T1', 'T2', 'T3']
    })
    expect(() => loadCatalog({ dataDir: dir })).toThrow(/exceeds_single_line_ceiling/)
  })

  it('refuses a sub-cent price, which could never reconcile at exactly zero markup', () => {
    const dir = stagedDataDir((files) => {
      findSku(files, 'dexscreener_eti').unitCostUsd = 299.005
    })
    expect(() => loadCatalog({ dataDir: dir })).toThrow(/sub_cent_precision/)
  })

  it('refuses a vendor enabled without the diligence it declares it needs', () => {
    const dir = stagedDataDir((files) => {
      const vendors = files.vendors.vendors as Json[]
      const slot = vendors.find((vendor) => vendor.id === 'kol_mid_a')
      if (slot !== undefined) slot.enabled = true
    })
    expect(() => loadCatalog({ dataDir: dir })).toThrow(/enabled_without_kyb/)
  })

  it('refuses an enabled SKU standing behind a disabled vendor', () => {
    const dir = stagedDataDir((files) => {
      const sku = findSku(files, 'kol_mid_a_post')
      sku.enabled = true
      delete sku.disabledReason
    })
    expect(() => loadCatalog({ dataDir: dir })).toThrow(
      /no_reference_for_recommendable_sku|enabled_sku_disabled_vendor/,
    )
  })

  it('refuses a disabled SKU with no reason recorded', () => {
    const dir = stagedDataDir((files) => {
      delete findSku(files, 'kol_mid_a_post').disabledReason
    })
    expect(() => loadCatalog({ dataDir: dir })).toThrow(/disabled_without_reason/)
  })

  it('refuses a duplicated SKU id', () => {
    const dir = stagedDataDir((files) => {
      const skus = skuList(files)
      const first = skus[0]
      if (first !== undefined) skus.push({ ...first })
    })
    expect(() => loadCatalog({ dataDir: dir })).toThrow(/duplicate_sku/)
  })

  it('refuses a SKU naming a vendor that is not allowlisted', () => {
    const dir = stagedDataDir((files) => {
      findSku(files, 'dexscreener_eti').vendorId = 'some_guy'
    })
    expect(() => loadCatalog({ dataDir: dir })).toThrow(/unknown_vendor/)
  })

  it('refuses a rate card filed under the wrong name', () => {
    const shipped = dataPaths(defaultDataDir())
    const dir = stagedDataDir(() => {})
    const card = readShipped(join(dir, 'rate-cards', 'dexscreener.json'))
    card.vendorId = 'dextools'
    reseal(card, 'sourceHash')
    writeFileSync(join(dir, 'rate-cards', 'dexscreener.json'), JSON.stringify(card), 'utf8')
    expect(shipped.rateCardDir.length).toBeGreaterThan(0)
    expect(() => loadCatalog({ dataDir: dir })).toThrow(/misfiled_rate_card/)
  })

  it('refuses a missing data file rather than starting with an empty catalog', () => {
    const dir = mkdtempSync(join(tmpdir(), 'venue-catalog-empty-'))
    created.push(dir)
    expect(() => loadCatalog({ dataDir: dir })).toThrow(/missing_file/)
  })
})

describe('the happy path', () => {
  it('loads the staged copy of the shipped data unchanged', () => {
    const dir = stagedDataDir(() => {})
    const { catalog } = loadCatalog({ dataDir: dir })
    expect(catalog.skuIds.length).toBeGreaterThan(0)
    expect(catalog.vendorIds).toContain('operator')
  })
})
