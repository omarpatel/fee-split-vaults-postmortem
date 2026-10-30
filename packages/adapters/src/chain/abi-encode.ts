/**
 * Calldata for the CoinVault entry points settlement uses and the VaultFactory
 * entry points onboarding uses.
 *
 * Hand-encoded rather than pulled through an ABI library: the surface is a
 * handful of calls, and two of them decide money - pullBudget moves the
 * client's, deploy fixes the terms a vault can ever have. Note what
 * pullBudget's argument list does NOT contain: an address for the money to go
 * to. The vault sends to its immutable OPERATOR_TREASURY.
 */

import type { Consent, VaultState } from '@fee-split-vaults/core'
import { bytesToHex, hexToBytes, keccak256Hex, normalizeAddress, normalizeHash32, type Hex } from '@fee-split-vaults/indexer'

export const PULL_BUDGET_SIGNATURE = 'pullBudget(address,uint256,bytes32,bytes)'
export const USED_INVOICE_SIGNATURE = 'usedInvoice(bytes32)'

/**
 * The Consent struct as the ABI spells it. Field order mirrors
 * contracts/src/lib/ConsentLib.sol and packages/core Consent exactly; the
 * struct is the CREATE2 salt preimage, so reordering changes every address.
 */
export const CONSENT_TUPLE = '(address,address,address,bytes32,uint16,uint16,address,address,uint16,uint64,bytes32)'
export const DEPLOY_SIGNATURE = `deploy(${CONSENT_TUPLE},bytes)`
export const IS_VAULT_SIGNATURE = 'isVault(address)'
export const VAULT_DEPLOYED_SIGNATURE = `VaultDeployed(address,address,bytes32,${CONSENT_TUPLE},bool)`

export const PULL_BUDGET_SELECTOR: Hex = `0x${keccak256Hex(PULL_BUDGET_SIGNATURE).slice(2, 10)}`
export const USED_INVOICE_SELECTOR: Hex = `0x${keccak256Hex(USED_INVOICE_SIGNATURE).slice(2, 10)}`
export const DEPLOY_SELECTOR: Hex = `0x${keccak256Hex(DEPLOY_SIGNATURE).slice(2, 10)}`
export const IS_VAULT_SELECTOR: Hex = `0x${keccak256Hex(IS_VAULT_SIGNATURE).slice(2, 10)}`
/** topic0 of VaultFactory.VaultDeployed(vault indexed, devPayout indexed, salt indexed, consent, unsigned). */
export const VAULT_DEPLOYED_TOPIC: Hex = keccak256Hex(VAULT_DEPLOYED_SIGNATURE)

const UINT256_MAX = (1n << 256n) - 1n

export class AbiEncodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

function word(value: bigint): string {
  if (value < 0n || value > UINT256_MAX) throw new AbiEncodeError(`value does not fit uint256: ${value}`)
  return value.toString(16).padStart(64, '0')
}

export interface PullBudgetArgs {
  readonly asset: string
  readonly amount: bigint
  readonly invoiceHash: string
  /** 0x-hex bytes. The contract records keccak256 of these as evidence. */
  readonly vendorCountersig: Hex
}

/**
 * Layout: selector, then four head words (address, uint256, bytes32, offset of
 * the bytes tail = 0x80), then the tail: length word + right-padded bytes.
 */
export function encodePullBudget(args: PullBudgetArgs): Hex {
  const countersig = hexToBytes(args.vendorCountersig)
  if (countersig.length === 0) throw new AbiEncodeError('vendorCountersig is empty; the contract reverts CountersigRequired')
  const paddedLength = Math.ceil(countersig.length / 32) * 32
  const tail = new Uint8Array(paddedLength)
  tail.set(countersig)
  return (
    PULL_BUDGET_SELECTOR +
    normalizeAddress(args.asset).slice(2).padStart(64, '0') +
    word(args.amount) +
    normalizeHash32(args.invoiceHash).slice(2) +
    word(0x80n) +
    word(BigInt(countersig.length)) +
    bytesToHex(tail).slice(2)
  ) as Hex
}

