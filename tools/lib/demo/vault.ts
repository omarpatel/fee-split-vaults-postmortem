/**
 * demo vault - the per-token, non-custodial fee vault, end to end.
 *
 * WHAT IS COMPUTED AND WHAT IS NARRATED. Be clear about this, because it is the
 * one place in the demo where the two are mixed:
 *
 *   COMPUTED FROM THE COMPILED CONTRACT (contracts/out/CoinVault.sol):
 *     - the CREATE2 init code hash, keccak256 of the real creation code
 *     - the consent salt, keccak256(abi.encode(Consent)) with the field order
 *       taken from ConsentLib.sol
 *     - the predicted vault address, and the DIFFERENT address the same dev
 *       gets at a different take rate
 *     - a cross-check that every function this walkthrough narrates exists in
 *       the compiled ABI. A missing one prints as an explicit MISSING and the
 *       run reports itself incomplete rather than narrating a fiction.
 *
 *   NARRATED, from a model of the split rule in this file:
 *     - the ledger arithmetic across the lifecycle. The model mirrors
 *       CoinVault._splitOf and _credit line for line and is asserted against the
 *       contract's own invariants in tools/__tests__/demo-vault.spec.ts, but it
 *       is not an EVM execution. The 137 Foundry tests are:
 *         forge test --root contracts
 *
 * THE ONE-LINE SPLIT RULE, which is the whole contract:
 *
 *     if (state != ACTIVE || asset == launch token) -> 100% to the dev leg
 *
 * Everything the specification asks for about UNBOUND, PASSTHROUGH, TERMINATED
 * and the launch token falls out of that single branch rather than out of a
 * table of special cases, which is why there is no state in which the operator
 * can be paid by accident.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TERMS } from '../../../config/protocol.ts'
import { table } from '../format.ts'
import { bytesToHex, hexToBytes, keccak256Bytes, toChecksumAddress } from '../keccak.ts'
import {
  COIN,
  NOW,
  OPERATOR_TREASURY,
  VENUE_ADAPTER,
  QUOTE_ASSET,
} from './fixtures.ts'
import { ok, refused, summarise, type DemoResult, type Pair, type Scene } from './render.ts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const ARTIFACT = join(REPO_ROOT, 'contracts', 'out', 'CoinVault.sol', 'CoinVault.json')

/**
 * The deployer address a factory would have. CREATE2 derives from the
 * VaultDeployer, not the factory: VaultFactory holds CoinVault's creation code
 * in a separate contract because embedding it put the factory over EIP-170.
 */
const DEPLOYER = '0x00000000000000000000000000000000000dep10'

// ---------------------------------------------------------------------------
// The consent. Field order mirrors ConsentLib.sol EXACTLY: reordering silently
// changes every vault address ever predicted.
// ---------------------------------------------------------------------------

interface Consent {
  devSigner: string
  devPayout: string
  token: string
  termsHash: string
  operatorBps: number
  budgetBpsMax: number
  adapter: string
  referrer: string
  referrerBps: number
  expiryUnix: number
  nonce: string
}

const CONSENT: Consent = {
  devSigner: COIN.devSigner,
  devPayout: COIN.devPayout,
  token: COIN.token,
  termsHash: '0x8f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f',
  operatorBps: TERMS.operatorBps,
  budgetBpsMax: TERMS.budgetBpsMax,
  adapter: VENUE_ADAPTER,
  referrer: '0x0000000000000000000000000000000000000000',
  referrerBps: 0,
  expiryUnix: NOW + 30 * 86_400,
  nonce: '0x0000000000000000000000000000000000000000000000000000000000000001',
}

/** One 32-byte ABI word. */
function word(hexOrNumber: string | number | bigint): string {
  if (typeof hexOrNumber === 'string') {
    const clean = hexOrNumber.replace(/^0x/, '')
    if (clean.length > 64) throw new Error(`value too wide for one word: ${hexOrNumber}`)
    return clean.padStart(64, '0')
  }
  return BigInt(hexOrNumber).toString(16).padStart(64, '0')
}

/**
 * `abi.encode(Consent)`. Every field is static, so this is eleven words with no
 * head/tail split. Note it is abi.encode and NOT abi.encodePacked: packed
 * encoding of two adjacent uint16 fields would be ambiguous, and ambiguity in a
 * salt preimage is a collision.
 */
function encodeConsent(c: Consent): string {
  return (
    '0x' +
    [
      word(c.devSigner),
      word(c.devPayout),
      word(c.token),
      word(c.termsHash),
      word(c.operatorBps),
      word(c.budgetBpsMax),
      word(c.adapter),
      word(c.referrer),
      word(c.referrerBps),
      word(c.expiryUnix),
      word(c.nonce),
    ].join('')
  )
}

