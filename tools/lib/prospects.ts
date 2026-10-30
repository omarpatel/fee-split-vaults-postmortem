/**
 * prospects - the shared, PURE logic behind `tools/prospects.ts` (the ranked
 * list) and `tools/eligibility.ts` (the single-coin query).
 *
 * WHY THIS FILE EXISTS. VERDICT.md says STOP because only 73 of ~125 standing
 * T1 coins are winnable against a break-even requirement of 109. That number is
 * measured and it is right. But a verdict is not a work instruction: an operator
 * deciding whether to proceed at a smaller scale needs to know WHICH 73, ranked,
 * with a way to reach them - and which 52 are gone, to whom, and whether the
 * contract holding them has any way out. Nobody has ever produced that list.
 *
 * Everything here is pure: it takes bytes that were already fetched and returns
 * a classification. All I/O lives in the two CLIs. That is what lets the tests
 * run against recorded fixtures and never touch an endpoint, so a red test means
 * our reasoning broke rather than someone else's node moved.
 *
 * THE FOUR THINGS THIS FILE DECIDES, and the evidence each one rests on:
 *
 *   1. IS IT AT THE GATE?   Trailing-7-day MEDIAN of daily QF, per the tier
 *      definition in config/protocol.ts. A median, not a mean - a mean is
 *      farmable with one day of wash volume.
 *
 *   2. CAN IT BE SIGNED?    Reassignment of creator-fee recipiency on this chain
 *      is a closed set of three paths, each established live by simulated
 *      eth_call in the reconciliation behind VERDICT.md §4:
 *        hook.setCreatorFeeRecipient          -> NotFactory() for every sender
 *        factory.setCreatorFeeRecipient       -> OwnableUnauthorizedAccount
 *                                                (owner is Venue, not us)
 *        factory.transferCreatorFeeRecipient  -> succeeds ONLY when msg.sender
 *                                                is the CURRENT recipient
 *      So the current recipient must make the call. An EOA can. A contract can
 *      only if its own code contains something that will make that call. That is
 *      the whole winnability test and it is mechanical, not commercial.
 *
 *   3. WHAT IS IT WORTH?    Expected value to the operator, with the ranking
 *      function named in the output and swappable by flag. A ranking whose
 *      formula is not printed is an opinion wearing a number's clothes.
 *
 *   4. HOW DO WE REACH IT?  The launch metadata the token itself carries. This
 *      is ATTACKER-AUTHORED TEXT. See the CONTACT SURFACE section below.
 *
 * WHAT IS NOT DECIDED HERE. Nothing in this file estimates a win rate. The
 * 10% used downstream is an assumption with zero observations behind it and it
 * is carried as a flag, printed on every report, never hardcoded into a score.
 */

import { creatorNetBps } from '../../config/protocol.ts'
import type { SurvivalPoint } from './stats.ts'

export const PROSPECTS_SCHEMA = 'prospects-1'

// ---------------------------------------------------------------------------
// Recipient classification, from bytecode
// ---------------------------------------------------------------------------

/**
 * What a fee recipient IS.
 *
 * A naive `code.length > 0` gets this wrong in BOTH directions and the error is
 * commercially decisive either way:
 *
 *   - An EIP-7702 delegation designator is 23 bytes of code sitting on an
 *     address that is still a private-key EOA. `isContract` says true; the dev
 *     is signable and the coin is winnable.
 *   - An EIP-1167 clone or a beacon proxy is 45-321 bytes that do nothing but
 *     delegate. What decides winnability is the IMPLEMENTATION behind it, and
 *     the proxy's own code will never contain the exit.
 */
export type RecipientClass =
  | 'EOA'
  | 'EOA_7702'
  | 'CLONE_1167'
  | 'BEACON_PROXY'
  | 'SAFE_PROXY'
  | 'OTHER_CONTRACT'
  /** Code was never read. Not a class - the absence of one. */
  | 'UNKNOWN'

export interface RecipientClassification {
  address: string
  cls: RecipientClass
  /** null when the code was not read. Never defaulted to 0. */
  codeSize: number | null
  /** EIP-7702 delegate target, when cls is EOA_7702. */
  delegate: string | null
  /** Resolved implementation, when one could be resolved from the code alone. */
  implementation: string | null
  /** Beacon address found in the proxy body, when cls is BEACON_PROXY. */
  beacon: string | null
  /** Every 20-byte address-shaped word in the runtime code. Beacon candidates. */
  addressWords: string[]
}

/** EIP-1167 minimal-proxy runtime prefix. */
const CLONE_1167_PREFIX = '363d3d373d3d3d363d73'
/** EIP-7702 delegation designator prefix, on a 23-byte code. */
const EIP7702_PREFIX = 'ef0100'

function normalize(address: string): string {
  return address.toLowerCase()
}

/**
 * Classify one recipient from its runtime code.
 *
 * `code` of `null` means the read did not happen or failed. That is UNKNOWN and
 * it stays UNKNOWN: a failed eth_getCode rendered as "EOA" would promote a
 * locked distributor into the prospect list, which is exactly the direction an
 * error must never fall.
 *
 * `knownBeacons` lets the caller supply beacons it has already resolved (the
 * incumbent's, most importantly) so the common case needs no extra round trip.
 */
