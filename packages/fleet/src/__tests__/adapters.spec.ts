/**
 * WHAT IS REAL IN THIS PROCESS.
 *
 * This is the only file in the repository that tests that question, and it is
 * the question `packages/fleet` exists to answer. Everything here is about one
 * failure mode: a process that was ASKED for a real dependency, could not have
 * one, and ran anyway on a fixture. That process reports healthy, ticks coins
 * that do not exist, fills a budget leg from fees nobody paid, and is
 * indistinguishable from a working deployment until someone reconciles it
 * against a chain.
 *
 * So every test below is either "it refused" or "it did not quietly substitute".
 * There is deliberately no test that asserts a graceful degradation, because
 * there is no graceful degradation to assert.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeModelClient } from '@fee-split-vaults/runtime'
import { InMemoryChainCursorStore, PgVaultRepository } from '@fee-split-vaults/adapters'
import { SignalsUnavailableError } from '@fee-split-vaults/indexer'
import { fixedClock } from '@fee-split-vaults/orchestrator'
import { DISCLOSURE, TERMS } from '../../../../config/protocol.js'
import { migratedPglite, type MigratedPglite } from './pglite.js'
import { assertChainCurrent, bootstrapFleet, memoizedSync } from '../bootstrap.js'
import { FleetStartupRefused } from '../errors.js'
import { SubstitutionLedger, startupBanner } from '../credentials.js'
import {
  assertDryRunAsksForNothingReal,
  parseDeployBlock,
  resolveAdapters,
  resolveFoundation,
  throttledFetch,
  type LiveChain,
  type ResolveAdaptersOptions,
  type ResolvedAdapters,
  type SyncResult,
} from '../adapters.js'
import { fixtureDefinitions, fixtureSeeds } from '../fixtures.js'
import { parseCoinDirectory, type CoinDefinition } from '../coins.js'
import type { SandboxSeed } from '../sandbox.js'

const NOW = 1_788_900_000
const DEPLOY_BLOCK = 58_358_200n
// A well-known test vector: secp256k1 private key 1 -> 0x7e5f4552091a69125d5dfcb7b8c2659029395bdf
const SIGNER_KEY = `0x${'0'.repeat(63)}1`
const SIGNER_ADDRESS = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'
const TREASURY = '0x4444444444444444444444444444444444444444'

/** A model that resolves without a credential, so these tests never reach out. */
function construct(): Promise<FakeModelClient> {
  return Promise.resolve(new FakeModelClient([]))
}

function liveEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    FLEET_CHAIN: 'live',
    VENUE_RPC_URL: 'https://rpc.example.test/primary',
    VENUE_RPC_URL_SECONDARY: 'https://rpc.example.test/secondary',
    // A real chain is a real dependency, and the sandbox salt is refused beside one.
    FLEET_USER_ID_SALT: 'an-operator-salt-for-tests',
    ...extra,
  }
}

const POLICY_ENV = {
  POLICY_SIGNING_KEY_ID: 'ops-2026',
  POLICY_SIGNING_KEY: 'an-operator-policy-key-that-is-at-least-32-bytes',
}

function withDeployBlock(block = DEPLOY_BLOCK): CoinDefinition[] {
  return fixtureDefinitions().map((d) => ({ ...d, vaultDeployedAtBlock: block }))
}

function liveSeeds(): SandboxSeed[] {
  return fixtureSeeds().map((s) => ({ ...s, definition: { ...s.definition, vaultDeployedAtBlock: DEPLOY_BLOCK } }))
}

/** resolveAdapters with the pieces bootstrapFleet would otherwise supply. */
function resolve(
  env: Record<string, string | undefined>,
  coins: CoinDefinition[] = withDeployBlock(),
  extra: Partial<ResolveAdaptersOptions> = {},
): ResolvedAdapters {
  const substitutions = extra.substitutions ?? new SubstitutionLedger()
  const clock = extra.clock ?? fixedClock(NOW)
  const foundation =
    extra.foundation ??
    resolveFoundation({ env, substitutions, clock, ...(extra.driver === undefined ? {} : { driver: extra.driver }) })
  return resolveAdapters({ env, coins, substitutions, clock, foundation, ...extra })
}

// ---------------------------------------------------------------------------

