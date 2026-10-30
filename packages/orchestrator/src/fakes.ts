/**
 * In-memory implementations of every port.
 *
 * These are not stubs. Each one has the behaviour the real thing must have,
 * including the fail-closed behaviour: the settlement fake can be told to fail,
 * the message source refuses a cross-coin fetch, and the screening store returns
 * undefined rather than inventing a CLEAR verdict. A test that passes against
 * these is testing the orchestration, not a happy path made of nulls.
 */

import type { Address, Asset, AssetAddress, ScreeningResult, TxHash, Vault } from '@fee-split-vaults/core'
import type { HumanApprovalRecord, ReimbursementPull, VendorInvoice } from '@fee-split-vaults/broker'
import type { CoinBinding, FeePosting, HaltNotice } from '@fee-split-vaults/indexer'
import type { RawMessage } from '@fee-split-vaults/runtime'
import { CoinIsolationError } from './errors.js'
import type {
  AllocationObservation,
  ApprovalStore,
  AssetRegistry,
  ChainReadModel,
  ClaimObservation,
  Escalation,
  EscalationSink,
  InvoiceRegistry,
  PendingPurchase,
  PendingPurchaseStore,
  PredicateQueue,
  PredicateSchedule,
  MessageSource,
  ScreeningStore,
  SettlementPort,
  SettlementReceipt,
  VaultRepository,
} from './ports.js'

export class InMemoryAssetRegistry implements AssetRegistry {
  readonly #byAddress = new Map<string, Asset>()

  constructor(assets: readonly Asset[] = []) {
    for (const asset of assets) this.put(asset)
  }

  put(asset: Asset): void {
    this.#byAddress.set(asset.address.toLowerCase(), asset)
  }

  /** The per-asset kill switch. A paused issuer proxy is flipped here. */
  setEnabled(address: AssetAddress, enabled: boolean): void {
    const asset = this.#byAddress.get(address.toLowerCase())
    if (asset === undefined) return
    this.#byAddress.set(address.toLowerCase(), { ...asset, enabled })
  }

  get(asset: AssetAddress): Asset | undefined {
    return this.#byAddress.get(asset.toLowerCase())
  }

  all(): readonly Asset[] {
    return [...this.#byAddress.values()]
  }
}

export class InMemoryVaultRepository implements VaultRepository {
  readonly #byAddress = new Map<string, Vault>()

  constructor(vaults: readonly Vault[] = []) {
    for (const vault of vaults) this.#byAddress.set(vault.address, { ...vault })
  }

  async get(vault: Address): Promise<Vault | undefined> {
    const found = this.#byAddress.get(vault)
    return found === undefined ? undefined : { ...found }
  }

  async put(vault: Vault): Promise<void> {
    this.#byAddress.set(vault.address, { ...vault })
  }

  async list(): Promise<Vault[]> {
    return [...this.#byAddress.values()].map((v) => ({ ...v }))
  }
}

export class InMemoryScreeningStore implements ScreeningStore {
  readonly #byToken = new Map<string, ScreeningResult>()

  async latest(token: Address): Promise<ScreeningResult | undefined> {
    return this.#byToken.get(token.toLowerCase())
  }

  async put(result: ScreeningResult): Promise<void> {
    this.#byToken.set(result.token.toLowerCase(), result)
  }
}

/**
 * Trusted ingest. Every message carries a coin binding stamped at collection
 * time, and a fetch for one coin that would return another coin's message is a
 * hard error rather than a filtered-out row - a silent filter would hide the
 * bug that produced the mis-stamped message.
 */
export class InMemoryMessageSource implements MessageSource {
  readonly #messages: RawMessage[] = []

  add(...messages: RawMessage[]): void {
    this.#messages.push(...messages)
  }

