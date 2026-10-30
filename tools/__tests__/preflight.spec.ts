/**
 * The go-live preflight, against a fake world.
 *
 * What is tested is the VERDICT LOGIC and the exit code: which gap earns a
 * SKIP with its consequence, which earns a FAIL with its fix, and that only an
 * all-PASS report exits 0. Nothing here touches a database, an RPC endpoint or
 * a platform API; the world is an object literal per test.
 */

import { describe, expect, it } from 'vitest'
import type { SqlDriver } from '../../ops/migrations/driver.js'
import {
  FleetRefused,
  PUBLISHER_LABEL_MAX_AGE_SECONDS,
  exitCodeOf,
  mergeEnv,
  parseEnvFile,
  renderReport,
  runPreflight,
  type BotRights,
  type CheckResult,
  type PreflightWorld,
  type QuorumReads,
} from '../preflight.ts'

const NOW = 1_800_000_000
const SIGNER = '0x1111111111111111111111111111111111111111'
const TREASURY = '0x2222222222222222222222222222222222222222'
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const HEAD_HASH = `0x${'ab'.repeat(32)}`

/** An environment that asks for everything real, the way the go-live host does. */
function goLiveEnv(): Record<string, string> {
  return {
    FLEET_CHAIN: 'live',
    VENUE_RPC_URL: 'https://primary.example',
    VENUE_RPC_URL_SECONDARY: 'https://secondary.example',
    DATABASE_URL: 'postgres://venue:example@db.example:5432/fee_split_vaults',
    FLEET_COINS_SOURCE: 'db',
    ANTHROPIC_API_KEY: 'sk-ant-live',
    FLEET_REFUSE_FAKES: '1',
    FLEET_REQUIRE_LIVE_MODEL: '1',
    NODE_ENV: 'production',
    FLEET_SETTLEMENT: 'live',
    OPERATOR_SIGNER_KEY: `0x${'11'.repeat(32)}`,
    OPERATOR_TREASURY_ADDRESS: TREASURY,
    POLICY_SIGNING_KEY: 'p'.repeat(48),
    POLICY_SIGNING_KEY_ID: 'policy-2026-09',
    FLEET_USER_ID_SALT: 'salt-'.repeat(8),
    FLEET_PRICES: 'coingecko',
    COINGECKO_IDS: JSON.stringify({ [USDG]: 'global-dollar' }),
    FLEET_EVIDENCE: 'dexscreener',
    DEXSCREENER_CHAIN_SLUG: 'venue',
    FLEET_HOLDERS: 'index',
    FLEET_CATALOG: 'data',
    TELEGRAM_BOT_TOKEN: '123:abc',
    FLEET_PUBLISHER: 'live',
    X_CLIENT_ID: 'xclient',
    X_REDIRECT_URI: 'https://ops.example/x/callback',
    PUBLISHER_TOKEN_KEY: 'ab'.repeat(32),
    PUBLISHER_RECEIPTS_BASE_URL: 'https://receipts.example',
    PUBLISHER_APPROVAL_URL: 'https://approvals.example',
    PUBLISHER_APPROVAL_TOKEN: 'approval-token',
    VENUE_EXPLORER_BASE_URL: 'https://explorer.example',
    VENUE_VAULT_FACTORY: '0x3333333333333333333333333333333333333333',
    VENUE_VAULT_DEPLOYER: '0x4444444444444444444444444444444444444444',
    VENUE_VAULT_INIT_CODE_HASH: `0x${'cd'.repeat(32)}`,
    VENUE_OPERATOR_NAME: 'Example Operations Ltd',
    VENUE_RECEIPTS_BASE_URL: 'https://receipts.example',
    VENUE_OPERATOR_API_TOKEN: 't'.repeat(40),
    SCREENING_LEXICON_FILE: '/etc/venue/lexicon.json',
    OFAC_SDN_FILE: '/etc/venue/sdn.xml',
    OPS_PORTS_MODULE: '@fee-split-vaults/fleet/ports',
    OPS_ALERT_WEBHOOK_URL: 'https://pager.example/hook',
  }
}