function keccakHex(hex: string): string {
  return bytesToHex(keccak256Bytes(hexToBytes(hex)))
}

/** CREATE2: keccak256(0xff ++ deployer ++ salt ++ initCodeHash), low 20 bytes. */
function predictCreate2(deployer: string, salt: string, initCodeHash: string): string {
  const preimage =
    '0xff' +
    deployer.replace(/^0x/, '').padStart(40, '0') +
    salt.replace(/^0x/, '') +
    initCodeHash.replace(/^0x/, '')
  return toChecksumAddress(`0x${keccakHex(preimage).slice(-40)}`)
}

// ---------------------------------------------------------------------------
// The compiled artifact
// ---------------------------------------------------------------------------

interface AbiFunction {
  name: string
  inputs: Array<{ name: string; type: string }>
}

interface Artifact {
  initCodeHash: string
  initCodeBytes: number
  abiFunctions: Set<string>
  signatures: Map<string, AbiFunction>
  ok: true
}

interface ArtifactMissing {
  ok: false
  reason: string
}

function loadArtifact(): Artifact | ArtifactMissing {
  let raw: string
  try {
    raw = readFileSync(ARTIFACT, 'utf8')
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `could not read ${ARTIFACT}: ${
        error instanceof Error ? error.message : String(error)
      }. Build the contracts first: forge build --root contracts`,
    }
  }
  const parsed = JSON.parse(raw) as {
    bytecode?: { object?: string }
    abi?: Array<{ type?: string; name?: string; inputs?: Array<{ name?: string; type?: string }> }>
  }
  const object = parsed.bytecode?.object
  if (typeof object !== 'string' || object.length < 4) {
    return { ok: false, reason: 'the artifact carries no creation bytecode' }
  }
  const names = new Set<string>()
  const signatures = new Map<string, AbiFunction>()
  for (const item of parsed.abi ?? []) {
    if (item.type !== 'function' || typeof item.name !== 'string') continue
    names.add(item.name)
    signatures.set(item.name, {
      name: item.name,
      inputs: (item.inputs ?? []).map((i) => ({ name: i.name ?? '', type: i.type ?? '' })),
    })
  }
  return {
    ok: true,
    initCodeHash: keccakHex(object),
    initCodeBytes: hexToBytes(object).length,
    abiFunctions: names,
    signatures,
  }
}

/**
 * Every function this walkthrough claims exists. Checked against the compiled
 * ABI, so the narration cannot drift away from the contract without the demo
 * saying so out loud.
 */
const NARRATED_FUNCTIONS = [
  'bind',
  'acceptService',
  'activate',
  'suspend',
  'resume',
  'claim',
  'claimToken',
  'sweep',
  'settle',
  'withdrawDev',
  'pushDev',
  'withdrawOperator',
  'withdrawReferrer',
  'pullBudget',
  'refundUnproven',
  'setDial',
  'applyDial',
  'terminate',
  'disclaim',
  'poison',
  'operatorWithdraw',
  'emergencyDevRelease',
  'state',
  'devOwed',
  'budgetAvailable',
  'operatorOwed',
  'checkSolvency',
] as const

// ---------------------------------------------------------------------------
// THE LEDGER MODEL. Mirrors CoinVault._splitOf and _credit exactly.
// ---------------------------------------------------------------------------

type VaultState =
  | 'UNBOUND'
  | 'PASSTHROUGH'
  | 'BOUND'
  | 'PENDING'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'POISONED'
  | 'TERMINATED'

interface Legs {
  dev: bigint
  budget: bigint
  operator: bigint
  referrer: bigint
}

const BPS = 10_000n

class VaultModel {
  state: VaultState = 'UNBOUND'
  /** The consented take. Ratchets toward zero and never back. Invariant I5. */
  operatorCeilingBps: bigint
  budgetBps: bigint
  token: string | undefined
  readonly legs = new Map<string, Legs>()

  readonly operatorBps: number
  readonly referrerBps: number

  constructor(operatorBps: number, budgetBps: number, referrerBps: number) {
    this.operatorBps = operatorBps
    this.referrerBps = referrerBps
    this.operatorCeilingBps = BigInt(operatorBps)
    this.budgetBps = BigInt(budgetBps)
  }

  private legsOf(asset: string): Legs {
    const existing = this.legs.get(asset)
    if (existing !== undefined) return existing
    const fresh: Legs = { dev: 0n, budget: 0n, operator: 0n, referrer: 0n }
    this.legs.set(asset, fresh)
    return fresh
  }