  async since(coinRef: string, fromUnix: number, toUnix: number): Promise<readonly RawMessage[]> {
    const inWindow = this.#messages.filter(
      (m) => m.postedAtUnix >= fromUnix && m.postedAtUnix < toUnix,
    )
    const mine = inWindow.filter((m) => m.boundCoinRef === coinRef)
    if (mine.length !== inWindow.length) {
      // Not a filter. Ingest handed this source a message for another coin and
      // that is a bleed, so it stops here rather than being quietly dropped.
      const other = inWindow.find((m) => m.boundCoinRef !== coinRef)
      throw new CoinIsolationError(coinRef, other?.boundCoinRef ?? '<unknown>', 'message source')
    }
    return mine
  }
}

export class InMemoryApprovalStore implements ApprovalStore {
  readonly #byKey = new Map<string, HumanApprovalRecord>()

  async find(vault: Address, decisionDigest: string): Promise<HumanApprovalRecord | undefined> {
    return this.#byKey.get(`${vault}|${decisionDigest}`)
  }

  async put(vault: Address, record: HumanApprovalRecord): Promise<void> {
    this.#byKey.set(`${vault}|${record.decisionDigest}`, record)
  }
}

export class InMemoryInvoiceRegistry implements InvoiceRegistry {
  readonly #rows: { vault: string; invoice: VendorInvoice; settledTxHash?: TxHash }[] = []

  async put(vault: Address, invoice: VendorInvoice): Promise<void> {
    const key = vault.toLowerCase()
    if (this.#rows.some((r) => r.vault === key && r.invoice.invoiceHash === invoice.invoiceHash)) {
      throw new Error(`invoice ${invoice.invoiceHash} already recorded for ${vault}`)
    }
    this.#rows.push({ vault: key, invoice })
  }

  async find(
    vault: Address,
    skuId: string,
    quantity: number,
    _nowUnix: number,
  ): Promise<VendorInvoice | undefined> {
    const key = vault.toLowerCase()
    return this.#rows
      .filter((r) => r.vault === key && r.settledTxHash === undefined)
      .map((r) => r.invoice)
      .sort((a, b) => a.issuedAtUnix - b.issuedAtUnix)
      .find((i) => i.skuId === skuId && i.quantity === quantity)
  }

  async listPending(vault: Address): Promise<readonly VendorInvoice[]> {
    const key = vault.toLowerCase()
    return this.#rows
      .filter((r) => r.vault === key && r.settledTxHash === undefined)
      .map((r) => r.invoice)
      .sort((a, b) => a.issuedAtUnix - b.issuedAtUnix)
  }

  async markSettled(vault: Address, invoiceHash: string, txHash: TxHash): Promise<void> {
    const key = vault.toLowerCase()
    const row = this.#rows.find((r) => r.vault === key && r.invoice.invoiceHash === invoiceHash)
    if (row === undefined) throw new Error(`invoice ${invoiceHash} is not recorded for ${vault}`)
    row.settledTxHash = txHash
  }
}

export class InMemoryPendingPurchaseStore implements PendingPurchaseStore {
  readonly #byKey = new Map<string, PendingPurchase>()

  async awaitingInvoice(vault: Address): Promise<readonly PendingPurchase[]> {
    const key = vault.toLowerCase()
    return [...this.#byKey.values()]
      .filter((p) => p.vault === key)
      .sort((a, b) => a.proposedAtUnix - b.proposedAtUnix)
  }

  async record(purchase: PendingPurchase): Promise<void> {
    const key = pendingKey(purchase.vault, purchase.skuId, purchase.quantity)
    const existing = this.#byKey.get(key)
    if (existing !== undefined && existing.proposedAtUnix <= purchase.proposedAtUnix) return
    this.#byKey.set(key, { ...purchase, vault: purchase.vault.toLowerCase() })
  }

  async clear(vault: Address, skuId: string, quantity: number): Promise<void> {
    this.#byKey.delete(pendingKey(vault, skuId, quantity))
  }
}

function pendingKey(vault: Address, skuId: string, quantity: number): string {
  return `${vault.toLowerCase()}|${skuId}|${String(quantity)}`
}

/** Records every schedule so a test can assert the tick enqueued the checks. */
export class InMemoryPredicateQueue implements PredicateQueue {
  readonly scheduled: PredicateSchedule[] = []