const ADMIN: BotRights = { administrator: true, can_delete_messages: true, can_restrict_members: true, can_pin_messages: true }

function fakeDriver(rows: Record<string, Array<Record<string, unknown>>> = {}): SqlDriver {
  return {
    execute: async () => ({ rowsAffected: 0 }),
    query: async <T,>(sql: string, params: readonly unknown[] = []): Promise<T[]> => {
      const channel = String(params[0] ?? '')
      return (rows[channel] ?? []) as T[]
    },
    transaction: async () => {
      throw new Error('preflight must not open a transaction')
    },
  }
}

function fakeQuorum(overrides: Partial<QuorumReads> = {}): QuorumReads {
  const fulfilled = <T,>(value: T): PromiseSettledResult<T> => ({ status: 'fulfilled', value })
  return {
    chainIds: async () => [fulfilled(4663), fulfilled(4663)],
    heads: async () => [fulfilled({ number: 100_000n, hash: HEAD_HASH }), fulfilled({ number: 100_003n, hash: HEAD_HASH })],
    recentAgreed: async () => ({ number: 98_000n, hash: HEAD_HASH }),
    getCode: async () => `0x${'60'.repeat(64)}`,
    ...overrides,
  }
}

interface WorldOverrides extends Partial<PreflightWorld> {
  bindings?: Record<string, Array<Record<string, unknown>>>
}

/** A world in which everything is real and healthy. Tests override one seam at a time. */
function fakeWorld(overrides: WorldOverrides = {}): PreflightWorld & { closed: number } {
  const { bindings, ...rest } = overrides
  const driver = fakeDriver(bindings ?? { x_operator: [{ account_id: '9001', coin_ref: 'coin_a' }], telegram: [{ account_id: '-100777', coin_ref: 'coin_a' }] })
  const world: PreflightWorld & { closed: number } = {
    closed: 0,
    nowUnix: () => NOW,
    fileExists: () => true,
    connectDb: async () => ({
      driver,
      close: async () => {
        world.closed += 1
      },
    }),
    pendingMigrations: async () => ({ pending: [], applied: 19 }),
    quorum: () => fakeQuorum(),
    nativeBalanceWei: async () => 1_000_000_000_000_000_000n,
    signerAddress: () => SIGNER,
    botIdentity: async () => ({ id: '123', username: 'venue_desk_bot' }),
    botRights: async () => ADMIN,
    priceQuote: async () => ({ centsPerWholeUnit: 100n, pricedAtUnix: NOW - 30, source: 'coingecko:global-dollar' }),
    loadCatalog: () => ({
      vendors: [
        { id: 'operator', enabled: true, isRelatedParty: true },
        { id: 'dexscreener', enabled: true, isRelatedParty: false, kybVerifiedAtUnix: NOW - 30 * 86_400, ofacScreenedAtUnix: NOW - 5 * 86_400 },
      ],
      entries: [
        { skuId: 'dexscreener.boost', vendorId: 'dexscreener', enabled: true, pricing: 'third_party_pass_through' },
        { skuId: 'operator.desk', vendorId: 'operator', enabled: true, pricing: 'operator_service' },
      ],
      rateCards: 1,
    }),
    loadScreening: async () => ({ lexiconReal: true, lexiconDetail: '412 operator terms', sdnReal: true, sdnDetail: '19388 SDN entries, Publish_Date 2026-09-14' }),
    renderProbe: async () => ({ sha256: 'f'.repeat(64) }),
    credential: async () => ({ expiresAtUnix: NOW + 3_600, refreshable: true, scopes: ['tweet.write'] }),
    labelAttestation: async () => ({ attestedBy: 'ops-alice', attestedAtUnix: NOW - 3_600, expiresAtUnix: NOW + 6 * 86_400 }),
    bootstrapPorts: async () => ({ banner: ['FLEET: every dependency resolved to a real implementation.'] }),
    ...rest,
  }
  return world
}