export function classifyRecipient(
  address: string,
  code: string | null,
  knownBeacons: readonly string[] = [],
): RecipientClassification {
  const base: RecipientClassification = {
    address: normalize(address),
    cls: 'UNKNOWN',
    codeSize: null,
    delegate: null,
    implementation: null,
    beacon: null,
    addressWords: [],
  }
  if (code === null) return base

  const hex = code === '0x' ? '' : code.slice(2).toLowerCase()
  const codeSize = hex.length / 2
  if (codeSize === 0) return { ...base, cls: 'EOA', codeSize: 0 }

  const addressWords = [
    ...new Set(
      [...hex.matchAll(/0{24}([0-9a-f]{40})/g)]
        .map((m) => `0x${m[1]!}`)
        .filter((a) => a !== `0x${'0'.repeat(40)}`),
    ),
  ]

  if (hex.startsWith(EIP7702_PREFIX) && codeSize === 23) {
    return { ...base, cls: 'EOA_7702', codeSize, delegate: `0x${hex.slice(6, 46)}`, addressWords }
  }
  if (hex.startsWith(CLONE_1167_PREFIX)) {
    return {
      ...base,
      cls: 'CLONE_1167',
      codeSize,
      implementation: `0x${hex.slice(20, 60)}`,
      addressWords,
    }
  }
  for (const beacon of knownBeacons) {
    if (hex.includes(normalize(beacon).slice(2))) {
      return { ...base, cls: 'BEACON_PROXY', codeSize, beacon: normalize(beacon), addressWords }
    }
  }
  return { ...base, cls: 'OTHER_CONTRACT', codeSize, addressWords }
}

/** True when the address holds a private key that can sign a transaction. */
export function isSignable(cls: RecipientClass): boolean {
  return cls === 'EOA' || cls === 'EOA_7702'
}

// ---------------------------------------------------------------------------
// Exit paths
// ---------------------------------------------------------------------------

export type ExitKind =
  /** The contract itself can call factory.transferCreatorFeeRecipient. */
  | 'direct'
  /** The contract can be made to call ANYTHING by whoever controls it. */
  | 'generic'

export interface ExitSelector {
  selector: string
  signature: string
  kind: ExitKind
  why: string
}

/**
 * The selectors that, present in a recipient's code, mean recipiency can move.
 *
 * `direct` is the strict reading and it is the default, because it is the only
 * one that is self-evidently sufficient: the function exists, it takes the two
 * arguments the factory takes, and calling it moves the coin.
 *
 * `generic` is an escape hatch whose SUFFICIENCY is conditional - a Safe can
 * call the factory, but only if the current signer set agrees, and we cannot
 * see the signer set from the bytecode. Counting those as winnable inflates the
 * list with coins whose dev may not control the wallet any more. They are
 * therefore reported, separately and by name, and only counted as winnable
 * under --exit-mode broad. The default reproduces the 73 in VERDICT.md.
 */
export const EXIT_SELECTORS: readonly ExitSelector[] = [
  {
    selector: '0x2931861b',
    signature: 'transferCreatorFeeRecipient(address,address)',
    kind: 'direct',
    why: 'forwards to the factory function that moves recipiency; msg.sender is this contract, which is the current recipient, so the call succeeds',
  },
  {
    selector: '0xe102c9aa',
    signature: 'setCreatorFeeRecipient(address,address)',
    kind: 'direct',
    why: 'the factory-side name; a recipient carrying it is a purpose-built forwarder',
  },
  {
    selector: '0xb61d27f6',
    signature: 'execute(address,uint256,bytes)',
    kind: 'generic',
    why: 'arbitrary outbound call. Sufficient only if whoever may call it is the dev',
  },
  {
    selector: '0xe9ae5c53',
    signature: 'execute(bytes32,bytes)',
    kind: 'generic',
    why: 'ERC-7821 batched execution. Same conditionality as execute(address,uint256,bytes)',
  },
  {
    selector: '0xf986e6f4',
    signature: 'executeBatch((address,uint256,bytes)[])',
    kind: 'generic',
    why: 'arbitrary outbound calls, batched',
  },
  {
    selector: '0x6a761202',
    signature:
      'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)',
    kind: 'generic',
    why: 'Gnosis Safe. The signer set can call the factory - but the signer set is not visible in bytecode',
  },
  {
    selector: '0x6dbf2fa0',
    signature: 'call(address,uint256,bytes)',
    kind: 'generic',
    why: 'arbitrary outbound call under another name',
  },
]

export interface ExitFinding {
  /** Selectors found, with the code region each was found in. */
  hits: Array<{ selector: string; signature: string; kind: ExitKind; foundIn: 'proxy' | 'impl' }>
  hasDirect: boolean
  hasGeneric: boolean
  /** null when no code was available to scan. Never false-by-default. */
  scanned: boolean
}

/**
 * Scan a recipient's own code AND its implementation's code for an exit.
 *
 * Both are scanned because a clone's own 45 bytes never contain anything: the
 * dispatch table that matters lives in the implementation. Scanning only the
 * proxy would report every clone as locked, and three of them are not.
 *
 * A selector appearing in bytecode is evidence the function is DISPATCHABLE, not
 * proof it is callable by us - access control is invisible at this level. That
 * asymmetry is deliberate and it runs the safe way: it can only ever make a coin
 * look MORE winnable than it is, so a prospect that survives to the list is
 * still worth a manual read of the contract before anyone spends money on it.
 * The reverse error - marking a winnable coin locked - cannot happen here.
 */