export function encodeUsedInvoice(invoiceHash: string): Hex {
  return (USED_INVOICE_SELECTOR + normalizeHash32(invoiceHash).slice(2)) as Hex
}

/** A `bool` return is one word, 0 or 1. Anything else is not a boolean and is refused. */
export function decodeBool(result: Hex): boolean {
  if (result.length !== 66) throw new AbiEncodeError(`expected one 32-byte word, got ${result}`)
  const value = BigInt(result)
  if (value !== 0n && value !== 1n) throw new AbiEncodeError(`bool word out of range: ${result}`)
  return value === 1n
}

// ---------------------------------------------------------------------------
// VaultFactory
// ---------------------------------------------------------------------------

const UINT16_MAX = 0xffffn
const UINT64_MAX = (1n << 64n) - 1n

function boundedWord(value: number, max: bigint, field: string): string {
  if (!Number.isInteger(value) || value < 0) throw new AbiEncodeError(`${field} must be a non-negative integer`)
  const big = BigInt(value)
  if (big > max) throw new AbiEncodeError(`${field} exceeds its width: ${value}`)
  return word(big)
}

function addressWord(value: string, field: string): string {
  try {
    return normalizeAddress(value).slice(2).padStart(64, '0')
  } catch {
    throw new AbiEncodeError(`${field} is not a 20-byte address`)
  }
}

function hash32Word(value: string, field: string): string {
  try {
    return normalizeHash32(value).slice(2)
  } catch {
    // core types the nonce as a string; on chain it is bytes32. A short value
    // silently zero-padded would let two nonces collide on one salt.
    throw new AbiEncodeError(`${field} is not a 32-byte hex value`)
  }
}

/**
 * abi.encode(Consent): eleven static words, no prefix. This is exactly the
 * salt preimage ConsentLib.salt hashes, and the head the factory's `deploy`
 * reads its tuple argument from - a static tuple is encoded inline.
 */
export function encodeConsentWords(consent: Consent): Hex {
  return ('0x' +
    addressWord(consent.devSigner, 'devSigner') +
    addressWord(consent.devPayout, 'devPayout') +
    addressWord(consent.token, 'token') +
    hash32Word(consent.termsHash, 'termsHash') +
    boundedWord(consent.operatorBps, UINT16_MAX, 'operatorBps') +
    boundedWord(consent.budgetBpsMax, UINT16_MAX, 'budgetBpsMax') +
    addressWord(consent.adapter, 'adapter') +
    addressWord(consent.referrer, 'referrer') +
    boundedWord(consent.referrerBps, UINT16_MAX, 'referrerBps') +
    boundedWord(consent.expiryUnix, UINT64_MAX, 'expiryUnix') +
    hash32Word(consent.nonce, 'nonce')) as Hex
}

/** ConsentLib.salt: keccak256(abi.encode(consent)). The CREATE2 salt. */
export function consentSalt(consent: Consent): Hex {
  return keccak256Hex(hexToBytes(encodeConsentWords(consent)))
}

/** Offset of the `bytes devSig` tail: the tuple's 11 words plus the offset word itself. */
const DEPLOY_SIG_OFFSET = 12n * 32n

/**
 * VaultFactory.deploy(Consent consent, bytes devSig). Layout: selector, the
 * eleven consent words, the tail offset (0x180), then length + right-padded
 * signature bytes.
 */
export function encodeDeploy(consent: Consent, devSignature: string): Hex {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(devSignature)) {
    throw new AbiEncodeError('devSignature must be non-empty 0x-hex bytes')
  }
  const sig = hexToBytes(devSignature as Hex)
  const tail = new Uint8Array(Math.ceil(sig.length / 32) * 32)
  tail.set(sig)
  return (
    DEPLOY_SELECTOR +
    encodeConsentWords(consent).slice(2) +
    word(DEPLOY_SIG_OFFSET) +
    word(BigInt(sig.length)) +
    bytesToHex(tail).slice(2)
  ) as Hex
}