function byId(checks: readonly CheckResult[], id: string): CheckResult {
  const found = checks.find((c) => c.id === id)
  if (found === undefined) throw new Error(`no check ${id}; have ${checks.map((c) => c.id).join(', ')}`)
  return found
}

describe('the exit code', () => {
  it('is 0 only when every check passes, including check 12', async () => {
    const report = await runPreflight(goLiveEnv(), fakeWorld())
    const notPass = report.checks.filter((c) => c.verdict !== 'PASS')
    expect(notPass.map((c) => `${c.id}: ${c.reason}`)).toEqual([
      // DISCLOSURE.operatorName ships as a placeholder; nothing in the environment can override it.
      expect.stringContaining('disclosure.operatorName'),
    ])
    expect(report.ok).toBe(false)
    expect(exitCodeOf(report)).toBe(1)
    // Same run with that one line green: exit 0.
    const green = { ...report, checks: report.checks.map((c) => (c.id === 'disclosure.operatorName' ? { ...c, verdict: 'PASS' as const } : c)), summary: { pass: report.checks.length, fail: 0, skip: 0 }, ok: true }
    expect(exitCodeOf(green)).toBe(0)
    expect(renderReport(green)).toContain('READY: every check passed. Exit 0.')
  })

  it('treats a SKIP as not ready: an unset subsystem is a fake the fleet would run with', async () => {
    const env = goLiveEnv()
    delete env.FLEET_SETTLEMENT
    const report = await runPreflight(env, fakeWorld())
    const settlement = byId(report.checks, 'env.settlement')
    expect(settlement.verdict).toBe('SKIP')
    expect(settlement.reason).toContain('never broadcast')
    expect(report.summary.skip).toBeGreaterThan(0)
    expect(exitCodeOf(report)).toBe(1)
    expect(renderReport(report)).toContain('NOT READY')
  })

  it('closes the database connection even when a later check throws', async () => {
    const world = fakeWorld({
      renderProbe: async () => {
        throw new Error('resvg exploded')
      },
    })
    const report = await runPreflight(goLiveEnv(), world)
    expect(byId(report.checks, 'creative.font').verdict).toBe('FAIL')
    expect(world.closed).toBe(1)
  })
})

describe('1. environment completeness', () => {
  it('a switch set without what it needs is a FAIL naming each missing input, not a SKIP', async () => {
    const env = goLiveEnv()
    delete env.OPERATOR_TREASURY_ADDRESS
    delete env.POLICY_SIGNING_KEY
    delete env.POLICY_SIGNING_KEY_ID
    const report = await runPreflight(env, fakeWorld())
    const settlement = byId(report.checks, 'env.settlement')
    expect(settlement.verdict).toBe('FAIL')
    expect(settlement.details?.join('\n')).toContain('OPERATOR_TREASURY_ADDRESS')
    expect(settlement.details?.join('\n')).toContain('POLICY_SIGNING_KEY')
    expect(byId(report.checks, 'env.catalog').verdict).toBe('FAIL')
    expect(byId(report.checks, 'env.policyKeyring').verdict).toBe('SKIP')
  })

  it('refuses the fixture fleet under a live chain and the dev-only sentinel in production', async () => {
    const env = goLiveEnv()
    delete env.FLEET_COINS_SOURCE
    env.VENUE_DEV_ONLY_CONFIG = '1'
    env.VENUE_VAULT_FACTORY = '0x00000000000000000000000000000000deadbeef'
    const report = await runPreflight(env, fakeWorld())
    expect(byId(report.checks, 'env.coins').verdict).toBe('FAIL')
    expect(byId(report.checks, 'env.coins').reason).toContain('fixture coins')
    expect(byId(report.checks, 'env.posture').verdict).toBe('FAIL')
    const api = byId(report.checks, 'env.api')
    expect(api.verdict).toBe('FAIL')
    expect(api.details?.join('\n')).toContain('DEV-ONLY sentinel')
  })

  it('the desk needs all three of bot, live chain and database, then the explorer URL', async () => {
    const env = goLiveEnv()
    delete env.VENUE_EXPLORER_BASE_URL
    const withoutExplorer = await runPreflight(env, fakeWorld())
    expect(byId(withoutExplorer.checks, 'env.desk').verdict).toBe('FAIL')
    delete env.TELEGRAM_BOT_TOKEN
    const withoutBot = await runPreflight(env, fakeWorld())
    expect(byId(withoutBot.checks, 'env.desk').verdict).toBe('SKIP')
    expect(byId(withoutBot.checks, 'env.desk').reason).toContain('desk_unavailable')
    expect(byId(withoutBot.checks, 'env.publisher').verdict).toBe('FAIL')
  })
})