export function scanExitPath(
  ownCode: string | null,
  implCode: string | null,
): ExitFinding {
  if (ownCode === null && implCode === null) {
    return { hits: [], hasDirect: false, hasGeneric: false, scanned: false }
  }
  const regions: Array<{ hex: string; foundIn: 'proxy' | 'impl' }> = []
  if (ownCode !== null && ownCode !== '0x') {
    regions.push({ hex: ownCode.slice(2).toLowerCase(), foundIn: 'proxy' })
  }
  if (implCode !== null && implCode !== '0x') {
    regions.push({ hex: implCode.slice(2).toLowerCase(), foundIn: 'impl' })
  }
  const hits: ExitFinding['hits'] = []
  for (const region of regions) {
    for (const sel of EXIT_SELECTORS) {
      if (region.hex.includes(sel.selector.slice(2))) {
        hits.push({
          selector: sel.selector,
          signature: sel.signature,
          kind: sel.kind,
          foundIn: region.foundIn,
        })
      }
    }
  }
  return {
    hits,
    hasDirect: hits.some((h) => h.kind === 'direct'),
    hasGeneric: hits.some((h) => h.kind === 'generic'),
    scanned: true,
  }
}

// ---------------------------------------------------------------------------
// Known incumbents
// ---------------------------------------------------------------------------

/**
 * Distributors that already hold coins, with what is known about getting out.
 *
 * Every address here was read live from the chain (2026-09-08, head 57,930,667)
 * and re-confirmed for this file: the beacon's implementation(), the beacon's
 * owner(), that owner's getMinDelay(), and the distributor factory's owner().
 *
 * NO NAME IS GUESSED. The operator EOA is identified structurally - it deployed
 * and owns the factory, and factory.whitelistedLaunchers() returns true for it,
 * so it is a sanctioned partner launchpad rather than a squatter - and that is
 * as far as the evidence goes.
 */
export interface KnownDistributor {
  id: string
  label: string
  /** EOA that owns the factory and holds every timelock role. */
  operator: string
  /** UpgradeableBeacon the per-coin proxies point at. */
  beacon: string
  /** Current implementation behind the beacon. */
  implementation: string
  /** Factory that deploys the per-coin proxies. */
  factory: string
  /** TimelockController owning the beacon. */
  timelock: string
  timelockMinDelaySeconds: number
  /** Does the CURRENT implementation contain any exit selector? Measured. */
  currentImplementationHasExit: boolean
  note: string
}

export const KNOWN_DISTRIBUTORS: readonly KnownDistributor[] = [
  {
    id: 'INCUMBENT_BEACON_A',
    label: 'whitelisted partner launchpad, per-coin epoch merkle distributor',
    operator: '0x3a3e6be1e8be67a4e2e7e2e815a66ba03a27f5d4',
    beacon: '0x15efa92a82566a360fdd3b82d81254f57d39db95',
    implementation: '0x53c2eae568c4095c6972817f5fcb6141b723d920',
    factory: '0xe03f2a64e5bd65c1d1feeb49feb347cb5ddc2862',
    timelock: '0x2c45b4112a9234c4c4d0a9e9d52cc1ee4538290b',
    timelockMinDelaySeconds: 172_800,
    currentImplementationHasExit: false,
    note:
      'The 9,257-byte implementation contains no exit selector, so a coin routed here cannot ' +
      'be won at any acquisition rate. The lock is ASYMMETRIC: these are beacon proxies, so the ' +
      'operator can add an exit to all of them at once through a 2-day timelock on which it holds ' +
      'PROPOSER, EXECUTOR and CANCELLER. It can free its coins at will; we cannot.',
  },
]

export function distributorByBeacon(beacon: string | null): KnownDistributor | null {
  if (beacon === null) return null
  const want = normalize(beacon)
  return KNOWN_DISTRIBUTORS.find((d) => d.beacon === want) ?? null
}

export function distributorByImplementation(impl: string | null): KnownDistributor | null {
  if (impl === null) return null
  const want = normalize(impl)
  return KNOWN_DISTRIBUTORS.find((d) => d.implementation === want) ?? null
}

// ---------------------------------------------------------------------------
// Winnability
// ---------------------------------------------------------------------------

export type WinnableVerdict =
  /** Recipient is a private-key EOA (plain or under EIP-7702). Reachable. */
  | 'WINNABLE_SIGNABLE'
  /** Recipient is a contract whose code carries a direct exit. */
  | 'WINNABLE_CONTRACT_EXIT'
  /** Recipient is a contract with only a conditional, generic escape hatch. */
  | 'CONDITIONAL_GENERIC_EXIT'
  /** Recipient is a known distributor with no code path out. */
  | 'LOCKED_KNOWN_DISTRIBUTOR'
  /** Recipient is some other contract with no exit selector at all. */
  | 'LOCKED_CONTRACT'
  /** Code was not read. Not winnable, not locked - unmeasured. */
  | 'UNKNOWN'

export type ExitMode = 'strict' | 'broad'

export interface WinnabilityInput {
  classification: RecipientClassification
  exit: ExitFinding
  /** Resolved implementation, if the caller chased the beacon. */
  resolvedImplementation: string | null
  mode: ExitMode
}

export interface WinnabilityAssessment {
  verdict: WinnableVerdict
  /** null means UNMEASURED. It is never coerced to false. */
  winnable: boolean | null
  reason: string
  /** Which distributor holds it, when one does. */
  holder: KnownDistributor | null
  /** How recipiency would actually move, in one line, for the winnable cases. */
  route: string | null
}