export function encodeIsVault(vault: string): Hex {
  return (IS_VAULT_SELECTOR + addressWord(vault, 'vault')) as Hex
}

// ---------------------------------------------------------------------------
// CoinVault operator surface and views
// ---------------------------------------------------------------------------

/**
 * Every signature below is the exact Solidity declaration in
 * contracts/src/CoinVault.sol; the selector is keccak of that string at module
 * load, never a literal. Note what the operator writes do NOT carry: an
 * address for money to go to. withdrawOperator pays the immutable
 * OPERATOR_TREASURY; claim/claimToken pull escrow credit INTO the vault.
 */
export const VAULT_WRITE_SIGNATURES = {
  bind: 'bind(address)',
  activate: 'activate()',
  suspend: 'suspend()',
  resume: 'resume()',
  heartbeat: 'heartbeat()',
  withdrawOperator: 'withdrawOperator(address,uint256)',
  claim: 'claim(uint256)',
  claimToken: 'claimToken(address,uint256)',
  sweep: 'sweep(address[])',
  settle: 'settle(address)',
} as const

export const VAULT_VIEW_SIGNATURES = {
  state: 'state()',
  token: 'token()',
  legOf: 'legOf(address)',
  budgetAvailable: 'budgetAvailable(address)',
  checkSolvency: 'checkSolvency(address)',
  lastOperatorActionUnix: 'lastOperatorActionUnix()',
} as const

export type VaultWriteName = keyof typeof VAULT_WRITE_SIGNATURES
export type VaultViewName = keyof typeof VAULT_VIEW_SIGNATURES

function selectorOf(signature: string): Hex {
  return `0x${keccak256Hex(signature).slice(2, 10)}`
}

function selectorTable<K extends string>(signatures: Readonly<Record<K, string>>): Readonly<Record<K, Hex>> {
  const out = {} as Record<K, Hex>
  for (const name of Object.keys(signatures) as K[]) out[name] = selectorOf(signatures[name])
  return out
}

export const VAULT_WRITE_SELECTORS: Readonly<Record<VaultWriteName, Hex>> = selectorTable(VAULT_WRITE_SIGNATURES)
export const VAULT_VIEW_SELECTORS: Readonly<Record<VaultViewName, Hex>> = selectorTable(VAULT_VIEW_SIGNATURES)

/** SafeTransferLib.NATIVE: the vault's sentinel for the chain's native asset. */
export const NATIVE_ASSET = '0x0000000000000000000000000000000000000000'

/** CoinVault.MAX_SWEEP. A longer list reverts TooManyAssets; refused here first. */
export const MAX_SWEEP_ASSETS = 32

export function isNativeAsset(asset: string): boolean {
  return normalizeAddress(asset) === NATIVE_ASSET
}

export function encodeBind(token: string): Hex {
  return (VAULT_WRITE_SELECTORS.bind + addressWord(token, 'token')) as Hex
}

export function encodeActivate(): Hex {
  return VAULT_WRITE_SELECTORS.activate
}

export function encodeSuspend(): Hex {
  return VAULT_WRITE_SELECTORS.suspend
}

export function encodeResume(): Hex {
  return VAULT_WRITE_SELECTORS.resume
}

export function encodeHeartbeat(): Hex {
  return VAULT_WRITE_SELECTORS.heartbeat
}

export function encodeWithdrawOperator(asset: string, amount: bigint): Hex {
  return (VAULT_WRITE_SELECTORS.withdrawOperator + addressWord(asset, 'asset') + word(amount)) as Hex
}

export function encodeClaim(maxAmount: bigint): Hex {
  return (VAULT_WRITE_SELECTORS.claim + word(maxAmount)) as Hex
}

export function encodeClaimToken(asset: string, maxAmount: bigint): Hex {
  if (isNativeAsset(asset)) throw new AbiEncodeError('claimToken on the native asset reverts UseClaimForNative')
  return (VAULT_WRITE_SELECTORS.claimToken + addressWord(asset, 'asset') + word(maxAmount)) as Hex
}