describe('3. database', () => {
  it('pending migrations fail and are listed', async () => {
    const report = await runPreflight(goLiveEnv(), fakeWorld({ pendingMigrations: async () => ({ pending: ['0018_x_mentions', '0019_vault_ops'], applied: 17 }) }))
    const check = byId(report.checks, 'db.migrations')
    expect(check.verdict).toBe('FAIL')
    expect(check.details).toEqual(['0018_x_mentions', '0019_vault_ops'])
  })

  it('an unreachable database fails reachability and skips what depends on it', async () => {
    const report = await runPreflight(
      goLiveEnv(),
      fakeWorld({
        connectDb: async () => {
          throw new Error('ECONNREFUSED 127.0.0.1:5432')
        },
      }),
    )
    expect(byId(report.checks, 'db.reachable').reason).toContain('ECONNREFUSED')
    expect(byId(report.checks, 'db.migrations').verdict).toBe('SKIP')
    expect(byId(report.checks, 'x.accounts').verdict).toBe('SKIP')
    expect(byId(report.checks, 'fleet.bootstrap').verdict).toBe('SKIP')
  })
})

describe('4. RPC quorum', () => {
  it('a wrong chain on one endpoint fails and the dependent reads are not attempted', async () => {
    const report = await runPreflight(
      goLiveEnv(),
      fakeWorld({ quorum: () => fakeQuorum({ chainIds: async () => [{ status: 'fulfilled', value: 4663 }, { status: 'fulfilled', value: 1 }] }) }),
    )
    const chain = byId(report.checks, 'rpc.chainId')
    expect(chain.verdict).toBe('FAIL')
    expect(chain.details?.[0]).toContain('secondary.example answers chain 1')
    expect(byId(report.checks, 'rpc.head').verdict).toBe('SKIP')
    expect(byId(report.checks, 'rpc.code').verdict).toBe('SKIP')
  })

  it('heads further apart than the limit fail; within it pass', async () => {
    const far = fakeWorld({
      quorum: () => fakeQuorum({ heads: async () => [{ status: 'fulfilled', value: { number: 100_000n, hash: HEAD_HASH } }, { status: 'fulfilled', value: { number: 100_040n, hash: HEAD_HASH } }] }),
    })
    const report = await runPreflight(goLiveEnv(), far, { maxHeadLagBlocks: 32, minSignerBalanceWei: 1n })
    expect(byId(report.checks, 'rpc.head').verdict).toBe('FAIL')
    expect(byId(report.checks, 'rpc.head').reason).toContain('40 blocks apart')
    const near = await runPreflight(goLiveEnv(), far, { maxHeadLagBlocks: 64, minSignerBalanceWei: 1n })
    expect(byId(near.checks, 'rpc.head').verdict).toBe('PASS')
  })

  it('an empty code at any protocol or factory address fails, naming it', async () => {
    const report = await runPreflight(
      goLiveEnv(),
      fakeWorld({ quorum: () => fakeQuorum({ getCode: async (address) => (address.toLowerCase() === goLiveEnv().VENUE_VAULT_DEPLOYER ? '0x' : '0x6080') }) }),
    )
    const code = byId(report.checks, 'rpc.code')
    expect(code.verdict).toBe('FAIL')
    expect(code.details?.filter((d) => d.includes('NO CODE'))).toEqual([expect.stringContaining('VENUE_VAULT_DEPLOYER')])
  })
})

