/**
 * The injected-provider adapter (MetaMask, Rabby, and anything else that puts
 * an EIP-1193 object on window.ethereum).
 *
 * The provider is treated as an external dependency behind the narrow Wallet
 * interface, so nothing in the app talks to window.ethereum directly and a page
 * cannot reach a method this file does not expose.
 */

import type { Eip712TypedData } from '../crypto/consent.js'
import { bytesToHex, normalizeAddress, utf8ToBytes } from '../crypto/hex.js'
import { WalletError, type TransactionRequest, type Wallet, type WalletAccount } from './types.js'

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
  on?(event: string, listener: (...args: unknown[]) => void): void
  removeListener?(event: string, listener: (...args: unknown[]) => void): void
}

declare global {
  // eslint-disable-next-line no-var
  var ethereum: Eip1193Provider | undefined
}

export function hasInjectedWallet(): boolean {
  return typeof globalThis.ethereum === 'object' && globalThis.ethereum !== null
}

export class InjectedWallet implements Wallet {
  readonly label = 'Browser wallet'
  readonly isDemo = false

  #account: WalletAccount | null = null
  readonly #listeners = new Set<(account: WalletAccount | null) => void>()
  readonly #expectedChainId: number

  constructor(expectedChainId: number) {
    this.#expectedChainId = expectedChainId
  }

  #provider(): Eip1193Provider {
    const provider = globalThis.ethereum
    if (provider === undefined) {
      throw new WalletError('No browser wallet found in this page.', 'no_wallet')
    }
    return provider
  }

  #emit(): void {
    for (const listener of this.#listeners) listener(this.#account)
  }

  async connect(): Promise<WalletAccount> {
    const provider = this.#provider()
    let accounts: unknown
    try {
      accounts = await provider.request({ method: 'eth_requestAccounts' })
    } catch {
      throw new WalletError('The wallet rejected the connection request.', 'rejected')
    }
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string') {
      throw new WalletError('The wallet returned no account.', 'failed')
    }
    const chainIdHex = await provider.request({ method: 'eth_chainId' })
    const chainId = typeof chainIdHex === 'string' ? Number.parseInt(chainIdHex, 16) : Number.NaN

    this.#account = { address: normalizeAddress(accounts[0]), chainId }

    provider.on?.('accountsChanged', (...args: unknown[]) => {
      const next = args[0]
      this.#account =
        Array.isArray(next) && typeof next[0] === 'string' && this.#account !== null
          ? { address: normalizeAddress(next[0]), chainId: this.#account.chainId }
          : null
      this.#emit()
    })
    provider.on?.('chainChanged', (...args: unknown[]) => {
      const next = args[0]
      if (this.#account !== null && typeof next === 'string') {
        this.#account = { ...this.#account, chainId: Number.parseInt(next, 16) }
      }
      this.#emit()
    })

    this.#emit()
    return this.#account
  }

  async disconnect(): Promise<void> {
    // EIP-1193 has no disconnect. Forgetting the account locally is the honest
    // scope of what this app can do, and the UI says so.
    this.#account = null
    this.#emit()
  }

  getAccount(): WalletAccount | null {
    return this.#account
  }

  #requireAccount(): WalletAccount {
    if (this.#account === null) throw new WalletError('Connect a wallet first.', 'no_wallet')
    return this.#account
  }

  async personalSign(message: string): Promise<string> {
    const account = this.#requireAccount()
    const result = await this.#provider().request({
      method: 'personal_sign',
      // Hex-encoded UTF-8, not a raw string: providers differ on how they treat
      // a bare string and the difference changes what gets signed.
      params: [bytesToHex(utf8ToBytes(message)), account.address],
    })
    if (typeof result !== 'string') throw new WalletError('The wallet returned no signature.', 'failed')
    return result
  }

  async signTypedData(data: Eip712TypedData): Promise<string> {
    const account = this.#requireAccount()
    if (account.chainId !== this.#expectedChainId) {
      throw new WalletError(
        `This wallet is on chain ${account.chainId}; the consent is for chain ${this.#expectedChainId}.`,
        'wrong_chain',
      )
    }
    const result = await this.#provider().request({
      method: 'eth_signTypedData_v4',
      params: [account.address, JSON.stringify(data)],
    })
    if (typeof result !== 'string') throw new WalletError('The wallet returned no signature.', 'failed')
    return result
  }

  async sendTransaction(request: TransactionRequest): Promise<string> {
    const account = this.#requireAccount()
    if (account.chainId !== request.chainId) {
      throw new WalletError(
        `This wallet is on chain ${account.chainId}; the transaction is for chain ${request.chainId}.`,
        'wrong_chain',
      )
    }
    const result = await this.#provider().request({
      method: 'eth_sendTransaction',
      params: [
        {
          from: account.address,
          to: request.to,
          data: request.data,
          value: `0x${BigInt(request.value).toString(16)}`,
        },
      ],
    })
    if (typeof result !== 'string') throw new WalletError('The wallet returned no tx hash.', 'failed')
    return result
  }

  subscribe(listener: (account: WalletAccount | null) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
}