/** sweep(address[]): selector, offset word (0x20), length word, one word per address. */
export function encodeSweep(assets: readonly string[]): Hex {
  if (assets.length === 0) throw new AbiEncodeError('sweep of zero assets does nothing')
  if (assets.length > MAX_SWEEP_ASSETS) {
    throw new AbiEncodeError(`sweep of ${assets.length} assets exceeds MAX_SWEEP ${MAX_SWEEP_ASSETS}`)
  }
  return (VAULT_WRITE_SELECTORS.sweep +
    word(0x20n) +
    word(BigInt(assets.length)) +
    assets.map((asset, i) => addressWord(asset, `assets[${i}]`)).join('')) as Hex
}

export function encodeSettle(asset: string): Hex {
  return (VAULT_WRITE_SELECTORS.settle + addressWord(asset, 'asset')) as Hex
}

export function encodeState(): Hex {
  return VAULT_VIEW_SELECTORS.state
}

export function encodeToken(): Hex {
  return VAULT_VIEW_SELECTORS.token
}

export function encodeLegOf(asset: string): Hex {
  return (VAULT_VIEW_SELECTORS.legOf + addressWord(asset, 'asset')) as Hex
}

export function encodeBudgetAvailable(asset: string): Hex {
  return (VAULT_VIEW_SELECTORS.budgetAvailable + addressWord(asset, 'asset')) as Hex
}

export function encodeCheckSolvency(asset: string): Hex {
  return (VAULT_VIEW_SELECTORS.checkSolvency + addressWord(asset, 'asset')) as Hex
}

export function encodeLastOperatorActionUnix(): Hex {
  return VAULT_VIEW_SELECTORS.lastOperatorActionUnix
}

// ---------------------------------------------------------------------------
// Return decoding. Every decoder is TOTAL over its expected width and refuses
// anything else: a short word, an out-of-range enum or an extra word is not a
// value, it is the wrong contract at that address.
// ---------------------------------------------------------------------------

const WORD_HEX = /^0x[0-9a-fA-F]*$/

/** Splits a return buffer into exactly `count` 32-byte words. */
export function decodeWords(result: Hex, count: number): bigint[] {
  if (!WORD_HEX.test(result) || result.length !== 2 + 64 * count) {
    throw new AbiEncodeError(`expected ${count} 32-byte word(s), got ${result}`)
  }
  const out: bigint[] = []
  for (let i = 0; i < count; i++) out.push(BigInt(`0x${result.slice(2 + 64 * i, 2 + 64 * (i + 1))}`))
  return out
}

export function decodeUint256(result: Hex): bigint {
  return decodeWords(result, 1)[0] as bigint
}

/** A uint64 return (lastOperatorActionUnix): one word that must fit 64 bits. */
export function decodeUint64(result: Hex): bigint {
  const value = decodeUint256(result)
  if (value > UINT64_MAX) throw new AbiEncodeError(`uint64 word out of range: ${result}`)
  return value
}

export function decodeAddress(result: Hex): string {
  const value = decodeUint256(result)
  if (value >> 160n !== 0n) throw new AbiEncodeError(`address word has high bits set: ${result}`)
  return `0x${value.toString(16).padStart(40, '0')}`
}

/**
 * contracts/src/interfaces/ICoinVault.sol `enum VaultState`, by ordinal. The
 * ordinals are part of the ABI: members may be appended, never reordered.
 */
export const VAULT_STATE_BY_ORDINAL = [
  'UNBOUND',
  'PASSTHROUGH',
  'BOUND',
  'PENDING',
  'ACTIVE',
  'SUSPENDED',
  'POISONED',
  'TERMINATED',
] as const satisfies readonly VaultState[]

export function vaultStateFromOrdinal(ordinal: bigint): VaultState {
  if (ordinal < 0n || ordinal >= BigInt(VAULT_STATE_BY_ORDINAL.length)) {
    throw new AbiEncodeError(`VaultState ordinal ${ordinal} is not a member of the enum`)
  }
  return VAULT_STATE_BY_ORDINAL[Number(ordinal)] as VaultState
}