export function assessWinnability(input: WinnabilityInput): WinnabilityAssessment {
  const { classification: c, exit, mode } = input
  const holder =
    distributorByBeacon(c.beacon) ?? distributorByImplementation(input.resolvedImplementation)

  if (c.cls === 'UNKNOWN') {
    return {
      verdict: 'UNKNOWN',
      winnable: null,
      reason:
        'eth_getCode was not read for this recipient, so its class is UNMEASURED. This is not a zero and not an EOA.',
      holder,
      route: null,
    }
  }
  if (isSignable(c.cls)) {
    return {
      verdict: 'WINNABLE_SIGNABLE',
      winnable: true,
      reason:
        c.cls === 'EOA'
          ? 'recipient has no code: a private-key EOA, which can call factory.transferCreatorFeeRecipient itself'
          : `recipient is an EIP-7702 delegation designator (23 bytes) over ${c.delegate ?? 'an unread delegate'} - still a private-key EOA and still signable`,
      holder,
      route:
        'dev calls factory.transferCreatorFeeRecipient(memecoin, vault) from the recipient key; the 3.00-day timelock then runs before it takes effect',
    }
  }
  if (!exit.scanned) {
    return {
      verdict: 'UNKNOWN',
      winnable: null,
      reason: `recipient is a contract (${c.cls}) whose code was not scanned for an exit path. UNMEASURED.`,
      holder,
      route: null,
    }
  }
  if (exit.hasDirect) {
    return {
      verdict: 'WINNABLE_CONTRACT_EXIT',
      winnable: true,
      reason: `recipient is a contract (${c.cls}) whose code dispatches ${exit.hits
        .filter((h) => h.kind === 'direct')
        .map((h) => h.signature)
        .join(', ')} - a code path out exists`,
      holder,
      route:
        'whoever controls the recipient contract calls its transfer function, which forwards to the factory; access control on that function is NOT visible in bytecode and must be read before committing',
    }
  }
  if (exit.hasGeneric) {
    return {
      verdict: 'CONDITIONAL_GENERIC_EXIT',
      winnable: mode === 'broad',
      reason: `recipient is a contract (${c.cls}) with only a GENERIC escape hatch (${exit.hits
        .filter((h) => h.kind === 'generic')
        .map((h) => h.signature)
        .join(', ')}). It can call the factory if - and only if - whoever may invoke it is the dev, which bytecode cannot show.${
        mode === 'strict' ? ' Counted as NOT winnable under --exit-mode strict.' : ''
      }`,
      holder,
      route:
        'the controller of the recipient contract routes an arbitrary call to factory.transferCreatorFeeRecipient',
    }
  }
  if (holder !== null) {
    return {
      verdict: 'LOCKED_KNOWN_DISTRIBUTOR',
      winnable: false,
      reason: `routed to ${holder.id} (${holder.label}); its implementation ${holder.implementation} contains no exit selector`,
      holder,
      route: null,
    }
  }
  return {
    verdict: 'LOCKED_CONTRACT',
    winnable: false,
    reason: `recipient is a contract (${c.cls}) and neither it nor its implementation dispatches any exit selector; the only address that may move recipiency is the recipient itself, and it cannot`,
    holder: null,
    route: null,
  }
}

// ---------------------------------------------------------------------------
// Gate arithmetic and spells
// ---------------------------------------------------------------------------

/**
 * Trailing median over a window, aligned to the END of each window.
 *
 * Index i holds the median of days [i-window+1 .. i], or null for the first
 * window-1 days, where the window is not yet full. Null is NOT zero: a day
 * whose trailing window is incomplete has no median, and rendering it as 0
 * would report every coin as below the gate for its first six days.
 */
export function trailingMedianSeries(
  daily: ReadonlyArray<number | null>,
  window: number,
): Array<number | null> {
  if (window < 1) throw new Error('trailingMedianSeries: window must be >= 1')
  const out: Array<number | null> = []
  for (let i = 0; i < daily.length; i++) {
    if (i + 1 < window) {
      out.push(null)
      continue
    }
    const slice = daily.slice(i + 1 - window, i + 1)
    // One unpriced day poisons its window. An UNPRICED amount is not a zero and
    // a median computed with a fake zero in it is a fabricated number.
    if (slice.some((v) => v === null || !Number.isFinite(v))) {
      out.push(null)
      continue
    }
    const sorted = [...(slice as number[])].sort((a, b) => a - b)
    const n = sorted.length
    out.push(n % 2 === 1 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2)
  }
  return out
}

export interface GateSpell {
  /** Days in the series whose trailing median cleared the gate. */
  daysAtGate: number
  /** Length of the run that is STILL RUNNING at the last observed day. */
  currentSpellDays: number
  /** Is it above the gate on the final day? */
  standing: boolean
  /** Longest run anywhere in the series. */
  longestSpellDays: number
  /** The median on the final day. null when it could not be computed. */
  latestMedian: number | null
  /** Days whose median could not be computed at all. */
  unmeasuredDays: number
}

/**
 * Cut a median series into runs above a gate.
 *
 * A null day breaks a run rather than continuing it, because "we could not
 * measure this day" is not evidence that the coin held the gate through it.
 */