describe('a real dependency that cannot be honoured stops the fleet', () => {
  it('refuses a FLEET_CHAIN mode it does not recognise, rather than falling back', () => {
    // The dangerous alternative is not a crash. It is treating an unrecognised
    // mode as "not live" and starting a fixture fleet under a name someone
    // chose deliberately.
    expect(() => resolve({ FLEET_CHAIN: 'mainnet' })).toThrow(FleetStartupRefused)
  })

  it('refuses FLEET_CHAIN=live with no endpoint', () => {
    expect(() => resolve({ FLEET_CHAIN: 'live' })).toThrow(/VENUE_RPC_URL is required/)
  })

  it('refuses a "quorum" of one endpoint agreeing with itself', () => {
    // Two providers exist to make a disagreement visible. Pointing both at the
    // same URL keeps the shape of a quorum and removes all of its value, which
    // is worse than having one endpoint and knowing it.
    expect(() => resolve(liveEnv({ VENUE_RPC_URL_SECONDARY: 'https://rpc.example.test/primary' }))).toThrow(
      /not a quorum/,
    )
  })

  it('refuses a live coin with no deployment block instead of picking one', () => {
    // Both available defaults are wrong in a way that looks like working:
    // block 0 is an hours-long walk at this chain's rate limit, and the head
    // silently skips every settlement that already happened.
    expect(() => resolve(liveEnv(), fixtureDefinitions())).toThrow(/vaultDeployedAtBlock/)
  })

  it('parses a deployment block exactly, and refuses anything it would have to coerce', () => {
    expect(parseDeployBlock('c', '58358200')).toBe(58_358_200n)
    expect(parseDeployBlock('c', 58_358_200)).toBe(58_358_200n)
    expect(parseDeployBlock('c', 58_358_200n)).toBe(58_358_200n)
    expect(parseDeployBlock('c', 0)).toBe(0n)

    // A hex string is the one that matters: Number('0x37a...') succeeds, so a
    // coercing parser would start the scan at a completely different block and
    // report nothing wrong.
    expect(() => parseDeployBlock('c', '0x37aef58')).toThrow(FleetStartupRefused)
    expect(() => parseDeployBlock('c', undefined)).toThrow(FleetStartupRefused)
    expect(() => parseDeployBlock('c', -1)).toThrow(FleetStartupRefused)
    expect(() => parseDeployBlock('c', 1.5)).toThrow(FleetStartupRefused)
    // Surrounding whitespace is trimmed; the content still has to be digits.
    expect(parseDeployBlock('c', ' 12 ')).toBe(12n)
  })

  it('refuses live fixtures: FLEET_CHAIN=live with no coin directory', async () => {
    // Fixture coins have synthetic addresses. Scanning a real chain for them
    // would come back empty and read as three coins that earned nothing.
    await expect(bootstrapFleet({ nowUnix: NOW, env: liveEnv(), construct })).rejects.toThrow(
      /fixture coins that do not exist/,
    )
  })

  it('refuses a coin source it does not know', async () => {
    await expect(
      bootstrapFleet({ nowUnix: NOW, env: { FLEET_COINS_SOURCE: 'yaml' }, construct }),
    ).rejects.toThrow(/FLEET_COINS_SOURCE=yaml/)
  })
})

// ---------------------------------------------------------------------------

