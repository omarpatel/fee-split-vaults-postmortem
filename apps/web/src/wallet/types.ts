/**
 * The narrow wallet interface.
 *
 * Deliberately not the whole EIP-1193 surface. This app needs to know an
 * address, ask for a personal_sign, ask for an eth_signTypedData_v4, and send a
 * transaction the dev has read. Nothing else is exposed, so nothing else can be
 * called by accident - in particular there is no generic `request` escape
 * hatch on this type, which is what would otherwise let a component reach for
 * eth_sendTransaction with calldata it did not build.
 */

import type { Eip712TypedData } from '../crypto/consent.js'

export interface WalletAccount {
  address: string
  chainId: number
}

export interface TransactionRequest {
  to: string
  data: string
  value: string
  chainId: number
}

export class WalletError extends Error {
  constructor(
    message: string,
    readonly code: 'no_wallet' | 'rejected' | 'wrong_chain' | 'unsupported' | 'failed',
  ) {
    super(message)
    this.name = 'WalletError'
  }
}

export interface Wallet {
  /** A stable label for the UI, e.g. "Browser wallet" or "Demo wallet". */
  readonly label: string
  /** True when this wallet cannot produce a real signature. Shown, not hidden. */
  readonly isDemo: boolean

  connect(): Promise<WalletAccount>
  disconnect(): Promise<void>
  getAccount(): WalletAccount | null

  /** Sign-in. Proves control of the address; authorises no transfer. */
  personalSign(message: string): Promise<string>
  /** The consent. The wallet renders the struct; the dev reads it there too. */
  signTypedData(data: Eip712TypedData): Promise<string>
  /** The dev sends every state-changing transaction themselves. */
  sendTransaction(request: TransactionRequest): Promise<string>

  /** Fired when the account or chain changes underneath the app. */
  subscribe(listener: (account: WalletAccount | null) => void): () => void
}