export function gateSpell(
  medianSeries: ReadonlyArray<number | null>,
  gate: number,
): GateSpell {
  let daysAtGate = 0
  let longest = 0
  let run = 0
  let unmeasured = 0
  for (const v of medianSeries) {
    if (v === null || !Number.isFinite(v)) {
      unmeasured++
      run = 0
      continue
    }
    if (v >= gate) {
      daysAtGate++
      run++
      if (run > longest) longest = run
    } else {
      run = 0
    }
  }
  let current = 0
  for (let i = medianSeries.length - 1; i >= 0; i--) {
    const v = medianSeries[i] ?? null
    if (v === null || !Number.isFinite(v) || v < gate) break
    current++
  }
  const latest = medianSeries.length === 0 ? null : (medianSeries[medianSeries.length - 1] ?? null)
  return {
    daysAtGate,
    currentSpellDays: current,
    standing: current > 0,
    longestSpellDays: longest,
    latestMedian: latest !== null && Number.isFinite(latest) ? latest : null,
    unmeasuredDays: unmeasured,
  }
}

/**
 * The highest tier a coin qualifies for, given its median and its spell.
 *
 * Both conditions bind: T2 needs $2,500/day AND 14 sustained days, and in V2's
 * entire 36-day history exactly 3 recipients have ever met that and ZERO have
 * ever met T3. A tool that reported tier from the dollar figure alone would
 * print T2s and T3s that do not exist.
 */
export interface TierLike {
  id: string
  gateQfPerDay: number
  sustainedDays: number
}

export interface TierGrant {
  /** Tier actually granted. null when nothing is met. */
  granted: string | null
  /** Tier the money would support if the days were there. */
  moneyQualifies: string | null
  /** Days still needed for the money tier, when the money is already there. */
  daysShortOfMoneyTier: number | null
}

export function grantTier(
  latestMedian: number | null,
  currentSpellDays: number,
  tiers: readonly TierLike[],
): TierGrant {
  if (latestMedian === null) {
    return { granted: null, moneyQualifies: null, daysShortOfMoneyTier: null }
  }
  const ordered = [...tiers].sort((a, b) => b.gateQfPerDay - a.gateQfPerDay)
  const money = ordered.find((t) => latestMedian >= t.gateQfPerDay) ?? null
  const granted =
    ordered.find((t) => latestMedian >= t.gateQfPerDay && currentSpellDays >= t.sustainedDays) ??
    null
  return {
    granted: granted?.id ?? null,
    moneyQualifies: money?.id ?? null,
    daysShortOfMoneyTier:
      money !== null && currentSpellDays < money.sustainedDays
        ? money.sustainedDays - currentSpellDays
        : null,
  }
}

// ---------------------------------------------------------------------------
// Expected remaining tenure, from the measured survival curve
// ---------------------------------------------------------------------------

/**
 * E[min(T, tau) - t | T > t] from a Kaplan-Meier curve: the restricted mean
 * RESIDUAL life of a spell that has already run t days.
 *
 * Why residual and not the headline 11.59-day restricted mean: a coin that has
 * already held the gate for 14 days is not worth 11.59 more days of fees, and
 * it is not worth 11.59 - 14 = negative days either. The integral of S from t
 * to tau, divided by S(t), is the honest answer and it is what a per-coin
 * ranking needs.
 *
 * tau is the RESTRICTION and it is a hard measurement limit, not a modelling
 * choice: V2 is ~34 days old, so no method of any kind can see past it. The
 * survival curve's own restrictedToDays is the right tau and the caller passes
 * it through rather than picking one.
 *
 * Returns null when S(t) is 0 or the curve does not reach t - an UNKNOWN, never
 * a zero, because a zero here would rank a long-held coin last.
 */
export function restrictedMeanResidualDays(
  points: readonly SurvivalPoint[],
  elapsedDays: number,
  tau: number,
): number | null {
  if (points.length === 0 || tau <= 0) return null
  if (elapsedDays >= tau) return null
  const sorted = [...points].sort((a, b) => a.day - b.day)
  const survivalAt = (day: number): number => {
    let s = 1
    for (const p of sorted) {
      if (p.day <= day) s = p.survival
      else break
    }
    return s
  }
  const st = survivalAt(elapsedDays)
  if (!Number.isFinite(st) || st <= 0) return null

  // Integrate the step function S(u) over (elapsedDays, tau].
  let area = 0
  let cursor = elapsedDays
  let level = st
  for (const p of sorted) {
    if (p.day <= elapsedDays) continue
    if (p.day >= tau) break
    area += level * (p.day - cursor)
    cursor = p.day
    level = p.survival
  }
  area += level * (tau - cursor)
  const residual = area / st
  return Number.isFinite(residual) ? residual : null
}

// ---------------------------------------------------------------------------
// CONTACT SURFACE - UNTRUSTED, ATTACKER-AUTHORED DATA
// ---------------------------------------------------------------------------

/**
 * ============================ READ THIS ====================================
 *
 * Every string reachable through this section - socials(), description(),
 * logo(), name(), symbol() - was written by the person who deployed the token.
 * That person is an anonymous memecoin deployer whose incentive is to get this
 * agency's automation to do something for them for free. One of the 125 coins
 * in the current T1 set carries a description written in the voice of a sitting
 * head of state. Treat all of it as HOSTILE INPUT.
 *
 * THE THREE RULES, which are enforced by construction here and must be honoured
 * by every consumer of this data:
 *
 *   1. IT IS NEVER INTERPOLATED INTO A PROMPT. Not as context, not as "here is
 *      the coin we are researching", not inside a JSON blob a model will read.
 *      A description field is a free instruction channel into any model that
 *      sees it, and this repository's whole safety posture is that the cognition
 *      plane cannot be steered by chain data. If a model ever needs to know a
 *      coin's ticker, it gets the ADDRESS and a separately-verified label.
 *
 *   2. IT IS RENDERED INERT, NEVER LIVE. `inertText` strips C0/C1 controls, the
 *      Unicode bidi overrides that let a string display as its own reverse, and
 *      zero-width joiners; it collapses whitespace so a 400-line "SYSTEM:" block
 *      cannot push a report's own text off screen; and it truncates. The CSV
 *      writer additionally prefixes a leading =, +, - or @ so a spreadsheet
 *      cannot execute it as a formula.
 *
 *   3. A URL IS A STRING, NOT A DESTINATION. Nothing here fetches, resolves,
 *      unshortens or previews anything. The channel classification is a pattern
 *      match on the text and it is presented as the deployer's CLAIM about where
 *      they can be reached - not as a verified fact and not as an endorsement.
 *      Verifying that an X handle belongs to the dev is a human step that
 *      happens before contact, and it is outside this tool.
 *
 * ==========================================================================
 */

