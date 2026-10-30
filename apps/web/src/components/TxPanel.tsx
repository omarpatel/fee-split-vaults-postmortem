import { useState } from 'react'

import { useApp } from '../app/context.js'
import type { UnsignedTx } from '../api/model.js'
import { calldataEquals } from '../crypto/calldata.js'
import { AddressChip, Badge, Callout, CopyField } from './primitives.js'
import { WalletError } from '../wallet/types.js'

/**
 * A transaction the dev is about to send.
 *
 * `expectedData` is calldata this app built locally from the parameters the dev
 * chose. When it is supplied and does not match what the API returned, the send
 * button is disabled and the mismatch is shown in full. Every transaction on
 * this dashboard moves or redirects the dev's own money, and "paste the hex your
 * service provider gave you" is precisely the instruction a compromised
 * provider would want followed.
 */

export function TxPanel({
  tx,
  expectedData,
  title,
  onSent,
}: {
  tx: UnsignedTx
  expectedData?: string
  title: string
  onSent?: (hash: string) => void
}) {
  const { wallet } = useApp()
  const [hash, setHash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const verified = expectedData === undefined ? null : calldataEquals(expectedData, tx.data)
  const blocked = verified === false

  async function send() {
    if (wallet === null) {
      setError('Connect a wallet that can broadcast on this chain.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await wallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value,
        chainId: tx.chainId,
      })
      setHash(result)
      onSent?.(result)
    } catch (cause: unknown) {
      setError(cause instanceof WalletError ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card-flat stack-tight">
      <div className="row-between">
        <strong>{title}</strong>
        {verified === true && <Badge tone="good">calldata verified locally</Badge>}
        {verified === false && <Badge tone="bad">calldata mismatch</Badge>}
      </div>

      <p className="small muted" style={{ margin: 0 }}>
        {tx.summary}
      </p>

      <div className="row small">
        <span className="muted">to</span>
        <AddressChip address={tx.to} />
        <span className="muted">chain</span>
        <code className="tiny">{tx.chainId}</code>
        <span className="muted">value</span>
        <code className="tiny">{tx.value}</code>
      </div>

      <CopyField value={tx.data} label="Calldata" />

      {blocked && (
        <Callout tone="bad" title="This is not the transaction you asked for">
          <p>
            The calldata this page built from your own inputs does not match what the API returned.
            Do not send this. Either the request was tampered with in transit or the service is not
            building what it says it is.
          </p>
          <CopyField value={expectedData ?? ''} label="What this page expected" />
        </Callout>
      )}

      {hash === null ? (
        <div className="row">
          <button type="button" className="btn btn-primary btn-small" disabled={busy || blocked} onClick={() => void send()}>
            {busy ? 'Waiting for your wallet…' : 'Send from my wallet'}
          </button>
          <span className="tiny faint">
            You send this. The operator holds no key that could send it for you.
          </span>
        </div>
      ) : (
        <Callout tone="good" title="Broadcast">
          <code className="tiny">{hash}</code>
        </Callout>
      )}

      {error !== null && (
        <Callout tone="warn" title="Not sent">
          {error}
        </Callout>
      )}
    </div>
  )
}
