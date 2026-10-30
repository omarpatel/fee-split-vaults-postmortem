/**
 * The in-memory fake wallet.
 *
 * It exists so the whole app - including sign-in and consent signing - runs
 * offline with no extension installed, and so the flows can be tested without
 * a browser. It is honest about being fake: `isDemo` is true, every surface
 * that uses it says so, and the "signature" it returns is a keyed hash that
 * only the fixture backend accepts.
 *
 * It also refuses to send transactions. A demo wallet that pretended to
 * broadcast would let the terminate control, the dial control and the retrofit
 * transfer all appear to succeed without anyone noticing they never ran.
 */

import type { Eip712TypedData } from '../crypto/consent.js'
import { normalizeAddress } from '../crypto/hex.js'
import { demoSignature } from './demo-signature.js'
import { WalletError, type TransactionRequest, type Wallet, type WalletAccount } from './types.js'

export interface FakeWalletOptions {
  address: string
  chainId: number
  /** Set true to exercise the rejection path in the UI. */
  rejectEverything?: boolean
}

export class FakeWallet implements Wallet {
  readonly label = 'Demo wallet'
  readonly isDemo = true

  #account: WalletAccount | null = null
  readonly #address: string
  readonly #chainId: number
  readonly #reject: boolean
  readonly #listeners = new Set<(account: WalletAccount | null) => void>()

  /** Every message this wallet was asked to sign, for assertions in tests. */
  readonly signed: Array<{ kind: 'personal' | 'typed'; payload: string }> = []

  constructor(options: FakeWalletOptions) {
    this.#address = normalizeAddress(options.address)
    this.#chainId = options.chainId
    this.#reject = options.rejectEverything ?? false
  }

  async connect(): Promise<WalletAccount> {
    if (this.#reject) throw new WalletError('The demo wallet is set to reject.', 'rejected')
    this.#account = { address: this.#address, chainId: this.#chainId }
    this.#emit()
    return this.#account
  }

  async disconnect(): Promise<void> {
    this.#account = null
    this.#emit()
  }

  getAccount(): WalletAccount | null {
    return this.#account
  }

  #emit(): void {
    for (const listener of this.#listeners) listener(this.#account)
  }

  #requireAccount(): WalletAccount {
    if (this.#account === null) throw new WalletError('Connect the demo wallet first.', 'no_wallet')
    if (this.#reject) throw new WalletError('The demo wallet is set to reject.', 'rejected')
    return this.#account
  }

  async personalSign(message: string): Promise<string> {
    const account = this.#requireAccount()
    this.signed.push({ kind: 'personal', payload: message })
    return demoSignature(account.address, message)
  }

  async signTypedData(data: Eip712TypedData): Promise<string> {
    const account = this.#requireAccount()
    const payload = JSON.stringify(data)
    this.signed.push({ kind: 'typed', payload })
    return demoSignature(account.address, payload)
  }

  async sendTransaction(_request: TransactionRequest): Promise<string> {
    throw new WalletError(
      'The demo wallet cannot broadcast. Connect a real wallet on chain ' +
        `${this.#chainId} to send this transaction.`,
      'unsupported',
    )
  }

  subscribe(listener: (account: WalletAccount | null) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
}