export type ChannelKind = 'x' | 'telegram' | 'discord' | 'website' | 'ipfs' | 'other'

export interface ContactChannel {
  kind: ChannelKind
  /** Host as it appears in the string. Not resolved, not fetched. */
  host: string | null
  /** The deployer's text, made inert. Safe to print. Never safe to obey. */
  inert: string
  /** Length of the original string, before truncation. */
  originalLength: number
  /** True when inertText removed or rewrote something. Worth a human look. */
  sanitized: boolean
}

/**
 * Is this code point one that lets a string lie about what it is?
 *
 * Written as a numeric predicate rather than a regex character class on
 * purpose. The class would have to contain a literal bidi override, and a
 * literal bidi override in a source file reorders the source itself in an
 * editor - which is the exact trick being defended against. Numbers cannot do
 * that, and they say what they mean without a hex table.
 *
 *   0x00-0x1f  C0 controls: NUL, the ANSI escape that repaints a terminal,
 *              and the newlines that let one field forge a whole table row.
 *   0x7f-0x9f  DEL and the C1 controls.
 *   0x200b-0f  zero-width space and joiners, and the LTR/RTL marks.
 *   0x202a-2e  bidi embedding and OVERRIDE - the codes that make "moc.x" read
 *              as "x.com" on screen while the bytes say otherwise.
 *   0x2066-69  bidi isolates, the same attack in its newer spelling.
 *   0xfeff     zero-width no-break space, invisible and byte-bearing.
 */
export function isHostileCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  )
}

/** The replacement every hostile code point collapses to. Visible on purpose. */
export const HOSTILE_REPLACEMENT = '\uFFFD'

/** Replace every hostile code point, leaving everything else untouched. */
export function stripHostile(raw: string): string {
  let out = ''
  for (const ch of raw) {
    out += isHostileCodePoint(ch.codePointAt(0) ?? 0) ? HOSTILE_REPLACEMENT : ch
  }
  return out
}

/**
 * Make one attacker-authored string safe to put on a terminal or in a CSV.
 *
 * This is a DISPLAY guard, not an escaping scheme for some other sink. Do not
 * use its output to build a shell command, an HTTP request, or a prompt.
 */
export function inertText(raw: string | null | undefined, maxLength = 120): string {
  if (raw === null || raw === undefined) return ''
  const stripped = stripHostile(raw).replace(/\s+/g, ' ').trim()
  if (stripped.length <= maxLength) return stripped
  return `${stripped.slice(0, maxLength - 1)}…`
}

/** Did inertText have to change anything? A yes is a signal, not noise. */
export function wasSanitized(raw: string, inert: string): boolean {
  return stripHostile(raw) !== raw || raw.replace(/\s+/g, ' ').trim().length !== inert.length
}