  async enqueue(schedule: PredicateSchedule): Promise<void> {
    if (this.scheduled.some((s) => s.disbursementId === schedule.disbursementId)) return
    this.scheduled.push(schedule)
  }
}

/**
 * Settlement fake.
 *
 * Note the shape of `submit`: it takes ONE argument and that argument is the
 * pull. There is nowhere here to put a payee, which is the same property the
 * real implementation must have.
 */
export class FakeSettlementPort implements SettlementPort {
  readonly submitted: ReimbursementPull[] = []
  readonly #nowUnix: () => number
  #failNext = false
  #seq = 0

  /**
   * `nowUnix` stamps the receipt. Pass the FIXTURE clock whenever the test
   * touches a daily counter: the default is the wall clock, and on a fixture
   * clock set to some other date that puts the disbursement in a different UTC
   * day from the one the money gates read, which reads as a cap that binds
   * when nothing was counting.
   */
  constructor(nowUnix: () => number = () => Math.floor(Date.now() / 1000)) {
    this.#nowUnix = nowUnix
  }

  failNext(): void {
    this.#failNext = true
  }

  async submit(pull: ReimbursementPull): Promise<SettlementReceipt> {
    if (this.#failNext) {
      this.#failNext = false
      throw new Error('settlement rejected by the fake')
    }
    this.submitted.push(pull)
    this.#seq += 1
    return {
      txHash: `0x${this.#seq.toString(16).padStart(64, '0')}`,
      settledMinor: pull.amountMinor,
      settledAtUnix: this.#nowUnix(),
    }
  }
}

export class InMemoryEscalationSink implements EscalationSink {
  readonly raised: Escalation[] = []

  async raise(escalation: Escalation): Promise<void> {
    this.raised.push(escalation)
  }

  byKind(kind: Escalation['kind']): Escalation[] {
    return this.raised.filter((e) => e.kind === kind)
  }
}

/** Reads the indexer's own in-memory store through the narrow tick-loop view. */
export class InMemoryChainReadModel implements ChainReadModel {
  readonly #bindings = new Map<string, CoinBinding>()
  readonly #postings: FeePosting[] = []
  readonly #halts = new Map<string, HaltNotice[]>()
  readonly #claims: ClaimObservation[] = []
  readonly #allocations: AllocationObservation[] = []

  putBinding(binding: CoinBinding): void {
    this.#bindings.set(binding.token.toLowerCase(), binding)
  }

  putPostings(...postings: FeePosting[]): void {
    for (const posting of postings) {
      if (!this.#postings.some((p) => p.id === posting.id)) this.#postings.push(posting)
    }
  }

  putClaim(claim: ClaimObservation): void {
    this.#claims.push(claim)
  }

  putAllocation(allocation: AllocationObservation): void {
    this.#allocations.push(allocation)
  }

  putHalt(token: Address, notice: HaltNotice): void {
    const key = token.toLowerCase()
    this.#halts.set(key, [...(this.#halts.get(key) ?? []), notice])
  }

  clearHalts(token: Address): void {
    this.#halts.delete(token.toLowerCase())
  }

  async binding(token: Address): Promise<CoinBinding | undefined> {
    return this.#bindings.get(token.toLowerCase())
  }

  async postings(vault: Address, fromUnix: number, toUnix: number): Promise<readonly FeePosting[]> {
    return this.#postings.filter(
      (p) => p.vault === vault && p.occurredAtUnix >= fromUnix && p.occurredAtUnix <= toUnix,
    )
  }

  async halts(token: Address): Promise<readonly HaltNotice[]> {
    return this.#halts.get(token.toLowerCase()) ?? []
  }

  async claims(vault: Address, fromUnix: number, toUnix: number): Promise<readonly ClaimObservation[]> {
    return this.#claims.filter(
      (c) => c.vault === vault && c.occurredAtUnix >= fromUnix && c.occurredAtUnix <= toUnix,
    )
  }

  async allocations(
    vault: Address,
    fromUnix: number,
    toUnix: number,
  ): Promise<readonly AllocationObservation[]> {
    return this.#allocations.filter(
      (a) => a.vault === vault && a.occurredAtUnix >= fromUnix && a.occurredAtUnix <= toUnix,
    )
  }
}