describe('5. signer', () => {
  it('fails below the minimum balance and when the signer is the treasury', async () => {
    const poor = await runPreflight(goLiveEnv(), fakeWorld({ nativeBalanceWei: async () => 1_000n }))
    expect(byId(poor.checks, 'signer.balance').verdict).toBe('FAIL')
    expect(byId(poor.checks, 'signer.balance').reason).toContain('fund')
    const env = goLiveEnv()
    env.OPERATOR_TREASURY_ADDRESS = SIGNER
    const same = await runPreflight(env, fakeWorld())
    expect(byId(same.checks, 'signer.treasury').verdict).toBe('FAIL')
  })

  it('skips every signer check when no key is set, with the money-path consequence', async () => {
    const env = goLiveEnv()
    delete env.OPERATOR_SIGNER_KEY
    const report = await runPreflight(env, fakeWorld())
    expect(byId(report.checks, 'signer.address').verdict).toBe('SKIP')
    expect(byId(report.checks, 'signer.address').reason).toContain('MONEY PATH')
  })
})

describe('6. X accounts', () => {
  it('a label attested more than a day ago is refused by the fleet publisher, so it fails here', async () => {
    const report = await runPreflight(
      goLiveEnv(),
      fakeWorld({ labelAttestation: async () => ({ attestedBy: 'ops-alice', attestedAtUnix: NOW - PUBLISHER_LABEL_MAX_AGE_SECONDS - 1, expiresAtUnix: NOW + 5 * 86_400 }) }),
    )
    const check = byId(report.checks, 'x.9001')
    expect(check.verdict).toBe('FAIL')
    expect(check.details?.join('\n')).toContain('maxAccountLabelAgeSeconds')
  })

  it('an expired token with no refresh token fails; with one it passes as refreshable', async () => {
    const expired = await runPreflight(goLiveEnv(), fakeWorld({ credential: async () => ({ expiresAtUnix: NOW - 10, refreshable: false, scopes: [] }) }))
    expect(byId(expired.checks, 'x.9001').verdict).toBe('FAIL')
    const refreshable = await runPreflight(goLiveEnv(), fakeWorld({ credential: async () => ({ expiresAtUnix: NOW - 10, refreshable: true, scopes: [] }) }))
    expect(byId(refreshable.checks, 'x.9001').verdict).toBe('PASS')
  })

  it('no bound account is a SKIP, not a pass', async () => {
    const report = await runPreflight(goLiveEnv(), fakeWorld({ bindings: { telegram: [{ account_id: '-100777', coin_ref: 'coin_a' }] } }))
    expect(byId(report.checks, 'x.accounts').verdict).toBe('SKIP')
  })
})

describe('7. Telegram', () => {
  it('the bot must be an administrator with the three desk rights in every bound chat', async () => {
    const report = await runPreflight(goLiveEnv(), fakeWorld({ botRights: async () => ({ ...ADMIN, can_restrict_members: false }) }))
    const chat = byId(report.checks, 'telegram.chat.-100777')
    expect(chat.verdict).toBe('FAIL')
    expect(chat.reason).toContain('can_restrict_members')
    expect(chat.reason).toContain('moderation_rights_missing')
  })
})