const CHANNEL_PATTERNS: ReadonlyArray<{ kind: ChannelKind; test: RegExp }> = [
  { kind: 'x', test: /^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\//i },
  { kind: 'telegram', test: /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.(?:me|org))\//i },
  { kind: 'discord', test: /^(?:https?:\/\/)?(?:www\.)?(?:discord\.(?:gg|com)|discordapp\.com)\//i },
  { kind: 'ipfs', test: /^(?:ipfs|ipns):\/\//i },
  { kind: 'website', test: /^https?:\/\//i },
]

/**
 * Classify one social string by pattern, WITHOUT touching the network.
 *
 * Returns null for an empty slot. An empty slot is the common case: the
 * socials() tuple has five members and most launches fill one or two.
 */
export function classifyChannel(raw: string | null | undefined): ContactChannel | null {
  if (raw === null || raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const inert = inertText(trimmed, 120)
  const kind = CHANNEL_PATTERNS.find((p) => p.test.test(trimmed))?.kind ?? 'other'
  let host: string | null = null
  const hostMatch = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/\s?#]+)/i.exec(trimmed)
  if (hostMatch && kind !== 'other') host = hostMatch[1]!.toLowerCase()
  return {
    kind,
    host,
    inert,
    originalLength: trimmed.length,
    sanitized: wasSanitized(trimmed, inert),
  }
}

export interface ContactSurface {
  /** Every non-empty slot of socials(), classified. */
  channels: ContactChannel[]
  /** Deployer's free text, made inert. Never fed to a model. */
  description: string | null
  /** Logo pointer, made inert. Never fetched. */
  logo: string | null
  /** True when the token exposes socials() at all. */
  hasSocialsGetter: boolean
  /** One-line answer to "is there any way to reach this dev?" */
  reachable: boolean
  /** Slots that were read but empty. Distinguishes "none given" from "not read". */
  emptySlots: number
  /** True when at least one string had to be sanitized. Read it by hand. */
  anySanitized: boolean
}

export function buildContactSurface(
  socials: readonly (string | null)[] | null,
  description: string | null,
  logo: string | null,
): ContactSurface {
  if (socials === null) {
    return {
      channels: [],
      description: description === null ? null : inertText(description, 200),
      logo: logo === null ? null : inertText(logo, 100),
      hasSocialsGetter: false,
      reachable: false,
      emptySlots: 0,
      anySanitized: false,
    }
  }
  const channels: ContactChannel[] = []
  let empty = 0
  for (const s of socials) {
    const c = classifyChannel(s)
    if (c === null) empty++
    else channels.push(c)
  }
  const descInert = description === null ? null : inertText(description, 200)
  const logoInert = logo === null ? null : inertText(logo, 100)
  return {
    channels,
    description: descInert,
    logo: logoInert,
    hasSocialsGetter: true,
    reachable: channels.some((c) => c.kind === 'x' || c.kind === 'telegram' || c.kind === 'discord'),
    emptySlots: empty,
    anySanitized:
      channels.some((c) => c.sanitized) ||
      (description !== null && descInert !== null && wasSanitized(description, descInert)),
  }
}

// ---------------------------------------------------------------------------
// The creator rate that applies to THIS coin
// ---------------------------------------------------------------------------

export interface CreatorRate {
  /** Verbatim from the coin's launches() record. */
  buybackEnabled: boolean
  creatorTaxBps: number
  /** bps of trade VOLUME reaching the creator's recipient, from protocol.ts. */
  creatorNetBps: number
  /** The base slice only, with no dev-elected tax. What "0.715%/0.365%" means. */
  baseNetBps: number
  /** Volume per day implied by an observed QF/day at this coin's own rate. */
  impliedVolumePerDayUsd: number | null
}

/**
 * The creator rate for one coin, branching on ITS buyback setting.
 *
 * Never hardcode 0.715% or 0.365%. The rate branches per token and the branch is
 * read from the chain; config/protocol.ts owns the arithmetic and this function
 * only routes a coin's own parameters into it.
 */
export function creatorRateFor(
  buybackEnabled: boolean,
  creatorTaxBps: number,
  qfPerDayUsd: number | null,
): CreatorRate {
  const net = creatorNetBps(buybackEnabled, creatorTaxBps)
  const base = creatorNetBps(buybackEnabled, 0)
  return {
    buybackEnabled,
    creatorTaxBps,
    creatorNetBps: net,
    baseNetBps: base,
    impliedVolumePerDayUsd:
      qfPerDayUsd === null || net <= 0 ? null : qfPerDayUsd / (net / 10_000),
  }
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export interface RankInput {
  /** Trailing-7-day median QF in USD. null is UNPRICED, not zero. */
  qfPerDayUsd: number | null
  /** KM restricted-mean residual days above the gate. null is UNKNOWN. */
  expectedRemainingDays: number | null
  /** null is UNMEASURED and must not be treated as false. */
  winnable: boolean | null
  operatorBps: number
  cogsPerDay: number
  /** Assumed probability an approach converts. Zero observations exist. */
  winRate: number
}

export interface RankFunction {
  id: string
  describe: string
  formula: string
  /** null when an input was UNKNOWN. Unknowns sort last, they never score 0. */
  score: (input: RankInput) => number | null
}

/**
 * The ranking functions, all of them printed with their formula in the report.
 *
 * `ev` is the default and it is the only one that answers the operator's actual
 * question - what is this prospect worth to us, net of what it costs to serve
 * and net of the chance we never sign it. The others exist because every term
 * in `ev` except qfPerDay is an assumption, and an operator who distrusts one of
 * them should be able to re-rank without editing code.
 */
export const RANK_FUNCTIONS: readonly RankFunction[] = [
  {
    id: 'ev',
    describe:
      'Expected operator contribution over the remaining life of the spell, net of cost to serve, times the assumed win rate. Unwinnable coins score 0 by construction.',
    formula: 'winRate * P(win) * expectedRemainingDays * (qf/day * operatorBps/1e4 - cogs/day)',
    score: (i) => {
      if (i.qfPerDayUsd === null || i.expectedRemainingDays === null || i.winnable === null) {
        return null
      }
      if (!i.winnable) return 0
      const perDay = (i.qfPerDayUsd * i.operatorBps) / 10_000 - i.cogsPerDay
      return i.winRate * i.expectedRemainingDays * perDay
    },
  },
  {
    id: 'ev-nowin',
    describe:
      'The same, without the win-rate multiplier. Ranks identically to ev but the number reads as "what this client is worth if we sign it", which is the figure to quote in a pitch.',
    formula: 'expectedRemainingDays * (qf/day * operatorBps/1e4 - cogs/day)',
    score: (i) => {
      if (i.qfPerDayUsd === null || i.expectedRemainingDays === null) return null
      const perDay = (i.qfPerDayUsd * i.operatorBps) / 10_000 - i.cogsPerDay
      return i.expectedRemainingDays * perDay
    },
  },
  {
    id: 'margin',
    describe:
      'Daily contribution only. Ignores tenure entirely - use it when you distrust the survival curve, which is fitted on a 34-day-old chain.',
    formula: 'qf/day * operatorBps/1e4 - cogs/day',
    score: (i) =>
      i.qfPerDayUsd === null ? null : (i.qfPerDayUsd * i.operatorBps) / 10_000 - i.cogsPerDay,
  },
  {
    id: 'qf',
    describe:
      'Raw trailing-7-day median QF/day. The rawest possible ordering, with no assumption in it at all.',
    formula: 'qf/day',
    score: (i) => i.qfPerDayUsd,
  },
  {
    id: 'tenure',
    describe:
      'Expected remaining days above the gate. Ranks by durability rather than size - the ordering to use if the desk is capacity-constrained rather than revenue-constrained.',
    formula: 'expectedRemainingDays',
    score: (i) => i.expectedRemainingDays,
  },
]

export function rankFunctionById(id: string): RankFunction {
  const found = RANK_FUNCTIONS.find((f) => f.id === id)
  if (!found) {
    throw new Error(
      `unknown ranking function "${id}". Available: ${RANK_FUNCTIONS.map((f) => f.id).join(', ')}`,
    )
  }
  return found
}

/**
 * Sort by score, descending, with UNKNOWN scores last.
 *
 * An unscored row is not a zero-value row. Sorting nulls to the bottom keeps
 * them visible instead of scattering them through the middle of the table where
 * they look like measured lows.
 */
export function sortByScore<T>(rows: readonly T[], score: (row: T) => number | null): T[] {
  return [...rows].sort((a, b) => {
    const sa = score(a)
    const sb = score(b)
    if (sa === null && sb === null) return 0
    if (sa === null) return 1
    if (sb === null) return -1
    return sb - sa
  })
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * One CSV field.
 *
 * Two separate hazards, both handled:
 *   - RFC 4180 quoting, for commas and embedded quotes.
 *   - Spreadsheet formula injection. A field beginning =, +, - or @ is executed
 *     as a formula by Excel, Sheets and LibreOffice. Every ticker, name and
 *     social string in this file is attacker-authored, so a leading apostrophe
 *     goes in front of those. This is the one place where the untrusted data
 *     crosses into a program that will happily run it.
 */
export function csvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return ''
  const raw = typeof value === 'string' ? value : String(value)
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
  if (/[",\r\n]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`
  return guarded
}

export function csvRow(fields: ReadonlyArray<string | number | boolean | null | undefined>): string {
  return fields.map(csvField).join(',')
}

export function toCsv(
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>,
): string {
  return [csvRow(headers), ...rows.map(csvRow)].join('\n')
}

// ---------------------------------------------------------------------------
// launches() decoding
// ---------------------------------------------------------------------------

/** `launches(bytes32)` on the V2 meme hook. */
export const LAUNCHES_SELECTOR = '0xad091230'

/**
 * The hook's per-pool launch record.
 *
 * Field order was established by decoding pools with independently known
 * creators, not by reading an ABI we do not have. It is re-validated on every
 * run by the memecoin-equals-joined-token control in prospects.ts: if the layout
 * ever shifts, field [2] stops matching the coin we asked about and the run says
 * so rather than silently reporting the wrong recipient.
 */
export interface LaunchRecord {
  registered: boolean
  buybackEnabled: boolean
  memecoin: string
  quoteToken: string
  creatorFeeRecipient: string
  creator: string
  protocolFeeRecipient: string
  creatorTaxBps: number
  protocolFeeShareBps: number
  buybackBurnBps: number
  hookFeeBps: number
}

export function decodeLaunchRecord(returnData: string): LaunchRecord | null {
  if (!returnData || returnData === '0x') return null
  const body = returnData.slice(2)
  if (body.length < 11 * 64) return null
  const word = (n: number): string => body.slice(n * 64, (n + 1) * 64)
  const addr = (n: number): string => `0x${word(n).slice(24)}`.toLowerCase()
  const uint = (n: number): number => Number(BigInt(`0x${word(n)}`))
  return {
    registered: BigInt(`0x${word(0)}`) === 1n,
    buybackEnabled: BigInt(`0x${word(1)}`) === 1n,
    memecoin: addr(2),
    quoteToken: addr(3),
    creatorFeeRecipient: addr(4),
    creator: addr(5),
    protocolFeeRecipient: addr(6),
    creatorTaxBps: uint(7),
    protocolFeeShareBps: uint(8),
    buybackBurnBps: uint(9),
    hookFeeBps: uint(10),
  }
}

/**
 * Decode an ABI-encoded tuple of N strings, as returned by `socials()`.
 *
 * Returns null on ANY malformation. A partially decoded social string is worse
 * than none: it is a string an attacker controls the length prefix of.
 */
export function decodeStringTuple(returnData: string, count: number): Array<string> | null {
  if (!returnData || returnData === '0x') return null
  const body = returnData.slice(2)
  if (body.length < count * 64) return null
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    let offset: number
    try {
      offset = Number(BigInt(`0x${body.slice(i * 64, (i + 1) * 64)}`))
    } catch {
      return null
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset * 2 + 64 > body.length) return null
    let length: number
    try {
      length = Number(BigInt(`0x${body.slice(offset * 2, offset * 2 + 64)}`))
    } catch {
      return null
    }
    if (!Number.isSafeInteger(length) || length < 0) return null
    const start = offset * 2 + 64
    if (start + length * 2 > body.length) return null
    out.push(Buffer.from(body.slice(start, start + length * 2), 'hex').toString('utf8'))
  }
  return out
}

/** Decode a single dynamic `string` return. Null on any malformation. */
export function decodeSingleString(returnData: string): string | null {
  const tuple = decodeStringTuple(returnData, 1)
  return tuple === null ? null : (tuple[0] ?? null)
}
