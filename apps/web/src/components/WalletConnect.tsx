import { useState } from 'react'

import { useApp } from '../app/context.js'
import { FixtureApiClient } from '../api/fixtures/client.js'
import { VENUE } from '../protocol.js'
import { FakeWallet } from '../wallet/fake.js'
import { hasInjectedWallet, InjectedWallet } from '../wallet/injected.js'
import { WalletError } from '../wallet/types.js'
import { AddressChip, Badge, Callout } from './primitives.js'

/**
 * Wallet connect and signature sign-in.
 *
 * There is no password anywhere in this app and no account to create. Sign-in
 * is a personal_sign over a message that says, in the wallet prompt itself,
 * that it authorises no transfer and no vault change - because the habit this
 * industry teaches devs is to sign whatever appears, and the least we can do is
 * make our own prompt readable.
 *
 * The session is held in memory only. Reloading costs one signature; a stored
 * bearer token costs whatever a stolen bearer token costs.
 */

export function WalletConnect({ compact = false }: { compact?: boolean }) {
  const { client, wallet, setWallet, session, setSession, env } = useApp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const account = wallet?.getAccount() ?? null

  async function connect(next: 'injected' | 'demo', demoAddress?: string) {
    setError(null)
    setBusy(true)
    try {
      const instance =
        next === 'injected'
          ? new InjectedWallet(VENUE.chainId)
          : new FakeWallet({ address: demoAddress ?? '0x'.padEnd(42, '0'), chainId: VENUE.chainId })
      await instance.connect()
      setWallet(instance)
    } catch (cause: unknown) {
      setError(cause instanceof WalletError ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function signIn() {
    if (wallet === null) return
    const connected = wallet.getAccount()
    if (connected === null) return
    setError(null)
    setBusy(true)
    try {
      const challenge = await client.requestChallenge(connected.address)
      const signature = await wallet.personalSign(challenge.message)
      setSession(await client.verifySignature(connected.address, challenge.message, signature))
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const demoAccounts =
    client instanceof FixtureApiClient ? client.demoDevAddresses : []

  if (account === null) {
    return (
      <div className={compact ? 'row' : 'card stack'}>
        {!compact && (
          <div>
            <span className="eyebrow">Sign in</span>
            <h2>Connect the wallet that controls your vault</h2>
            <p className="small muted">
              No password, no account, no email. A signature proves you control the address; it
              authorises no transfer and changes nothing on chain.
            </p>
          </div>
        )}

        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !hasInjectedWallet()}
            onClick={() => void connect('injected')}
          >
            {hasInjectedWallet() ? 'Connect browser wallet' : 'No browser wallet found'}
          </button>
        </div>

        {env.isDemo && demoAccounts.length > 0 && (
          <div className="card-flat stack-tight">
            <div className="row">
              <Badge tone="warn">demo</Badge>
              <strong className="small">Sign in as a fixture dev</strong>
            </div>
            <p className="tiny muted" style={{ margin: 0 }}>
              The demo wallet does not hold a key and cannot broadcast. It produces a keyed hash the
              fixture backend recognises, so the sign-in flow is real even though the signature is
              not.
            </p>
            <div className="row">
              {demoAccounts.map((entry) => (
                <button
                  key={entry.vault}
                  type="button"
                  className="btn btn-small"
                  disabled={busy}
                  onClick={() => void connect('demo', entry.devSigner)}
                >
                  {entry.symbol} dev
                </button>
              ))}
            </div>
          </div>
        )}

        {error !== null && (
          <Callout tone="bad" title="Could not connect">
            {error}
          </Callout>
        )}
      </div>
    )
  }

  return (
    <div className={compact ? 'row' : 'card stack-tight'}>
      <div className="row">
        <AddressChip address={account.address} />
        <Badge tone={wallet?.isDemo === true ? 'warn' : 'neutral'}>
          {wallet?.label ?? 'wallet'}
        </Badge>
        {account.chainId !== VENUE.chainId && (
          <Badge tone="bad" title={`Expected chain ${VENUE.chainId}`}>
            wrong chain: {account.chainId}
          </Badge>
        )}
        {session !== null && <Badge tone="good">signed in</Badge>}
      </div>

      <div className="row">
        {session === null ? (
          <button type="button" className="btn btn-primary btn-small" disabled={busy} onClick={() => void signIn()}>
            {busy ? 'Waiting for signature…' : 'Sign in'}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              setSession(null)
            }}
          >
            Sign out
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-small"
          onClick={() => {
            void wallet?.disconnect()
            setWallet(null)
            setSession(null)
          }}
        >
          Disconnect
        </button>
      </div>

      {error !== null && (
        <Callout tone="bad" title="Sign-in failed">
          {error}
        </Callout>
      )}
    </div>
  )
}
