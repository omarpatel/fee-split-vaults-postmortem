import { useState } from 'react'

import type { ConsentQuote, RetrofitPlan } from '../api/model.js'
import { useApp } from '../app/context.js'
import { TxPanel } from '../components/TxPanel.js'
import { WalletConnect } from '../components/WalletConnect.js'
import { AddressChip, Badge, Callout, CopyField, Skeleton, TokenAmount, Usd } from '../components/primitives.js'
import { encodeTransferCreatorFeeRecipient } from '../crypto/calldata.js'
import {
  consentDigest,
  consentSalt,
  consentTypedData,
  predictVaultAddress,
  ZERO_ADDRESS,
  type ConsentStruct,
} from '../crypto/consent.js'
import { breakEvenMultipleFor } from '../domain/fees.js'
import { formatBps } from '../domain/money.js'
import {
  describeNarrativeSourceProblem,
  MAX_NARRATIVE_SOURCES,
  narrativeSourceProblem,
  normalizeNarrativeSources,
  normalizeXHandle,
} from '../domain/onboarding.js'
import { TERMS } from '../protocol.js'

/**
 * Onboarding.
 *
 * The claim this flow has to make good on is that the rate can never be changed
 * on a dev, and the evidence for it is the address: every economic term is in
 * the CREATE2 salt preimage, so a different operator fee is a different vault
 * at a different address, and the address that already exists cannot be
 * redeployed. There is no admin function to change a rate because there is no
 * address at which a changed rate could live.
 *
 * That claim is worth nothing if the dev has to take our word for the address.
 * So the page recomputes the salt, the digest and the CREATE2 address LOCALLY
 * from the consent it is about to sign, compares all three against the server's,
 * and refuses to render a signing button when they disagree.
 *
 * The retrofit step ends with a warning that is out of proportion to its size,
 * because the failure it prevents is silent and permanent: the Venue V2 escrow
 * keys credits by (recipient, quoteAsset) and is msg.sender-only. Move
 * recipiency with a balance still credited and that balance is claimable only
 * by the old recipient, forever. Nobody - not the operator, not Venue - can
 * retrieve it on the dev's behalf.
 */

type Step = 'connect' | 'terms' | 'sign' | 'retrofit'