describe('settlement is the port that moves money, and it is the hardest to get', () => {
  it('refuses FLEET_SETTLEMENT=live without a live chain', () => {
    expect(() =>
      resolve({ FLEET_SETTLEMENT: 'live', OPERATOR_SIGNER_KEY: SIGNER_KEY, OPERATOR_TREASURY_ADDRESS: TREASURY }),
    ).toThrow(/needs FLEET_CHAIN=live/)
  })

  it('refuses without a signer key, and without a treasury', () => {
    expect(() => resolve(liveEnv({ FLEET_SETTLEMENT: 'live', OPERATOR_TREASURY_ADDRESS: TREASURY }))).toThrow(
      /OPERATOR_SIGNER_KEY is required/,
    )
    expect(() => resolve(liveEnv({ FLEET_SETTLEMENT: 'live', OPERATOR_SIGNER_KEY: SIGNER_KEY }))).toThrow(
      /OPERATOR_TREASURY_ADDRESS is required/,
    )
  })

  it('refuses a malformed or zero treasury and a malformed key', () => {
    const base = liveEnv({ FLEET_SETTLEMENT: 'live', OPERATOR_SIGNER_KEY: SIGNER_KEY })
    expect(() => resolve({ ...base, OPERATOR_TREASURY_ADDRESS: 'treasury' })).toThrow(/not a 20-byte address/)
    expect(() => resolve({ ...base, OPERATOR_TREASURY_ADDRESS: `0x${'0'.repeat(40)}` })).toThrow(/zero address/)
    expect(() =>
      resolve({ ...base, OPERATOR_SIGNER_KEY: '0xdeadbeef', OPERATOR_TREASURY_ADDRESS: TREASURY }),
    ).toThrow(/OPERATOR_SIGNER_KEY refused/)
  })

  it('refuses a signer that IS the treasury: a leaked hot key must not be a leaked treasury', () => {
    expect(() =>
      resolve(liveEnv({ FLEET_SETTLEMENT: 'live', OPERATOR_SIGNER_KEY: SIGNER_KEY, OPERATOR_TREASURY_ADDRESS: SIGNER_ADDRESS })),
    ).toThrow(/must be different keys/)
  })

  it('resolves a complete request and names the signer and the treasury in the record', () => {
    const substitutions = new SubstitutionLedger()
    const resolved = resolve(
      liveEnv({ FLEET_SETTLEMENT: 'live', OPERATOR_SIGNER_KEY: SIGNER_KEY, OPERATOR_TREASURY_ADDRESS: TREASURY, ...POLICY_ENV }),
      withDeployBlock(),
      { substitutions },
    )
    expect(resolved.settlement?.signerAddress).toBe(SIGNER_ADDRESS)
    expect(resolved.settlement?.treasury.address).toBe(TREASURY)
    const record = substitutions.realDependencies.find((r) => r.dependency === 'settlement')
    expect(record?.detail).toContain(SIGNER_ADDRESS)
    expect(record?.detail).toContain(TREASURY)
    expect(substitutions.names()).not.toContain('settlement')
  })

  it('refuses a live settlement signed under the sandbox policy key', () => {
    // The policy token is what the broker checks before it authorises a pull.
    // The sandbox key ships in sandbox.ts; a pull authorised under it is
    // authorised by anyone who can read the source.
    const env = liveEnv({ FLEET_SETTLEMENT: 'live', OPERATOR_SIGNER_KEY: SIGNER_KEY, OPERATOR_TREASURY_ADDRESS: TREASURY })
    expect(() => resolve(env)).toThrow(/FLEET_SETTLEMENT=live need POLICY_SIGNING_KEY_ID and POLICY_SIGNING_KEY/)
    // Half a keyring is no keyring; a short key is no key; the sandbox id is refused by name.
    expect(() => resolve({ ...env, POLICY_SIGNING_KEY_ID: 'ops-2026' })).toThrow(/set together or not at all/)
    expect(() => resolve({ ...env, POLICY_SIGNING_KEY_ID: 'ops-2026', POLICY_SIGNING_KEY: 'short' })).toThrow(
      /POLICY_SIGNING_KEY refused/,
    )
    expect(() => resolve({ ...env, POLICY_SIGNING_KEY_ID: 'policy-sandbox', POLICY_SIGNING_KEY: POLICY_ENV.POLICY_SIGNING_KEY })).toThrow(
      /must not be the sandbox id/,
    )
    const substitutions = new SubstitutionLedger()
    resolve({ ...env, ...POLICY_ENV }, withDeployBlock(), { substitutions })
    expect(substitutions.realDependencies.find((r) => r.dependency === 'policyKeyring')?.detail).toContain('ops-2026')
  })

  it('is refused under a dry run rather than swapped for the fake', () => {
    expect(() => assertDryRunAsksForNothingReal({ FLEET_SETTLEMENT: 'live' })).toThrow(/FLEET_SETTLEMENT=live/)
    expect(() => assertDryRunAsksForNothingReal({ FLEET_PUBLISHER: 'live' })).toThrow(/FLEET_PUBLISHER=live/)
    expect(() => assertDryRunAsksForNothingReal({ TELEGRAM_BOT_TOKEN: 't' })).toThrow(/TELEGRAM_BOT_TOKEN/)
    expect(() => assertDryRunAsksForNothingReal({ FLEET_CHAIN: 'live' })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------

describe('prices, evidence and the catalog', () => {
  it('refuses FLEET_PRICES=coingecko without an id map, and with a malformed one', () => {
    expect(() => resolve({ FLEET_PRICES: 'coingecko' })).toThrow(/COINGECKO_IDS is required/)
    expect(() => resolve({ FLEET_PRICES: 'coingecko', COINGECKO_IDS: '{not json' })).toThrow(/not JSON/)
    expect(() => resolve({ FLEET_PRICES: 'coingecko', COINGECKO_IDS: '["usdg"]' })).toThrow(/JSON object/)
    expect(() => resolve({ FLEET_PRICES: 'coingecko', COINGECKO_IDS: '{"usdg":"global-dollar"}' })).toThrow(
      /not an address -> id pair/,
    )
    expect(() => resolve({ FLEET_PRICES: 'coingecko', COINGECKO_IDS: '{}' })).toThrow(/maps no asset/)
    expect(() => resolve({ FLEET_PRICES: 'binance' })).toThrow(/FLEET_PRICES=binance/)
  })

  it('resolves a price book from a well-formed id map and records it as real', () => {
    const substitutions = new SubstitutionLedger()
    const resolved = resolve(
      { FLEET_PRICES: 'coingecko', COINGECKO_IDS: JSON.stringify({ [TREASURY]: 'global-dollar' }) },
      withDeployBlock(),
      { substitutions },
    )
    expect(resolved.prices).toBeDefined()
    expect(substitutions.realDependencies.map((r) => r.dependency)).toContain('prices')
  })

  it('refuses FLEET_EVIDENCE=dexscreener without the chain slug, which has no default', () => {
    expect(() => resolve({ FLEET_EVIDENCE: 'dexscreener' })).toThrow(/DEXSCREENER_CHAIN_SLUG is required/)
    expect(() => resolve({ FLEET_EVIDENCE: 'dextools' })).toThrow(/FLEET_EVIDENCE=dextools/)
  })

  it('brings the ops predicate verifier with a real evidence source', () => {
    const substitutions = new SubstitutionLedger()
    const resolved = resolve({ FLEET_EVIDENCE: 'dexscreener', DEXSCREENER_CHAIN_SLUG: 'venue' }, withDeployBlock(), {
      substitutions,
    })
    expect(resolved.evidence).toBeDefined()
    expect(resolved.predicateVerifier).toBeDefined()
    expect(substitutions.realDependencies.map((r) => r.dependency)).toEqual(
      expect.arrayContaining(['evidence', 'predicateVerifier']),
    )
  })

  it('refuses a catalog mode it does not know', () => {
    expect(() => resolve({ FLEET_CATALOG: 'sheet' })).toThrow(/FLEET_CATALOG=sheet/)
  })
})

// ---------------------------------------------------------------------------

describe('a live chain is recorded as real, and brings no fixtures with it', () => {
  it('records the chain as REAL and does not also record it as a fake', async () => {
    const boot = await bootstrapFleet({ nowUnix: NOW, env: liveEnv(), seeds: liveSeeds(), construct })

    expect(boot.substitutions.realDependencies.map((r) => r.dependency)).toContain('chain')
    // The sandbox world records `chain` as a fake unless a real one was handed
    // in. Both records appearing would make the banner claim both at once.
    expect(boot.substitutions.names()).not.toContain('chain')
    expect(boot.chain).toBeDefined()
    // Without a database there is no fee indexer, and the record SAYS so.
    expect(boot.chain?.indexer).toBeUndefined()
    expect(boot.substitutions.realDependencies.find((r) => r.dependency === 'chain')?.detail).toContain('NO FEE INDEXER')
  })

  it('seeds NO chain history when the chain is real', async () => {
    // THE FORGERY TEST. The fixture seeding invents a binding, fourteen days of
    // fee postings, and the claims and splits that settled them. Against the
    // fixture chain that is the point. Against a real one it would fill the
    // budget leg from fees nobody paid, and from that moment nothing
    // downstream could tell that money from money the chain actually sent.
    const seeds = liveSeeds()
    const live = await bootstrapFleet({ nowUnix: NOW, env: liveEnv(), seeds, construct })
    const alpha = seeds[0]?.definition.vault
    if (alpha === undefined) throw new Error('fixture')

    const token = seeds[0]?.definition.token
    if (token === undefined) throw new Error('fixture')
    expect(await live.world.fixtureChain.postings(alpha, 0, NOW)).toHaveLength(0)
    expect(await live.world.fixtureChain.binding(token)).toBeUndefined()

    // ...and the sandbox path still seeds, so the assertion above is about the
    // live branch rather than about seeding having quietly stopped working.
    const sandbox = await bootstrapFleet({ nowUnix: NOW, env: {}, seeds, construct })
    expect((await sandbox.world.fixtureChain.postings(alpha, 0, NOW)).length).toBeGreaterThan(0)
  })

  it('leaves the fleet on fixtures when nothing was asked for', async () => {
    const boot = await bootstrapFleet({ nowUnix: NOW, env: {}, construct })
    expect(boot.chain).toBeUndefined()
    expect(boot.substitutions.names()).toContain('chain')
    // Nothing real was asked for, so nothing is stamped with wall-clock time.
    expect(boot.world.clock.nowUnix()).toBe(NOW)
  })

  it('refuses the sandbox salt beside anything real', async () => {
    await expect(
      bootstrapFleet({ nowUnix: NOW, env: liveEnv({ FLEET_USER_ID_SALT: undefined }), seeds: liveSeeds(), construct }),
    ).rejects.toThrow(/FLEET_USER_ID_SALT is required beside a real dependency \(chain\)/)
    // ...and a fixture fleet records the derived salt as the fake it is.
    const sandbox = await bootstrapFleet({ nowUnix: NOW, env: {}, construct })
    expect(sandbox.substitutions.names()).toContain('userIdSalt')
  })

  it('REFUSES the qualification signals on a live chain without a holder index, and says so as a money-path fake', async () => {
    // The seed's fixed numbers pass every conjunct by construction. Handing
    // them to a coin whose fees are real is the farmed median the conjuncts
    // exist to stop, so a live chain without FLEET_HOLDERS=index gets a
    // provider that refuses - typed, so the tick records signals_unavailable
    // and blocks an upgrade, not a spend on invented breadth.
    const seeds = liveSeeds()
    const boot = await bootstrapFleet({ nowUnix: NOW, env: liveEnv(), seeds, construct })
    const coin = boot.world.coins.get(seeds[0]?.definition.coinRef ?? '')
    if (coin === undefined) throw new Error('fixture')
    const binding = {
      token: coin.config.token,
      vault: coin.config.vault,
      curve: coin.config.vault,
      quoteAsset: coin.config.quoteAsset,
      launchedAtUnix: NOW - 86_400,
      launchBlockNumber: 1n,
      buybackEnabled: false,
      creatorTaxBps: 0,
      coverageStartUnix: NOW - 86_400,
    }
    await expect(coin.deps.signals?.compute(binding, NOW)).rejects.toBeInstanceOf(SignalsUnavailableError)
    await expect(coin.deps.signals?.compute(binding, NOW)).rejects.toThrow(/FLEET_HOLDERS=index/)
    const fake = boot.substitutions.substitutions.find((s) => s.dependency === 'signals')
    expect(fake?.inMoneyPath).toBe(true)
    expect(fake?.reason).toContain('REFUSE')
    expect(boot.banner).toMatch(/signals .*\[MONEY PATH\]/)
  })

  it('records the sandbox signals, assets and policy key as fakes on a fixture fleet', async () => {
    const boot = await bootstrapFleet({ nowUnix: NOW, env: {}, construct })
    expect(boot.substitutions.names()).toEqual(expect.arrayContaining(['signals', 'assets', 'policyKeyring', 'userIdSalt']))
    expect(boot.banner).toMatch(/signals .*fixed numbers.*\[MONEY PATH\]/)
    expect(boot.banner).toMatch(/assets .*6-decimal.*\[MONEY PATH\]/)
    // The fixture provider still answers, so a sandbox coin can be measured.
    const coin = [...boot.world.coins.values()][0]
    if (coin === undefined) throw new Error('fixture')
    const binding = await boot.world.fixtureChain.binding(coin.config.token)
    if (binding === undefined) throw new Error('fixture')
    expect((await coin.deps.signals?.compute(binding, NOW))?.uniqueBuyers7d).toBe(500)
  })

  it('refuses FLEET_HOLDERS=index without a live chain or a database', () => {
    expect(() => resolve({ FLEET_HOLDERS: 'index' })).toThrow(/needs FLEET_CHAIN=live/)
    expect(() => resolve(liveEnv({ FLEET_HOLDERS: 'index' }))).toThrow(/needs DATABASE_URL/)
    expect(() => resolve({ FLEET_HOLDERS: 'yes' })).toThrow(/FLEET_HOLDERS=yes/)
  })
})

// ---------------------------------------------------------------------------

describe('the chain is synced before a tick, and a tick behind the lag bound is refused', () => {
  const VAULT = '0xaaaa000000000000000000000000000000000001'
  const FINALIZED = { number: 100n, hash: `0x${'1'.repeat(64)}` as const, parentHash: `0x${'0'.repeat(64)}` as const, timestampUnix: NOW - 60 }

  function chain(
    cursors: InMemoryChainCursorStore,
    result: Pick<SyncResult, 'stillBehind'> & Partial<SyncResult>,
    withIndexer = false,
  ): { chain: LiveChain; syncs: number[] } {
    const syncs: number[] = []
    const stub = {
      sync: async (nowUnix: number): Promise<SyncResult> => {
        syncs.push(nowUnix)
        return { atUnix: nowUnix, finalized: FINALIZED, vaults: [], ...result }
      },
      cursors,
      maxCoverageLagSeconds: 3_600,
      ...(withIndexer ? { indexer: {} as LiveChain['indexer'] } : {}),
    } as unknown as LiveChain
    return { chain: stub, syncs }
  }

  it('lets a caught-up coin tick, and a behind coin whose watermark is within the bound', async () => {
    const cursors = new InMemoryChainCursorStore()
    await cursors.put({ stream: 'vault_movements', scope: VAULT, blockNumber: 90n, blockTimestampUnix: NOW - 600, updatedAtUnix: NOW })
    await expect(assertChainCurrent(chain(cursors, { stillBehind: [] }).chain, VAULT, 'alpha', NOW)).resolves.toBeUndefined()
    await expect(assertChainCurrent(chain(cursors, { stillBehind: [VAULT] }).chain, VAULT, 'alpha', NOW)).resolves.toBeUndefined()
  })

  it('refuses a behind coin with no watermark, or one past FLEET_MAX_COVERAGE_LAG_SECONDS', async () => {
    const cold = new InMemoryChainCursorStore()
    await expect(assertChainCurrent(chain(cold, { stillBehind: [VAULT] }).chain, VAULT, 'alpha', NOW)).rejects.toMatchObject({
      name: 'FleetTickRefused',
      coinRef: 'alpha',
      reason: expect.stringContaining('no coverage watermark yet'),
    })
    const stale = new InMemoryChainCursorStore()
    await stale.put({ stream: 'vault_movements', scope: VAULT, blockNumber: 90n, blockTimestampUnix: NOW - 3_601, updatedAtUnix: NOW })
    await expect(assertChainCurrent(chain(stale, { stillBehind: [VAULT] }).chain, VAULT, 'alpha', NOW)).rejects.toThrow(
      /coverage is 3601s behind the tick, bound is 3600s/,
    )
    // Another coin's vault being behind is not this coin's refusal.
    await expect(
      assertChainCurrent(chain(stale, { stillBehind: ['0xaaaa000000000000000000000000000000000002'] }).chain, VAULT, 'alpha', NOW),
    ).resolves.toBeUndefined()
  })

  it('refuses when the fee indexer exists and its watermark is stale, and turns a failed sync into a typed refusal', async () => {
    const cursors = new InMemoryChainCursorStore()
    await cursors.put({ stream: 'fees', scope: 'fleet', blockNumber: 90n, blockTimestampUnix: NOW - 7_200, updatedAtUnix: NOW })
    await expect(
      assertChainCurrent(chain(cursors, { stillBehind: [] }, true).chain, VAULT, 'alpha', NOW),
    ).rejects.toThrow(/still behind on fees\/fleet/)
    // A caught-up fee tick carries its coverage and passes.
    await expect(
      assertChainCurrent(chain(cursors, { stillBehind: [], feeCoverageThroughUnix: NOW - 60 }, true).chain, VAULT, 'alpha', NOW),
    ).resolves.toBeUndefined()

    const failing = { sync: async () => { throw new Error('HTTP 429') }, cursors, maxCoverageLagSeconds: 3_600 } as unknown as LiveChain
    await expect(assertChainCurrent(failing, VAULT, 'alpha', NOW)).rejects.toThrow(/chain sync failed: HTTP 429/)
  })

  it('syncs once per instant however many coins tick at it, and does not cache a failure', async () => {
    const cursors = new InMemoryChainCursorStore()
    const { chain: stub, syncs } = chain(cursors, { stillBehind: [] })
    const memo = memoizedSync(stub)
    await memo.sync(NOW)
    await memo.sync(NOW)
    await memo.sync(NOW + 1_800)
    expect(syncs).toEqual([NOW, NOW + 1_800])

    let calls = 0
    const flaky = {
      ...stub,
      sync: async (nowUnix: number): Promise<SyncResult> => {
        calls += 1
        if (calls === 1) throw new Error('first pass fails')
        return { atUnix: nowUnix, finalized: FINALIZED, vaults: [], stillBehind: [] }
      },
    } as LiveChain
    const retrying = memoizedSync(flaky)
    await expect(retrying.sync(NOW)).rejects.toThrow(/first pass fails/)
    await expect(retrying.sync(NOW)).resolves.toMatchObject({ atUnix: NOW })
    expect(calls).toBe(2)
  })
})

// ---------------------------------------------------------------------------

describe('the banner never contradicts its own list', () => {
  it('does not claim "no chain was read" when a chain was read', () => {
    // This line was printed unconditionally, and the day the real chain adapter
    // was wired in it became a lie: the banner said no chain was read directly
    // above a `real:` section naming Venue mainnet. It is the first line an
    // operator reads and the one they stop reading at.
    const ledger = new SubstitutionLedger()
    ledger.real('chain', 'Venue chain 4663 over a 2-provider quorum')
    ledger.fake('settlement', 'no signer', true)

    const banner = startupBanner(ledger, 'fake')
    expect(banner).toContain('A real chain WAS read')
    expect(banner).not.toContain('No chain was read')
    // The money-path warning still has to survive: a real chain does not make
    // a faked settlement port safe.
    expect(banner).toContain('FAKES IN THE MONEY PATH')
  })

  it('still says no chain was read when none was', () => {
    const ledger = new SubstitutionLedger()
    ledger.fake('chain', 'no indexed chain store', true)
    expect(startupBanner(ledger, 'fake')).toContain('No chain was read')
  })
})

// ---------------------------------------------------------------------------

describe('the rate limiter', () => {
  it('spaces requests at the configured rate instead of bursting', async () => {
    // The first live run of this fleet fired a sync's whole batch at once and
    // came back with an HTTP 429. The read model turned that into a refusal
    // rather than a short result, which is correct - but a refusal caused by
    // our own impatience is an outage we inflicted on ourselves.
    const waits: number[] = []
    const sleep = async (ms: number): Promise<void> => {
      waits.push(ms)
    }
    const fetchImpl = throttledFetch(2, sleep) // 500ms apart

    const calls = [0, 1, 2, 3].map(() =>
      fetchImpl('https://example.test', undefined).catch(() => undefined),
    )
    await Promise.all(calls)

    // First call is free; every one after it waits for the slot the previous
    // call RESERVED. Reserving before awaiting is what stops four concurrent
    // callers all reading the same "free" slot and firing together.
    expect(waits.length).toBeGreaterThanOrEqual(3)
    expect(Math.max(...waits)).toBeGreaterThanOrEqual(1_000)
  })

  it('refuses a rate that is not a positive number', () => {
    for (const rate of ['0', '-1', 'fast']) {
      expect(() => resolve(liveEnv({ VENUE_HTTP_RPS: rate }))).toThrow(/not a positive rate/)
    }
  })
})

// ---------------------------------------------------------------------------

describe('the coin directory file', () => {
  const entry = {
    coinRef: 'coin_file',
    symbol: 'FILE',
    name: 'File Coin',
    vault: '0x1111111111111111111111111111111111111111',
    token: '0x2222222222222222222222222222222222222222',
    quoteAsset: '0x6666666666666666666666666666666666666666',
    tier: 'T1',
    budgetBps: 2_000,
    sweepIntervalSeconds: 3_600,
    vaultDeployedAtBlock: '58358200',
  }

  it('parses the new fields and carries the block as a bigint', () => {
    const coin = parseCoinDirectory(JSON.stringify([entry])).require('coin_file')
    expect(coin.vaultDeployedAtBlock).toBe(58_358_200n)
    expect(coin.narrative).toBeNull()
    expect(coin.imageRefs).toEqual([])
    expect(coin.symbol).toBe('FILE')
  })

  it('refuses an unknown key, a missing symbol, and a foreign image id', () => {
    expect(() => parseCoinDirectory(JSON.stringify([{ ...entry, vaultDeployBlock: '1' }]))).toThrow(/vaultDeployBlock/)
    const { symbol: _symbol, ...noSymbol } = entry
    expect(() => parseCoinDirectory(JSON.stringify([noSymbol]))).toThrow(/symbol/)
    expect(() =>
      parseCoinDirectory(JSON.stringify([{ ...entry, imageRefs: [`other_coin:banner:${'a'.repeat(16)}`] }])),
    ).toThrow(/belongs to coin "other_coin"/)
  })
})

// ---------------------------------------------------------------------------

describe('with a database', () => {
  let pg: MigratedPglite

  beforeAll(async () => {
    pg = await migratedPglite()
  }, 60_000)

  afterAll(async () => {
    await pg.close()
  })

  const CONSENT = {
    devSigner: '0x3333333333333333333333333333333333333333',
    devPayout: '0x3333333333333333333333333333333333333333',
    token: '0xabcd222222222222222222222222222222222222',
    termsHash: `0x${'7'.repeat(64)}`,
    operatorBps: 500,
    budgetBpsMax: 4_000,
    adapter: '0x8888888888888888888888888888888888888888',
    referrer: `0x${'0'.repeat(40)}`,
    referrerBps: 0,
    expiryUnix: NOW + 86_400 * 30,
    nonce: '1',
  }

  async function insertOnboarding(id: string, state: string, coinRef: string, vault: string, token: string): Promise<void> {
    await pg.driver.execute(
      `INSERT INTO onboarding (id, state, vault, token, coin_ref, created_at_unix, updated_at_unix, consent,
                               name, symbol, links, narrative_sources, history, activated_at_unix, deployed_at_unix)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, '[]', '[]', '[]', $6, $6)`,
      [id, state, vault, token, coinRef, NOW - 86_400, JSON.stringify({ ...CONSENT, token }), `Coin ${coinRef}`, coinRef.slice(0, 6).toUpperCase()],
    )
  }

  it('REFUSES an ACTIVE onboarding row whose vault record the API never wrote', async () => {
    // The directory reads vault_record; it does not invent one. A record made
    // up here - initial tier, default dial, ACTIVE - would serve the coin at a
    // tier nobody granted and a dial nobody signed.
    const vault = '0xabcd111111111111111111111111111111111111'
    const token = '0xabcd222222222222222222222222222222222222'
    await insertOnboarding('ob-active', 'active', 'dbcoin', vault, token)
    await expect(
      bootstrapFleet({ nowUnix: NOW, env: { FLEET_COINS_SOURCE: 'db', FLEET_USER_ID_SALT: 'salt' }, driver: pg.driver, construct }),
    ).rejects.toThrow(/coin "dbcoin" is active in onboarding but has no vault_record row/)
  })

  it('reads an ACTIVE onboarding row into a coin from its vault record, and skips the rest', async () => {
    const vault = '0xabcd111111111111111111111111111111111111'
    const token = '0xabcd222222222222222222222222222222222222'
    await insertOnboarding('ob-pointed', 'pointed', 'notyet', '0xabcd333333333333333333333333333333333333', '0xabcd444444444444444444444444444444444444')
    await pg.driver.execute(
      `INSERT INTO quote_asset (address, symbol, decimals, is_pausable_proxy, enabled, updated_at_unix)
       VALUES ($1, 'USDG', 6, TRUE, TRUE, $2)`,
      ['0x6666666666666666666666666666666666666666', NOW],
    )
    await pg.driver.execute(
      `INSERT INTO publisher_account_binding (channel, account_id, coin_ref, vault, token, ticker, delegated)
       VALUES ('telegram', '-100123', 'dbcoin', $1, $2, 'DBCOIN', FALSE)`,
      [vault, token],
    )
    // What the API writes at activation: the SIGNED consent, at the tier and
    // dial it granted. The directory serves exactly these.
    await new PgVaultRepository(pg.driver).put({
      address: vault,
      token,
      consent: { ...CONSENT, token },
      state: 'ACTIVE',
      tier: 'T2',
      budgetBps: 1_500,
      buybackEnabled: false,
      creatorTaxBps: 0,
      deployedAtUnix: NOW - 86_400,
      activatedAtUnix: NOW - 3_600,
    })

    const boot = await bootstrapFleet({
      nowUnix: NOW,
      env: { FLEET_COINS_SOURCE: 'db', PUBLISHER_RECEIPTS_BASE_URL: 'https://receipts.example.test/', FLEET_USER_ID_SALT: 'salt' },
      driver: pg.driver,
      construct,
    })

    expect(boot.directory.refs()).toEqual(['dbcoin'])
    const coin = boot.directory.require('dbcoin')
    expect(coin.symbol).toBe('DBCOIN')
    expect(coin.name).toBe('Coin dbcoin')
    expect(coin.quoteAsset).toBe('0x6666666666666666666666666666666666666666')
    expect(coin.accounts.get('telegram')).toBe('-100123')
    expect(coin.linkUrls.get('receipts')).toBe(`https://receipts.example.test/v/${vault}`)
    expect(coin.narrative).toBeNull()
    expect(coin.imageRefs).toEqual([])
    // Sandbox coins have no deployment block; a database coin gets one only
    // from the chain, and the chain was not asked for here.
    expect(coin.vaultDeployedAtBlock).toBeUndefined()
    // Tier and dial come from the record, never from a default.
    expect(coin.tier).toBe('T2')
    expect(coin.budgetBps).toBe(1_500)
    expect(coin.budgetBps).not.toBe(TERMS.budgetBpsDefault)

    const record = await boot.world.vaults.get(vault)
    expect(record?.consent.termsHash).toBe(CONSENT.termsHash)
    expect(record?.state).toBe('ACTIVE')

    // Every durable store is real and recorded as such; none of them is also a fake.
    const real = boot.substitutions.realDependencies.map((r) => r.dependency)
    for (const name of [
      'vaults',
      'screening',
      'receipts',
      'approvals',
      'invoices',
      'ledgerStore',
      'images',
      'predicateQueue',
      'pendingPurchases',
    ]) {
      expect(real, name).toContain(name)
      expect(boot.substitutions.names(), name).not.toContain(name)
    }

    // NO FIXTURES IN A REAL STORE: no invented screening verdict, no fixture
    // invoice, no fixture vault consent.
    expect(await boot.world.screening.latest(token)).toBeUndefined()
    expect(await boot.world.invoices.listPending(vault)).toHaveLength(0)
    expect(boot.adapters.persistence?.predicates).toBe(boot.world.predicates)
    expect(boot.adapters.persistence?.pending).toBe(boot.world.pending)
  })

  it('refuses a file coin that has no vault record in the database', async () => {
    const seeds = fixtureSeeds().slice(0, 1)
    await expect(bootstrapFleet({ nowUnix: NOW, env: {}, seeds, driver: pg.driver, construct })).rejects.toThrow(
      /no vault_record row/,
    )
  })

  it('refuses FLEET_PUBLISHER=live while the operator is still the placeholder', async () => {
    // README gate (e). The publisher takes its operator name from
    // config/protocol.ts and refuses the shipped constant; the loader turns
    // that into a startup refusal that names the file to fix.
    expect(DISCLOSURE.operatorName).toBe('SET_ME_BEFORE_LAUNCH')
    const env = {
      FLEET_PUBLISHER: 'live',
      PUBLISHER_TOKEN_KEY: `0x${'ab'.repeat(32)}`,
      X_CLIENT_ID: 'client-id',
      X_REDIRECT_URI: 'https://ops.example.test/x/callback',
      PUBLISHER_RECEIPTS_BASE_URL: 'https://receipts.example.test',
      TELEGRAM_BOT_TOKEN: '123:abc',
    }
    expect(() => resolve(env, fixtureDefinitions(), { driver: pg.driver })).toThrow(/config\/protocol\.ts/)
    // ...and without a database it refuses earlier, for a different reason.
    expect(() => resolve({ ...env, TELEGRAM_BOT_TOKEN: undefined }, fixtureDefinitions())).toThrow(/needs DATABASE_URL/)
  })

  it('refuses a live publisher without a token key, and an approval URL without its token', async () => {
    const env = {
      FLEET_PUBLISHER: 'live',
      X_CLIENT_ID: 'client-id',
      X_REDIRECT_URI: 'https://ops.example.test/x/callback',
      PUBLISHER_RECEIPTS_BASE_URL: 'https://receipts.example.test',
      TELEGRAM_BOT_TOKEN: '123:abc',
    }
    expect(() => resolve(env, fixtureDefinitions(), { driver: pg.driver })).toThrow(/PUBLISHER_TOKEN_KEY is required/)
    expect(() =>
      resolve({ ...env, PUBLISHER_TOKEN_KEY: 'short' }, fixtureDefinitions(), { driver: pg.driver }),
    ).toThrow(/PUBLISHER_TOKEN_KEY refused/)
  })

  it('a telegram token needs the database to store the stream it consumes', () => {
    expect(() => resolve({ TELEGRAM_BOT_TOKEN: '123:abc' }, fixtureDefinitions())).toThrow(/no DATABASE_URL/)
    const substitutions = new SubstitutionLedger()
    const resolved = resolve({ TELEGRAM_BOT_TOKEN: '123:abc' }, fixtureDefinitions(), { driver: pg.driver, substitutions })
    expect(resolved.messages).toBeDefined()
    expect(substitutions.realDependencies.map((r) => r.dependency)).toContain('messages')
  })

  it('builds the fee indexer over the database on a live chain', () => {
    const substitutions = new SubstitutionLedger()
    const resolved = resolve(liveEnv(), withDeployBlock(), { driver: pg.driver, substitutions })
    expect(resolved.chain?.indexer).toBeDefined()
    expect(substitutions.realDependencies.find((r) => r.dependency === 'chain')?.detail).toContain(
      `fee indexer over Postgres indexer_* from block ${String(DEPLOY_BLOCK)}`,
    )
  })
})