  /** THE SPLIT RULE, stated exactly once. CoinVault._splitOf. */
  splitOf(asset: string, amount: bigint): Legs {
    if (this.state !== 'ACTIVE' || (asset !== NATIVE && asset === this.token)) {
      return { dev: amount, budget: 0n, operator: 0n, referrer: 0n }
    }
    const opGross = (amount * this.operatorCeilingBps) / BPS
    const budget = (amount * this.budgetBps) / BPS
    // The dev leg absorbs the rounding remainder, so integer division can only
    // ever round in the client's favour and the four legs sum to `amount`.
    const dev = amount - opGross - budget
    const referrer = (opGross * BigInt(this.referrerBps)) / BPS
    return { dev, budget, operator: opGross - referrer, referrer }
  }

  /** CoinVault._credit. */
  credit(asset: string, amount: bigint): Legs {
    const split = this.splitOf(asset, amount)
    const legs = this.legsOf(asset)
    legs.dev += split.dev
    legs.budget += split.budget
    legs.operator += split.operator
    legs.referrer += split.referrer
    return split
  }

  /** CoinVault._stopCharging: the ceiling ratchets to zero, permanently. */
  stopCharging(next: VaultState): void {
    this.operatorCeilingBps = 0n
    this.budgetBps = 0n
    this.state = next
  }

  accounted(asset: string): bigint {
    const l = this.legsOf(asset)
    return l.dev + l.budget + l.operator + l.referrer
  }
}

const NATIVE = '0x0000000000000000000000000000000000000000'