export function Onboarding() {
  const { client, protocol, wallet, env } = useApp()
  const account = wallet?.getAccount() ?? null

  // Annotated because TERMS is `as const`, so the inferred state type would be
  // the literal 4000 and the slider could never move.
  const [budgetBpsMax, setBudgetBpsMax] = useState<number>(TERMS.budgetBpsMax)
  const [token, setToken] = useState('')
  const [payout, setPayout] = useState('')
  const [sources, setSources] = useState<string[]>(() => Array<string>(MAX_NARRATIVE_SOURCES).fill(''))
  const [xHandle, setXHandle] = useState('')
  const [quote, setQuote] = useState<ConsentQuote | null>(null)
  const [signature, setSignature] = useState<string | null>(null)
  const [retrofit, setRetrofit] = useState<RetrofitPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const step: Step =
    account === null ? 'connect' : quote === null ? 'terms' : signature === null ? 'sign' : 'retrofit'

  // Validated as typed, so a source the API would refuse is named on the form
  // rather than as a 400 after the wallet is already connected and waiting.
  const sourceProblems = sources.map((source) => {
    const url = source.trim()
    return url.length === 0 ? null : narrativeSourceProblem(url)
  })
  const narrativeSources = normalizeNarrativeSources(sources)
  const x = normalizeXHandle(xHandle)
  const xInvalid = xHandle.trim().length > 0 && x === null
  const termsValid = sourceProblems.every((problem) => problem === null) && !xInvalid

  async function requestQuote() {
    if (account === null) return
    setBusy(true)
    setError(null)
    try {
      setQuote(
        await client.quoteConsent({
          devSigner: account.address,
          devPayout: payout.trim().length > 0 ? payout.trim() : account.address,
          token: token.trim().length > 0 ? token.trim() : ZERO_ADDRESS,
          budgetBpsMax,
          ...(narrativeSources.length === 0 ? {} : { narrativeSources }),
          ...(x === null ? {} : { socials: { x } }),
        }),
      )
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function sign() {
    if (quote === null || wallet === null || protocol === null) return
    setBusy(true)
    setError(null)
    try {
      const typedData = consentTypedData(quote.consent as ConsentStruct, {
        chainId: protocol.chainId,
        factory: protocol.factory,
        vaultDeployer: protocol.vaultDeployer,
        vaultInitCodeHash: protocol.vaultInitCodeHash,
      })
      const result = await wallet.signTypedData(typedData)
      setSignature(result)
      await client.submitConsent({ consent: quote.consent, signature: result })
      setRetrofit(await client.getRetrofitPlan(quote.consent.token, quote.predictedVault))
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page stack-loose" style={{ paddingTop: 'var(--gap-5)' }}>
      <header className="stack">
        <span className="eyebrow">Onboarding</span>
        <h1 style={{ maxWidth: '22ch' }}>Every term is in the address</h1>
        <p className="lede">
          You will see the exact address your vault will be deployed at before you sign anything,
          and this page will recompute it from the terms in front of you rather than trusting the
          number we sent it.
        </p>
        {env.isDemo && <Badge tone="warn">demo backend — nothing is deployed</Badge>}
      </header>

      <ol className="steps">
        <li data-state={step === 'connect' ? 'active' : 'done'}>
          <h3>Connect your wallet</h3>
          <p className="small muted">
            The address that controls your token&rsquo;s creator-fee recipiency today.
          </p>
          <WalletConnect compact={account !== null} />
        </li>

        <li data-state={account === null ? 'todo' : quote === null ? 'active' : 'done'}>
          <h3>Choose your terms</h3>
          <p className="small muted">
            The operator fee is fixed at {formatBps(protocol?.operatorBps ?? TERMS.operatorBps)} and
            is not negotiable per-dev — that is what makes it checkable. What you choose is the
            ceiling on your own procurement dial.
          </p>

          <div className="grid-2" style={{ marginTop: 'var(--gap-2)' }}>
            <div className="field">
              <label htmlFor="token">Token address</label>
              <input
                id="token"
                type="text"
                placeholder="0x… (leave blank for a token you have not launched yet)"
                value={token}
                onChange={(event) => setToken(event.currentTarget.value)}
                disabled={account === null || quote !== null}
              />
              <span className="field-hint">
                Bound into the salt on the retrofit path, so this vault can only ever serve this
                token.
              </span>
            </div>
            <div className="field">
              <label htmlFor="payout">Your payout address</label>
              <input
                id="payout"
                type="text"
                placeholder={account?.address ?? '0x…'}
                value={payout}
                onChange={(event) => setPayout(event.currentTarget.value)}
                disabled={account === null || quote !== null}
              />
              <span className="field-hint">
                The only address that can ever withdraw your leg. Defaults to the connected wallet.
              </span>
            </div>
          </div>

          <div className="field" style={{ marginTop: 'var(--gap-2)' }}>
            <label htmlFor="ceiling">
              Procurement ceiling: {formatBps(budgetBpsMax)}{' '}
              <span className="field-hint">
                (your dial can move between 0% and this, later; the ceiling itself is immutable)
              </span>
            </label>
            <input
              id="ceiling"
              type="range"
              min={0}
              max={TERMS.budgetBpsMax}
              step={100}
              value={budgetBpsMax}
              disabled={account === null || quote !== null}
              onChange={(event) => setBudgetBpsMax(Number(event.currentTarget.value))}
            />
            <span className="field-hint">
              At the ceiling, your break-even multiple would be{' '}
              <strong>
                {breakEvenMultipleFor({
                  operatorBps: protocol?.operatorBps ?? TERMS.operatorBps,
                  budgetBps: budgetBpsMax,
                }).toFixed(2)}
                ×
              </strong>
              . That is the hurdle the service has to clear before you are ahead. You are not
              obliged to run the dial anywhere near the ceiling.
            </span>
          </div>

          <div className="stack-tight" style={{ marginTop: 'var(--gap-3)' }}>
            <div>
              <h4 style={{ margin: 0 }}>What is this coin about?</h4>
              <p className="small muted" style={{ margin: 0 }}>
                Up to {MAX_NARRATIVE_SOURCES} links — the launch post, the site — that say what the
                coin is. The operator derives a summary from these and a human reviews it before
                anything is posted about your coin. The links themselves are never shown publicly;
                only how many you named.
              </p>
            </div>
            {sources.map((source, index) => {
              const problem = sourceProblems[index] ?? null
              const id = `source-${String(index)}`
              return (
                <div className="field" key={id}>
                  <label htmlFor={id}>
                    Source {index + 1}
                    {index > 0 && <span className="field-hint"> (optional)</span>}
                  </label>
                  <input
                    id={id}
                    type="text"
                    inputMode="url"
                    placeholder="https://…"
                    value={source}
                    aria-invalid={problem !== null}
                    aria-describedby={problem === null ? undefined : `${id}-error`}
                    onChange={(event) => {
                      const next = [...sources]
                      next[index] = event.currentTarget.value
                      setSources(next)
                    }}
                    disabled={account === null || quote !== null}
                  />
                  {problem !== null && (
                    <span id={`${id}-error`} className="field-error">
                      {describeNarrativeSourceProblem(problem)}
                    </span>
                  )}
                </div>
              )
            })}
            <div className="field">
              <label htmlFor="x-handle">
                X handle <span className="field-hint">(optional)</span>
              </label>
              <input
                id="x-handle"
                type="text"
                placeholder="@yourcoin"
                value={xHandle}
                aria-invalid={xInvalid}
                aria-describedby={xInvalid ? 'x-handle-error' : undefined}
                onChange={(event) => setXHandle(event.currentTarget.value)}
                disabled={account === null || quote !== null}
              />
              {xInvalid ? (
                <span id="x-handle-error" className="field-error">
                  An X handle is 1–15 letters, digits or underscores.
                </span>
              ) : (
                <span className="field-hint">
                  For the operator only. Never shown publicly, never read by a model.
                </span>
              )}
            </div>
          </div>

          {quote === null && (
            <button
              type="button"
              className="btn btn-primary"
              style={{ marginTop: 'var(--gap-2)' }}
              disabled={account === null || busy || !termsValid}
              onClick={() => void requestQuote()}
            >
              {busy ? 'Deriving the vault address…' : 'Show me the address'}
            </button>
          )}
        </li>

        <li data-state={quote === null ? 'todo' : signature === null ? 'active' : 'done'}>
          <h3>Check the address, then sign</h3>
          {quote === null ? (
            <p className="small muted">The predicted address appears here before you sign.</p>
          ) : (
            <ConsentReview quote={quote} onSign={() => void sign()} busy={busy} signed={signature !== null} />
          )}
        </li>

        <li data-state={signature === null ? 'todo' : 'active'}>
          <h3>Point your creator fees at the vault</h3>
          {retrofit === null ? (
            <p className="small muted">
              The retrofit transaction and the sweep warning appear here once the consent is signed.
            </p>
          ) : (
            <RetrofitStep plan={retrofit} />
          )}
        </li>
      </ol>

      {error !== null && (
        <Callout tone="bad" title="Onboarding stopped">
          {error}
        </Callout>
      )}
    </div>
  )
}

function ConsentReview({
  quote,
  onSign,
  busy,
  signed,
}: {
  quote: ConsentQuote
  onSign: () => void
  busy: boolean
  signed: boolean
}) {
  const { protocol } = useApp()
  if (protocol === null) return <Skeleton height={120} />

  const deployment = {
    chainId: protocol.chainId,
    factory: protocol.factory,
    vaultDeployer: protocol.vaultDeployer,
    vaultInitCodeHash: protocol.vaultInitCodeHash,
  }

  const consent = quote.consent as ConsentStruct
  const localVault = predictVaultAddress(consent, deployment)
  const localSalt = consentSalt(consent)
  const localDigest = consentDigest(consent, protocol.chainId, protocol.factory)

  const vaultMatches = localVault.toLowerCase() === quote.predictedVault.toLowerCase()
  const saltMatches = localSalt.toLowerCase() === quote.salt.toLowerCase()
  const digestMatches = localDigest.toLowerCase() === quote.digest.toLowerCase()
  const allMatch = vaultMatches && saltMatches && digestMatches

  return (
    <div className="stack">
      <div className="card stack-tight">
        <div className="row-between">
          <span className="eyebrow">Your vault will be deployed at</span>
          {allMatch ? (
            <Badge tone="good">recomputed in your browser — matches</Badge>
          ) : (
            <Badge tone="bad">does not match what the server sent</Badge>
          )}
        </div>
        <CopyField value={localVault} />
        <p className="small muted" style={{ margin: 0 }}>
          This address is <code>keccak256(0xff ‖ deployer ‖ salt ‖ initCodeHash)</code>, where the
          salt is <code>keccak256(abi.encode(consent))</code> and the consent contains every
          economic term below. Change any one of them and you get a different address — which is why
          nobody can reprice this vault later. There is no admin function to change a rate, because
          there is no address at which a changed rate could live.
        </p>
      </div>

      {!allMatch && (
        <Callout tone="bad" title="Do not sign this">
          <p>
            The address, salt or digest this page derived from the terms shown does not match what
            the API returned. Something between you and the terms you are reading is wrong.
          </p>
          <ul className="tiny mono" style={{ paddingLeft: '1.1em' }}>
            <li>vault: local {localVault} / server {quote.predictedVault}</li>
            <li>salt: {saltMatches ? 'matches' : `local ${localSalt} / server ${quote.salt}`}</li>
            <li>digest: {digestMatches ? 'matches' : `local ${localDigest} / server ${quote.digest}`}</li>
          </ul>
        </Callout>
      )}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Term</th>
              <th>Value</th>
              <th>Changeable later?</th>
            </tr>
          </thead>
          <tbody>
            <ConsentRow label="Operator fee" value={formatBps(consent.operatorBps)} note="No — in the salt" />
            <ConsentRow label="Procurement ceiling" value={formatBps(consent.budgetBpsMax)} note="No — in the salt" />
            <ConsentRow
              label="Your payout address"
              value={<AddressChip address={consent.devPayout} />}
              note="No — in the salt"
            />
            <ConsentRow
              label="Token"
              value={
                consent.token === ZERO_ADDRESS ? (
                  <span className="faint">unbound (greenfield)</span>
                ) : (
                  <AddressChip address={consent.token} />
                )
              }
              note={consent.token === ZERO_ADDRESS ? 'Bound once, at bind()' : 'No — in the salt'}
            />
            <ConsentRow
              label="Referrer"
              value={
                consent.referrer === ZERO_ADDRESS ? (
                  <span className="faint">none</span>
                ) : (
                  <>
                    <AddressChip address={consent.referrer} /> at {formatBps(consent.referrerBps)} of
                    the operator&rsquo;s own slice
                  </>
                )
              }
              note="No — in the salt. Never dilutes you."
            />
            <ConsentRow label="Adapter" value={<AddressChip address={consent.adapter} />} note="Migratable by YOU, on a timelock" />
            <ConsentRow
              label="Terms hash"
              value={
                <a href={quote.termsUrl} target="_blank" rel="noreferrer noopener" className="tiny mono">
                  {consent.termsHash.slice(0, 18)}…
                </a>
              }
              note="No — in the salt"
            />
            <ConsentRow
              label="Signature expiry"
              value={new Date(consent.expiryUnix * 1_000).toISOString().slice(0, 16).replace('T', ' ')}
              note="Deployment after this is refused"
            />
            <ConsentRow label="Your dial" value="0% – the ceiling above" note="Yes — you set it, any time" />
          </tbody>
        </table>
      </div>

      <CopyField value={localSalt} label="CREATE2 salt (recomputed here)" />
      <CopyField value={localDigest} label="EIP-712 digest your wallet will sign" />

      {!signed && (
        <button type="button" className="btn btn-primary" disabled={busy || !allMatch} onClick={onSign}>
          {busy ? 'Waiting for your wallet…' : 'Sign the consent'}
        </button>
      )}
      {signed && <Badge tone="good">consent signed</Badge>}
    </div>
  )
}

function ConsentRow({
  label,
  value,
  note,
}: {
  label: string
  value: React.ReactNode
  note: string
}) {
  return (
    <tr>
      <td>
        <strong>{label}</strong>
      </td>
      <td>{value}</td>
      <td className="muted small">{note}</td>
    </tr>
  )
}

function RetrofitStep({ plan }: { plan: RetrofitPlan }) {
  const [claimed, setClaimed] = useState(false)
  const hasStrandable = plan.strandableCredits.some((credit) => credit.amountMinor > 0n)
  const expectedTransfer = encodeTransferCreatorFeeRecipient(plan.token, plan.vault)

  return (
    <div className="stack">
      <Callout tone="bad" title="Sweep and claim to ZERO before you transfer recipiency">
        <p>
          The Venue V2 fee escrow keys credited balances by{' '}
          <code>(recipient, quoteAsset)</code> and it is <strong>msg.sender-only</strong>: there is
          no claim-on-behalf. The moment recipiency moves to the vault, anything still credited to
          your current recipient address stays claimable only by that address.
        </p>
        <p style={{ margin: 0 }}>
          Nobody can recover it for you afterwards — not us, not Venue, not a support ticket. Claim
          to zero first. It costs you one transaction and it is the only step in this flow whose
          mistake is permanent.
        </p>
      </Callout>

      {hasStrandable && (
        <div className="card-flat stack-tight">
          <strong>Currently credited to {<AddressChip address={plan.currentRecipient} />}</strong>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th className="num">Credited</th>
                  <th className="num">USD</th>
                </tr>
              </thead>
              <tbody>
                {plan.strandableCredits.map((credit) => (
                  <tr key={credit.asset.address}>
                    <td>{credit.asset.symbol}</td>
                    <td className="num">
                      <TokenAmount
                        amount={credit.amountMinor}
                        decimals={credit.asset.decimals}
                        symbol={credit.asset.symbol}
                      />
                    </td>
                    <td className="num">
                      <Usd cents={credit.usd.cents} provenance={credit.usd} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {plan.claimTxs.length === 0 ? (
        <div className="callout callout-warn">
          <div className="callout-title">We could not read a credited balance for you</div>
          <p className="small" style={{ margin: 0 }}>
            That is not the same as there being none. Our indexer may not have seen this token, or
            an asset may be outside the set we track. Check the escrow yourself and claim to zero
            before you send the transfer below. This step fails closed on purpose: an empty list
            here is an absence of evidence, not evidence of absence.
          </p>
        </div>
      ) : (
        plan.claimTxs.map((tx, index) => (
          <TxPanel key={index} tx={tx} title={`Step ${index + 1} — claim to zero`} />
        ))
      )}

      <label className="row small" style={{ fontWeight: 400 }}>
        <input
          type="checkbox"
          checked={claimed}
          onChange={(event) => setClaimed(event.currentTarget.checked)}
          style={{ width: 'auto' }}
        />
        I have claimed every credited balance to zero under my current recipient address.
      </label>

      {claimed ? (
        <TxPanel
          tx={plan.transferTx}
          expectedData={expectedTransfer}
          title="Final step — transferCreatorFeeRecipient(token, vault)"
        />
      ) : (
        <div className="withheld">
          The recipiency transfer is hidden until you confirm the claim step above. It is not
          reversible in the direction that matters, so it does not get to be the first button you
          reach for.
        </div>
      )}
    </div>
  )
}