describe('9. catalog', () => {
  it('names the paid media the broker would refuse for a vendor without diligence dates', async () => {
    const report = await runPreflight(
      goLiveEnv(),
      fakeWorld({
        loadCatalog: () => ({
          vendors: [
            { id: 'operator', enabled: true, isRelatedParty: true },
            { id: 'dexscreener', enabled: true, isRelatedParty: false },
            { id: 'dextools', enabled: false, isRelatedParty: false },
          ],
          entries: [
            { skuId: 'dexscreener.boost', vendorId: 'dexscreener', enabled: true, pricing: 'third_party_pass_through' },
            { skuId: 'dextools.trending', vendorId: 'dextools', enabled: false, pricing: 'third_party_pass_through' },
          ],
          rateCards: 2,
        }),
      }),
    )
    const vendors = byId(report.checks, 'catalog.vendors')
    expect(vendors.verdict).toBe('FAIL')
    expect(vendors.details).toEqual([expect.stringContaining('dexscreener: no KYB record; never sanctions screened → payee_allowlist refuses dexscreener.boost')])
  })

  it('a stale sanctions screen is refused like a missing one', async () => {
    const report = await runPreflight(
      goLiveEnv(),
      fakeWorld({
        loadCatalog: () => ({
          vendors: [
            { id: 'operator', enabled: true, isRelatedParty: true },
            { id: 'dexscreener', enabled: true, isRelatedParty: false, kybVerifiedAtUnix: NOW - 86_400, ofacScreenedAtUnix: NOW - 31 * 86_400 },
          ],
          entries: [{ skuId: 'dexscreener.boost', vendorId: 'dexscreener', enabled: true, pricing: 'third_party_pass_through' }],
          rateCards: 1,
        }),
      }),
    )
    expect(byId(report.checks, 'catalog.vendors').details?.[0]).toContain('sanctions screen')
  })
})

describe('12. fleet bootstrap', () => {
  it('a refusal under FLEET_REFUSE_FAKES=1 fails and names every fake', async () => {
    const report = await runPreflight(
      goLiveEnv(),
      fakeWorld({
        bootstrapPorts: async () => {
          throw new FleetRefused('FLEET_REFUSE_FAKES=1 and these dependencies are fakes: ops.alerts, signals', ['ops.alerts', 'signals'], ['faked:', '  ops.alerts   no OPS_ALERT_WEBHOOK_URL'])
        },
      }),
    )
    const check = byId(report.checks, 'fleet.bootstrap')
    expect(check.verdict).toBe('FAIL')
    expect(check.reason).toContain('ops.alerts, signals')
    expect(check.details).toContain('  ops.alerts   no OPS_ALERT_WEBHOOK_URL')
  })

  it('an empty coin directory is a SKIP that points at the first activation', async () => {
    const report = await runPreflight(
      goLiveEnv(),
      fakeWorld({
        bootstrapPorts: async () => {
          throw new Error('the coin directory is empty')
        },
      }),
    )
    const check = byId(report.checks, 'fleet.bootstrap')
    expect(check.verdict).toBe('SKIP')
    expect(check.reason).toContain('first activation')
  })

  it('always asks the ports module to refuse fakes, whatever the environment says', async () => {
    let seen: Record<string, string | undefined> | undefined
    const env = goLiveEnv()
    delete env.FLEET_REFUSE_FAKES
    await runPreflight(
      env,
      fakeWorld({
        bootstrapPorts: async (bootstrapEnv) => {
          seen = bootstrapEnv
          return { banner: [] }
        },
      }),
    )
    expect(seen?.FLEET_REFUSE_FAKES).toBe('1')
  })
})

describe('--env', () => {
  it('parses the shapes .env.example ships and lets the process win over the file', () => {
    const file = parseEnvFile('# comment\n\nFLEET_CHAIN=live\nVENUE_RPC_URL="https://a.example"\nEMPTY=\nNOEQ\n')
    expect(file).toEqual({ FLEET_CHAIN: 'live', VENUE_RPC_URL: 'https://a.example', EMPTY: '' })
    const merged = mergeEnv({ FLEET_CHAIN: 'sandbox', OTHER: undefined }, file)
    expect(merged.FLEET_CHAIN).toBe('sandbox')
    expect(merged.VENUE_RPC_URL).toBe('https://a.example')
  })
})