export function decodeVaultState(result: Hex): VaultState {
  return vaultStateFromOrdinal(decodeUint256(result))
}

/** ICoinVault.sol `struct Legs`, in declaration order. A static tuple: four words, no offset. */
export interface VaultLegs {
  readonly dev: bigint
  readonly budget: bigint
  readonly operator: bigint
  readonly referrer: bigint
}

export function decodeLegs(result: Hex): VaultLegs {
  const [dev, budget, operator, referrer] = decodeWords(result, 4) as [bigint, bigint, bigint, bigint]
  return { dev, budget, operator, referrer }
}

export interface VaultSolvency {
  readonly solvent: boolean
  readonly balance: bigint
  readonly accounted: bigint
}

export function decodeCheckSolvency(result: Hex): VaultSolvency {
  const [flag, balance, accounted] = decodeWords(result, 3) as [bigint, bigint, bigint]
  if (flag !== 0n && flag !== 1n) throw new AbiEncodeError(`bool word out of range: ${result}`)
  return { solvent: flag === 1n, balance, accounted }
}

// ---------------------------------------------------------------------------
// Custom errors. A simulation that reverts hands back selector + args; these
// are the ones the vault (and, bubbled through _bubble(), the Venue escrow)
// can raise. Anything else is `unknown_revert`, never a guess.
// ---------------------------------------------------------------------------

/** Solidity name -> signature. From the `error` declarations in CoinVault.sol. */
export const VAULT_ERROR_SIGNATURES = {
  OnlyOperator: 'OnlyOperator()',
  OnlyDev: 'OnlyDev()',
  OnlyDevPayout: 'OnlyDevPayout()',
  OnlyReferrer: 'OnlyReferrer()',
  Reentrancy: 'Reentrancy()',
  BadState: 'BadState(uint8)',
  AlreadyBound: 'AlreadyBound()',
  TokenRequired: 'TokenRequired()',
  TokenMismatch: 'TokenMismatch()',
  SignatureExpired: 'SignatureExpired()',
  AmountExceedsLeg: 'AmountExceedsLeg(uint256,uint256)',
  OperatorLegFrozen: 'OperatorLegFrozen()',
  BudgetIsFrozen: 'BudgetIsFrozen()',
  InvoiceRequired: 'InvoiceRequired()',
  InvoiceAlreadyUsed: 'InvoiceAlreadyUsed()',
  CountersigRequired: 'CountersigRequired()',
  NothingToDo: 'NothingToDo()',
  ProofWindowOpen: 'ProofWindowOpen(uint64)',
  AboveDialCeiling: 'AboveDialCeiling(uint16,uint16)',
  BpsOverflow: 'BpsOverflow()',
  NoPendingDial: 'NoPendingDial()',
  TimelockPending: 'TimelockPending(uint64)',
  AdapterNotContract: 'AdapterNotContract()',
  AdapterNotProposed: 'AdapterNotProposed()',
  AdapterCallRejected: 'AdapterCallRejected(address,bytes4)',
  AdapterCallFailed: 'AdapterCallFailed()',
  NoNotice: 'NoNotice()',
  UseClaimForNative: 'UseClaimForNative()',
  Insolvent: 'Insolvent(address)',
  TooManyAssets: 'TooManyAssets()',
  OnlySelf: 'OnlySelf()',
} as const

/**
 * The Venue V2 fee escrow's errors, from its Sourcify-verified ABI
 * (chain 4663, VENUE.contracts.v2FeeEscrow). claim()/claimToken() re-raise
 * these verbatim through CoinVault._bubble, so they arrive at the simulation
 * under the vault's address.
 */
export const ESCROW_ERROR_SIGNATURES = {
  InsufficientBalance: 'InsufficientBalance(uint256,uint256)',
  NoBalance: 'NoBalance()',
  ReentrancyGuardReentrantCall: 'ReentrancyGuardReentrantCall()',
  SafeERC20FailedOperation: 'SafeERC20FailedOperation(address)',
  TransferFailed: 'TransferFailed()',
  ZeroAddress: 'ZeroAddress()',
} as const