/** Minor units to a display string. Truncates; never rounds a claim upward. */
function minor(amount: bigint, decimals: number, symbol: string): string {
  const scale = 10n ** BigInt(decimals)
  const whole = (amount / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = (amount % scale).toString().padStart(decimals, '0').slice(0, 2)
  return `${whole}.${frac} ${symbol}`
}

function legTable(model: VaultModel, asset: string, symbol: string, decimals: number): string {
  const legs = model.legs.get(asset) ?? { dev: 0n, budget: 0n, operator: 0n, referrer: 0n }
  return table(
    [
      { leg: 'dev (pull-only, no operator key reaches it)', v: legs.dev, dest: 'DEV_PAYOUT, an immutable' },
      { leg: 'budget (dev-elected procurement)', v: legs.budget, dest: 'a vendor, via pullBudget only' },
      { leg: 'operator fee', v: legs.operator, dest: 'OPERATOR_TREASURY, an immutable' },
      { leg: 'referrer (carved out of the operator leg)', v: legs.referrer, dest: 'REFERRER, an immutable' },
    ],
    [
      { header: 'leg', value: (r) => r.leg },
      { header: 'balance', value: (r) => minor(r.v, decimals, symbol), align: 'right' },
      { header: 'only destination', value: (r) => r.dest },
    ],
  )
}

export function runVaultDemo(): DemoResult {
  const artifact = loadArtifact()
  const scenes: Scene[] = []
  const facts: Pair[] = []
  const USDG = { symbol: 'USDG', decimals: 6 }

  // -------------------------------------------------------------------------
  // 1. Consent -> salt -> predicted address. COMPUTED.
  // -------------------------------------------------------------------------
  {
    const encoded = encodeConsent(CONSENT)
    const salt = keccakHex(encoded)
    const repriced = { ...CONSENT, operatorBps: CONSENT.operatorBps + 200 }
    const repricedSalt = keccakHex(encodeConsent(repriced))

    if (!artifact.ok) {
      scenes.push({
        id: 'vault.create2',
        title: 'Predicted vault address from the signed consent',
        proves:
          'The salt is the entire agreement, so a vault deployed at one take rate lives at a different address from the same dev at another.',
        verdict: refused('CANNOT COMPUTE', artifact.reason),
        given: [{ label: 'artifact', value: ARTIFACT }],
        path: ['the compiled CoinVault artifact could not be read, so no address is predicted'],
        blocks: [
          {
            label: 'what would be computed',
            text: 'keccak256(0xff ++ deployer ++ keccak256(abi.encode(consent)) ++ keccak256(creationCode))',
          },
        ],
      })
    } else {
      const predicted = predictCreate2(DEPLOYER, salt, artifact.initCodeHash)
      const repricedAddress = predictCreate2(DEPLOYER, repricedSalt, artifact.initCodeHash)
      scenes.push({
        id: 'vault.create2',
        title: 'Consent -> salt -> the address the vault will live at',
        proves:
          'THE SALT IS THE ENTIRE AGREEMENT. Every economic term is inside keccak256(abi.encode(consent)), so repricing an existing customer is not a forbidden operation - it is an unrepresentable one. The vault at the old address cannot be redeployed, and the vault at the new address is a different contract the dev never signed for.',
        verdict: ok('PREDICTED', `from the compiled creation code (${String(artifact.initCodeBytes)} bytes)`),
        given: [
          { label: 'operator take', value: `${String(CONSENT.operatorBps)}bps, in the salt preimage` },
          { label: 'dial ceiling', value: `${String(CONSENT.budgetBpsMax)}bps, in the salt preimage` },
          { label: 'dev payout', value: `${CONSENT.devPayout} - the sole destination of the dev leg` },
          { label: 'referrer', value: `${String(CONSENT.referrerBps)}bps of the OPERATOR's slice, never of the dev's` },
        ],
        path: [
          'the eleven consent fields are abi.encode-d in ConsentLib order - reordering them silently moves every address ever predicted',
          'salt = keccak256 of that encoding',
          'initCodeHash = keccak256 of the compiled CoinVault creation code, read from contracts/out',
          'address = keccak256(0xff ++ deployer ++ salt ++ initCodeHash), low 20 bytes, EIP-55 checksummed',
          'the deployer is the VaultDeployer, not the factory: the factory would be over EIP-170 with the creation code embedded',
        ],
        blocks: [
          {
            label: 'computed',
            text: [
              `abi.encode(consent) : ${String(encoded.length / 2 - 1)} bytes, 11 words`,
              `salt                : ${salt}`,
              `initCodeHash        : ${artifact.initCodeHash}`,
              `PREDICTED VAULT     : ${predicted}`,
            ].join('\n'),
          },
          {
            label: `the same dev at ${String(repriced.operatorBps)}bps instead`,
            text: [
              `salt                : ${repricedSalt}`,
              `PREDICTED VAULT     : ${repricedAddress}`,
              '',
              'A different rate is a different salt is a different address. There is no admin',
              'function to change a rate because there is no address at which a changed rate',
              'could live.',
            ].join('\n'),
          },
        ],
      })

      facts.push(
        { label: 'CoinVault creation code', value: `${String(artifact.initCodeBytes)} bytes` },
        { label: 'CREATE2 init code hash', value: artifact.initCodeHash },
        { label: 'predicted vault', value: predicted },
      )
    }
  }

  // -------------------------------------------------------------------------
  // 2. ABI cross-check. COMPUTED, and it fails loudly.
  // -------------------------------------------------------------------------
  {
    const missing = artifact.ok
      ? NARRATED_FUNCTIONS.filter((name) => !artifact.abiFunctions.has(name))
      : [...NARRATED_FUNCTIONS]
    const forbidden = artifact.ok
      ? [...artifact.abiFunctions].filter((name) => /^(upgradeTo|setOwner|transferOwnership|pause|setFeeRecipient|setOperator)$/.test(name))
      : []

    scenes.push({
      id: 'vault.abi_check',
      title: 'Every function this walkthrough narrates, checked against the compiled ABI',
      proves:
        'The rest of this subcommand is a narration, so it is pinned to the contract that actually compiled. A function this report claims exists and the ABI does not have is printed as MISSING and the run reports itself incomplete - it never narrates a fiction.',
      verdict:
        !artifact.ok
          ? refused('CANNOT CHECK', artifact.reason)
          : missing.length === 0
            ? ok('ALL PRESENT', `${String(NARRATED_FUNCTIONS.length)} narrated functions found in an ABI of ${String(artifact.abiFunctions.size)}`)
            : refused('ABI MISMATCH', `${String(missing.length)} narrated functions are not in the compiled ABI`),
      given: [
        { label: 'artifact', value: 'contracts/out/CoinVault.sol/CoinVault.json' },
        { label: 'narrated', value: `${String(NARRATED_FUNCTIONS.length)} functions` },
        { label: 'compiled', value: artifact.ok ? `${String(artifact.abiFunctions.size)} functions` : 'UNKNOWN' },
      ],
      path: [
        'read the compiled ABI',
        'checked every function named in this walkthrough against it',
        'checked that no owner, upgrade, pause or fee-switch function exists - their ABSENCE is the property',
      ],
      blocks: [
        {
          label: 'result',
          text: [
            `missing from the ABI      : ${missing.length === 0 ? 'none' : missing.join(', ')}`,
            `owner/upgrade/pause found : ${forbidden.length === 0 ? 'none - no owner, no upgrade path, no admin key, no proxy' : forbidden.join(', ')}`,
          ].join('\n'),
        },
      ],
    })
  }

  // -------------------------------------------------------------------------
  // 3-7. The lifecycle. NARRATED against the model above.
  // -------------------------------------------------------------------------
  const model = new VaultModel(CONSENT.operatorBps, TERMS.budgetBpsDefault, CONSENT.referrerBps)

  // Fees arrive before the vault is bound. This is the ordinary case: the dev
  // points recipiency at the vault and then reads the terms.
  {
    const amount = 1_000_000000n // 1,000.00 USDG
    model.credit(QUOTE_ASSET, amount)
    scenes.push({
      id: 'vault.unbound',
      title: 'Fees arrive while the vault is UNBOUND',
      proves:
        'The vault charges in exactly one state. Before activation the split rule\'s first branch takes everything, so a dev who points recipiency at the vault and then walks away has lost nothing at all.',
      verdict: ok('100% TO THE DEV', 'state is UNBOUND, so the operator leg is not reachable'),
      given: [
        { label: 'state', value: 'UNBOUND' },
        { label: 'credited', value: minor(amount, USDG.decimals, USDG.symbol) },
        { label: 'consented take', value: `${String(CONSENT.operatorBps)}bps - and it takes nothing here` },
      ],
      path: [
        'settle() read the vault\'s own balance and found more than the four legs account for',
        'the difference was credited through _splitOf',
        'state != ACTIVE, so the first branch returned (amount, 0, 0, 0)',
      ],
      blocks: [{ label: 'legs after this credit', text: legTable(model, QUOTE_ASSET, USDG.symbol, USDG.decimals), plain: true }],
    })
  }

  // bind -> acceptService -> activate
  {
    model.token = COIN.token
    model.state = 'BOUND'
    model.state = 'PENDING'
    model.state = 'ACTIVE'
    scenes.push({
      id: 'vault.activate',
      title: 'bind -> acceptService -> activate',
      proves:
        'Three transitions, three different signers, and no charging until all three have happened. The operator binds the token, the DEV accepts service, and only then can the operator activate. There is no path from UNBOUND to ACTIVE that the dev is not part of.',
      verdict: ok('ACTIVE', 'the only state in which any fee is ever charged'),
      given: [
        { label: 'bind', value: `operator, or anyone holding an operator signature: token := ${COIN.token}` },
        { label: 'acceptService', value: 'DEV ONLY. BOUND -> PENDING.' },
        { label: 'activate', value: 'operator only. PENDING -> ACTIVE.' },
      ],
      path: [
        'bind() sets the launch token once and only from UNBOUND; it can never be rebound',
        'acceptService() is onlyDev - the operator cannot start its own meter',
        'activate() is onlyOperator - the dev cannot start ours either',
        'every transition emits StateChanged(from, to)',
      ],
      blocks: [
        {
          label: 'the state machine',
          text: [
            'UNBOUND     deployed, recipiency not confirmed.  100% dev, zero take',
            'BOUND       recipiency confirmed.                no charging',
            'PENDING     dev accepted.                        no charging',
            'ACTIVE      -------------------------------->    THE ONLY CHARGING STATE',
            'SUSPENDED   paused, reversible.                  no charging',
            'PASSTHROUGH operator has left, permanently.      100% dev, terminal',
            'POISONED    screening/sanctions kill.            operator leg frozen, terminal',
            'TERMINATED  dev exited.                          100% dev, terminal',
          ].join('\n'),
        },
      ],
    })
  }

  // sweep -> settle -> the four legs
  {
    const amount = 1_000_000000n
    const split = model.credit(QUOTE_ASSET, amount)
    const dial = Number(model.budgetBps)
    scenes.push({
      id: 'vault.settle',
      title: 'sweep -> settle -> the four legs',
      proves:
        'settle() makes NO external call other than balanceOf and moves no tokens whatsoever. It cannot swap, wrap or convert because it never calls anything that could - so the asset that arrives is the asset that is credited, and the asset credited to the dev leg is the asset withdrawDev later transfers. That is invariant I2, and it is structural rather than tested by sampling.',
      verdict: ok(
        'CREDITED',
        `${minor(amount, USDG.decimals, USDG.symbol)} partitioned across four legs with no remainder`,
      ),
      given: [
        { label: 'state', value: 'ACTIVE' },
        { label: 'credited', value: minor(amount, USDG.decimals, USDG.symbol) },
        { label: 'operator ceiling', value: `${String(model.operatorCeilingBps)}bps` },
        { label: "dev's dial", value: `${String(dial)}bps, elected by the dev, capped by the consent at ${String(CONSENT.budgetBpsMax)}bps` },
      ],
      path: [
        'sweep() loops the quote assets, each isolated behind its own external self-call so ONE PAUSED PROXY CANNOT BLOCK THE OTHERS',
        'claim()/claimToken() pull from the Venue escrow, which is msg.sender-only, so the vault must be the caller',
        'settle() recognised the unaccounted balance and partitioned it',
        'the dev leg absorbed the rounding remainder, so integer division rounds only in the client\'s favour',
        'the referrer slice was carved out of the OPERATOR leg, never out of the dev\'s',
      ],
      blocks: [
        {
          label: 'this credit',
          text: [
            `dev      ${minor(split.dev, USDG.decimals, USDG.symbol).padStart(18)}`,
            `budget   ${minor(split.budget, USDG.decimals, USDG.symbol).padStart(18)}`,
            `operator ${minor(split.operator, USDG.decimals, USDG.symbol).padStart(18)}`,
            `referrer ${minor(split.referrer, USDG.decimals, USDG.symbol).padStart(18)}`,
            `         ${'-'.repeat(18)}`,
            `sum      ${minor(split.dev + split.budget + split.operator + split.referrer, USDG.decimals, USDG.symbol).padStart(18)}  (exactly the amount credited; no dust escapes)`,
          ].join('\n'),
        },
        { label: 'legs, cumulative', text: legTable(model, QUOTE_ASSET, USDG.symbol, USDG.decimals), plain: true },
      ],
    })
  }

  // The launch token arrives. Invariant I6.
  {
    const windfall = 40_000_000_000000000000000000n
    const split = model.credit(COIN.token, windfall)
    scenes.push({
      id: 'vault.launch_token',
      title: 'The launch token itself arrives - the anti-snipe windfall',
      proves:
        'The launch token is never charged at all, in any state. It is not a quote-denominated fee: it is the client\'s own supply arriving by vest, by airdrop, or as the 99% anti-snipe tax at t=0 - which looks like a windfall and must not be taxed as revenue. That is invariant I6.',
      verdict: ok('100% TO THE DEV', 'the second branch of the split rule, while the vault is ACTIVE'),
      given: [
        { label: 'state', value: 'ACTIVE - the charging state' },
        { label: 'asset', value: `${COIN.token} (the launch token)` },
        { label: 'credited', value: minor(windfall, 18, COIN.symbol) },
      ],
      path: [
        'settle() was called for the launch token',
        '_isLaunchToken returned true, so the split rule took its first branch again',
        'the operator leg received nothing, in the one state where it otherwise would',
      ],
      blocks: [
        {
          label: 'this credit',
          text: [
            `dev      ${minor(split.dev, 18, COIN.symbol)}`,
            `operator ${minor(split.operator, 18, COIN.symbol)}`,
          ].join('\n'),
        },
      ],
    })
  }

  // Payouts. COMPUTED from the ABI.
  {
    const MOVERS = ['withdrawDev', 'pushDev', 'withdrawOperator', 'withdrawReferrer', 'pullBudget'] as const
    const rows = MOVERS.map((name) => {
      const fn = artifact.ok ? artifact.signatures.get(name) : undefined
      if (fn === undefined) {
        return { name, signature: 'MISSING FROM THE ABI', addressInputs: 'UNKNOWN' }
      }
      const addressInputs = fn.inputs.filter((i) => i.type === 'address')
      return {
        name,
        signature: `${name}(${fn.inputs.map((i) => `${i.type} ${i.name}`).join(', ')})`,
        addressInputs:
          addressInputs.length === 0
            ? 'none'
            : addressInputs.map((i) => i.name).join(', '),
      }
    })
    // The ONLY address parameter any money-mover is permitted is the asset.
    const offending = rows.filter(
      (r) => r.addressInputs !== 'none' && r.addressInputs !== 'asset',
    )

    scenes.push({
      id: 'vault.payouts',
      title: 'Where money can go - read off the compiled ABI',
      proves:
        'Every function that moves money has a HARDCODED destination and takes no payee argument. There is no third-party payee - not by policy, but because the function has nowhere to put one. That is the unlicensed-money-transmission defence, and it is checkable by reading five signatures rather than by trusting a sentence.',
      verdict:
        !artifact.ok
          ? refused('CANNOT CHECK', artifact.reason)
          : offending.length === 0
            ? refused(
                'NO PAYEE ARGUMENT EXISTS',
                'a compromised operator key cannot redirect a payout, because there is no parameter to redirect it with',
              )
            : refused(
                'ABI MISMATCH',
                `${String(offending.length)} money-movers take an address that is not the asset: ${offending.map((o) => o.name).join(', ')}`,
              ),
      given: [
        { label: 'dev leg', value: `-> DEV_PAYOUT (${COIN.devPayout}), an immutable from the signed consent` },
        { label: 'operator fee', value: `-> OPERATOR_TREASURY (${OPERATOR_TREASURY}), a FACTORY immutable that can never rotate` },
        { label: 'referrer', value: '-> REFERRER, an immutable from the signed consent' },
        { label: 'procurement', value: '-> OPERATOR_TREASURY, as a REIMBURSEMENT against a countersigned invoice' },
      ],
      path: [
        'the operator buys all media as PRINCIPAL, in its own name, with its own money',
        'pullBudget repays the operator treasury against an invoice hash that can be used exactly once',
        "the vendor's countersignature is recorded as EVIDENCE, not checked as AUTHORITY - a registry that can block a fund movement is a registry that affects funds",
        'pushDev(asset) is permissionless, which is what makes the dev leg pull-only rather than operator-gated: anyone may push the dev their own money',
        'refundUnproven(asset) is a pure leg-to-leg move that returns budget whose delivery predicate never proved out',
      ],
      blocks: [
        {
          label: 'every money-moving signature in the compiled ABI',
          text: table(rows, [
            { header: 'function', value: (r) => r.signature },
            { header: 'address parameters', value: (r) => r.addressInputs },
          ]),
          plain: true,
        },
        {
          label: 'the complete list of destinations this contract can reach',
          text: [
            'DEV_PAYOUT         immutable, from the consent, inside the CREATE2 salt',
            'OPERATOR_TREASURY  immutable, from the factory',
            'REFERRER           immutable, from the consent, inside the CREATE2 salt',
            '',
            'There is no fourth. An operator key compromise costs the operator its own',
            'revenue and can never reach a dev leg.',
          ].join('\n'),
        },
      ],
    })
  }

  // POISONED: screening kills the engagement after activation.
  {
    const poisoned = new VaultModel(CONSENT.operatorBps, Number(model.budgetBps), CONSENT.referrerBps)
    poisoned.token = COIN.token
    poisoned.state = 'ACTIVE'
    poisoned.credit(QUOTE_ASSET, 1_000_000000n)
    const earned = poisoned.legs.get(QUOTE_ASSET)?.operator ?? 0n
    poisoned.stopCharging('POISONED')
    const afterPoison = poisoned.credit(QUOTE_ASSET, 1_000_000000n)

    scenes.push({
      id: 'vault.poisoned',
      title: 'Screening blocks the coin after it was already activated',
      proves:
        'poison() freezes the OPERATOR side only. It does not touch the dev leg and does not block withdrawDev, pushDev, settle, salvage or refundUnproven - freezing the client\'s own money would be the custody claim this whole architecture exists to avoid. The operator loses what it had already earned; the dev loses nothing.',
      verdict: refused(
        'OPERATOR LEG FROZEN',
        `withdrawOperator and withdrawReferrer revert with OperatorLegFrozen; ${minor(earned, USDG.decimals, USDG.symbol)} already earned is stranded`,
      ),
      given: [
        { label: 'trigger', value: 'a re-screen returned BLOCKED (see `demo screening`)' },
        { label: 'caller', value: 'the operator. onlyOperator, irreversible.' },
        { label: 'operator earned', value: minor(earned, USDG.decimals, USDG.symbol) },
        { label: 'dev leg', value: 'untouched, and still withdrawable' },
      ],
      path: [
        'operatorFrozen := true, so withdrawOperator and withdrawReferrer now revert',
        '_stopCharging() zeroed the take AND the dial - freezing the ability to SPEND procurement without freezing its ACCRUAL is the one combination that traps client money',
        'the state became POISONED, which is terminal',
        'salvage() becomes available in POISONED and routes unaccounted surplus to the DEV leg and only to the dev leg',
        'every subsequent credit goes 100% to the dev, by the same one-line split rule',
      ],
      blocks: [
        {
          label: 'a further 1,000.00 USDG credited after poisoning',
          text: [
            `dev      ${minor(afterPoison.dev, USDG.decimals, USDG.symbol)}`,
            `operator ${minor(afterPoison.operator, USDG.decimals, USDG.symbol)}`,
          ].join('\n'),
        },
        {
          label: 'what each party can still do',
          text: [
            'dev      : withdrawDev, pushDev, settle, salvage, refundUnproven - all still work',
            'operator : withdrawOperator REVERTS. pullBudget REVERTS. Nothing further accrues.',
          ].join('\n'),
        },
      ],
    })
  }

  // terminate(), with a reverting handback.
  {
    const before = { ...(model.legs.get(QUOTE_ASSET) ?? { dev: 0n, budget: 0n, operator: 0n, referrer: 0n }) }
    model.stopCharging('TERMINATED')
    const handbackReverted = true
    const after = model.credit(QUOTE_ASSET, 500_000000n)

    scenes.push({
      id: 'vault.terminate',
      title: 'terminate(), and the handback reverts',
      proves:
        'Exit is unconditional. terminate() ratchets the take to zero and sets the state FIRST, and only THEN attempts to hand recipiency back - inside a try/catch, ignoring the result. A third party\'s access control never gates our own exit, and a hostile or simply broken external contract cannot trap a client in the engagement.',
      verdict: ok(
        'TERMINATED',
        `handback reverted (${String(handbackReverted)}) and terminate() succeeded anyway`,
      ),
      given: [
        { label: 'caller', value: 'the dev. onlyDev, no notice period, no operator consent' },
        { label: 'handback', value: 'reverted - the external registry refused the call' },
        { label: 'take before', value: `${String(CONSENT.operatorBps)}bps` },
        { label: 'take after', value: `${String(model.operatorCeilingBps)}bps, permanently. Invariant I5: monotone toward zero.` },
      ],
      path: [
        '_requireLive() confirmed the vault was not already terminal',
        '_stopCharging() zeroed the operator ceiling and the dial, froze the budget, and set the state - BEFORE any external call',
        '_tryHandback(DEV_PAYOUT) attempted to return fee recipiency and REVERTED',
        'the revert was caught and ignored; Terminated(msg.sender, false) was emitted with the failure recorded honestly',
        'residual escrow credit does NOT follow recipiency - it stays under this vault, which can still claim() and settle() it, at 100% to the dev',
      ],
      blocks: [
        {
          label: 'a further 500.00 USDG credited AFTER termination',
          text: [
            `dev      ${minor(after.dev, USDG.decimals, USDG.symbol)}`,
            `budget   ${minor(after.budget, USDG.decimals, USDG.symbol)}`,
            `operator ${minor(after.operator, USDG.decimals, USDG.symbol)}`,
            `referrer ${minor(after.referrer, USDG.decimals, USDG.symbol)}`,
          ].join('\n'),
        },
        { label: 'legs, cumulative', text: legTable(model, QUOTE_ASSET, USDG.symbol, USDG.decimals), plain: true },
        {
          label: 'the operator leg is frozen at what it had already earned',
          text: `${minor(before.operator, USDG.decimals, USDG.symbol)} before terminate, ${minor(
            (model.legs.get(QUOTE_ASSET) ?? { operator: 0n }).operator,
            USDG.decimals,
            USDG.symbol,
          )} after. Nothing further can ever be added to it.`,
        },
      ],
    })
  }

  const abiComplete = artifact.ok && NARRATED_FUNCTIONS.every((n) => artifact.abiFunctions.has(n))
  facts.push(
    { label: 'lifecycle arithmetic', value: 'MODELLED in tools/lib/demo/vault.ts, mirroring CoinVault._splitOf' },
    { label: 'addresses and ABI', value: artifact.ok ? 'COMPUTED from contracts/out/CoinVault.sol' : 'UNKNOWN - artifact unreadable' },
    { label: 'narration pinned to the ABI', value: abiComplete ? 'yes, all narrated functions present' : 'NO - see the ABI scene' },
    { label: 'the executable proof', value: 'forge test --root contracts (137 tests, 9 suites)' },
    { label: 'owner / upgrade / pause functions', value: 'none exist - that is the property, not an omission' },
  )

  return summarise(
    'vault',
    'consent to termination, and the dev keeps 100% in every state but one',
    [
      'The vault charges in exactly one state and the launch token is never charged at all.',
      'The first two scenes are COMPUTED from the compiled contract - the CREATE2 address the',
      'signed consent produces, and a check that every function narrated below is really in the',
      'ABI. The rest is a narrated walkthrough of a ledger model that mirrors CoinVault._splitOf;',
      'the executable proof of the same thing is `forge test --root contracts`.',
    ],
    scenes,
    facts,
    // A walkthrough that could not pin itself to the compiled contract is a
    // story, not a demonstration, and the run says so rather than reading as a
    // clean pass.
    artifact.ok
      ? abiComplete
        ? []
        : [
            'The compiled ABI does not carry every function this walkthrough narrates. The narration ' +
              'and the contract have drifted; trust the contract.',
          ]
      : [
          `The compiled CoinVault artifact could not be read, so no address was predicted and the ` +
            `narration is unpinned. ${artifact.reason}`,
        ],
  )
}