export type VaultErrorName = keyof typeof VAULT_ERROR_SIGNATURES
export type EscrowErrorName = keyof typeof ESCROW_ERROR_SIGNATURES

export interface DecodedCustomError {
  readonly source: 'vault' | 'escrow'
  readonly name: VaultErrorName | EscrowErrorName
  readonly selector: Hex
  /** Static arguments, one word each, in declaration order. */
  readonly args: readonly bigint[]
}

interface ErrorShape {
  readonly source: 'vault' | 'escrow'
  readonly name: VaultErrorName | EscrowErrorName
  readonly arity: number
}

function arityOf(signature: string): number {
  const inner = signature.slice(signature.indexOf('(') + 1, -1)
  return inner === '' ? 0 : inner.split(',').length
}

const CUSTOM_ERRORS: ReadonlyMap<string, ErrorShape> = (() => {
  const map = new Map<string, ErrorShape>()
  for (const [name, signature] of Object.entries(VAULT_ERROR_SIGNATURES)) {
    map.set(selectorOf(signature), { source: 'vault', name: name as VaultErrorName, arity: arityOf(signature) })
  }
  for (const [name, signature] of Object.entries(ESCROW_ERROR_SIGNATURES)) {
    map.set(selectorOf(signature), { source: 'escrow', name: name as EscrowErrorName, arity: arityOf(signature) })
  }
  return map
})()

/** Selector of a named custom error, for tests and for building revert fixtures. */
export function customErrorSelector(name: VaultErrorName | EscrowErrorName): Hex {
  const signature =
    name in VAULT_ERROR_SIGNATURES
      ? VAULT_ERROR_SIGNATURES[name as VaultErrorName]
      : ESCROW_ERROR_SIGNATURES[name as EscrowErrorName]
  return selectorOf(signature)
}

/**
 * Decodes revert data into a known custom error, or undefined when the
 * selector is not one the vault or the escrow declares (an Error(string),
 * a Panic, or a contract we did not expect). Argument words that do not fit
 * the declared arity are treated the same way: a known selector with the
 * wrong payload is not that error.
 */
export function decodeCustomError(revertData: Hex): DecodedCustomError | undefined {
  if (!WORD_HEX.test(revertData) || revertData.length < 10) return undefined
  const selector = revertData.slice(0, 10).toLowerCase() as Hex
  const shape = CUSTOM_ERRORS.get(selector)
  if (shape === undefined) return undefined
  const payload = `0x${revertData.slice(10)}` as Hex
  let args: bigint[]
  try {
    args = decodeWords(payload, shape.arity)
  } catch {
    return undefined
  }
  return { source: shape.source, name: shape.name, selector, args }
}

// ---------------------------------------------------------------------------
// Venue V2 fee escrow views (Sourcify-verified ABI, chain 4663)
// ---------------------------------------------------------------------------

/** Native credit for a recipient. There is no `creditOf`; this is the view the escrow has. */
export const ESCROW_BALANCE_OF_SIGNATURE = 'balanceOf(address)'
/** ERC-20 credit for (recipient, token). */
export const ESCROW_BALANCE_OF_TOKEN_SIGNATURE = 'balanceOfToken(address,address)'
export const ESCROW_BALANCE_OF_SELECTOR: Hex = selectorOf(ESCROW_BALANCE_OF_SIGNATURE)
export const ESCROW_BALANCE_OF_TOKEN_SELECTOR: Hex = selectorOf(ESCROW_BALANCE_OF_TOKEN_SIGNATURE)

export function encodeEscrowBalanceOf(recipient: string): Hex {
  return (ESCROW_BALANCE_OF_SELECTOR + addressWord(recipient, 'recipient')) as Hex
}

export function encodeEscrowBalanceOfToken(recipient: string, token: string): Hex {
  if (isNativeAsset(token)) throw new AbiEncodeError('balanceOfToken on the native sentinel; use balanceOf')
  return (ESCROW_BALANCE_OF_TOKEN_SELECTOR + addressWord(recipient, 'recipient') + addressWord(token, 'token')) as Hex
}
