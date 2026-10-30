import { useState } from 'react'

import { ONBOARDING_STATES, TERMINAL_STATES, type OnboardingRecordView, type OnboardingState } from '../../api/operator.js'
import { useAsync } from '../../app/context.js'
import { Link } from '../../app/router.js'
import { AddressChip, Badge, ErrorPanel, Skeleton, Timestamp } from '../../components/primitives.js'
import { RefusalPanel, StateBadge, useAction, useOperator, type Refusal } from './common.js'

/**
 * The queue: every onboarding, grouped by state, with the operator's next
 * move for that state and nothing else. Diligence is offered on a signed
 * record and not on a drafted one; activation on an accepted record and not on
 * a pointed one. The buttons follow the transition table in apps/api, so the
 * console cannot offer a move the service would refuse - and when the service
 * refuses anyway (the chain disagrees, a dependency is unwired), the refusal
 * code is shown as it came.
 */

export type QueueAction = 'diligence' | 'deploy' | 'pointing' | 'acceptance' | 'activate'

/** The forward move for a state. Decline is separate: it is legal from any non-terminal state. */
const FORWARD: Readonly<Partial<Record<OnboardingState, { action: QueueAction; label: string; hint: string }>>> = {
  signed: { action: 'diligence', label: 'Run diligence', hint: 'Fraud diligence plus a re-screen. Both must pass before a vault is deployed.' },
  screened: { action: 'deploy', label: 'Deploy vault', hint: 'CREATE2 at the address the consent already fixed. No admin key.' },
  deployed: { action: 'deploy', label: 'Bind vault', hint: 'The vault exists; bind it to the token so it can be pointed at.' },
  awaiting_pointing: { action: 'pointing', label: 'Confirm pointing', hint: 'Confirmed by reading the fee recipient on chain, not from a body.' },
  pointed: { action: 'acceptance', label: 'Record acceptance', hint: 'The dev called acceptService(). Confirmed from the vault state.' },
  accepted: { action: 'activate', label: 'Activate', hint: 'Consent 3 of 3: ours. Charging starts here and nowhere else.' },
}

const WAITING_ON: Readonly<Partial<Record<OnboardingState, string>>> = {
  drafted: 'Waiting on the dev to sign the consent.',
  active: 'Charging. Narrative, creative, accounts and purchases are on their own pages.',
  declined: 'Terminal. The dev keeps every fee.',
  withdrawn: 'Terminal. The dev withdrew.',
}

export function QueuePage() {
  const { operator, auth, nowUnix } = useOperator()
  const query = useAsync(() => operator.listOnboardings(auth), [auth.token])

  if (query.error !== null) return <ErrorPanel error={query.error} onRetry={query.reload} />
  if (query.data === null) return <Skeleton height={320} />

  return (
    <QueueView
      records={query.data}
      nowUnix={nowUnix}
      onAction={async (record, action) => {
        switch (action) {
          case 'diligence':
            await operator.runDiligence(auth, record.id)
            break
          case 'deploy':
            await operator.deploy(auth, record.id)
            break
          case 'pointing':
            await operator.confirmPointing(auth, record.id)
            break
          case 'acceptance':
            await operator.recordAcceptance(auth, record.id)
            break
          case 'activate':
            await operator.activate(auth, record.id)
            break
        }
        query.reload()
      }}
      onDecline={async (record, code, detail) => {
        await operator.decline(auth, record.id, code, detail)
        query.reload()
      }}
    />
  )
}

export function QueueView({
  records,
  nowUnix,
  onAction,
  onDecline,
}: {
  records: OnboardingRecordView[]
  nowUnix: number
  onAction: (record: OnboardingRecordView, action: QueueAction) => Promise<void>
  onDecline: (record: OnboardingRecordView, code: string, detail: string) => Promise<void>
}) {
  const byState = new Map<OnboardingState, OnboardingRecordView[]>()
  for (const record of records) byState.set(record.state, [...(byState.get(record.state) ?? []), record])

  const open = records.filter((record) => !TERMINAL_STATES.includes(record.state) && record.state !== 'active')

  return (
    <div className="stack-loose">
      <p className="small muted">
        {records.length} onboarding{records.length === 1 ? '' : 's'} on file, {open.length} in the
        queue. Each row offers exactly the move the service will accept from its state; anything
        else is refused by the service, and the refusal is shown as it came.
      </p>

      {ONBOARDING_STATES.map((state) => {
        const group = byState.get(state) ?? []
        if (group.length === 0) return null
        return (
          <section className="stack" key={state}>
            <div className="section-head">
              <div className="row">
                <StateBadge state={state} />
                <h2 style={{ margin: 0 }}>
                  {group.length} {state.replace(/_/g, ' ')}
                </h2>
              </div>
              {WAITING_ON[state] !== undefined && <p>{WAITING_ON[state]}</p>}
              {FORWARD[state] !== undefined && <p>{FORWARD[state].hint}</p>}
            </div>
            <div className="card">
              {group.map((record) => (
                <QueueRow key={record.id} record={record} nowUnix={nowUnix} onAction={onAction} onDecline={onDecline} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function QueueRow({
  record,
  nowUnix,
  onAction,
  onDecline,
}: {
  record: OnboardingRecordView
  nowUnix: number
  onAction: (record: OnboardingRecordView, action: QueueAction) => Promise<void>
  onDecline: (record: OnboardingRecordView, code: string, detail: string) => Promise<void>
}) {
  const action = useAction<void>()
  const [declining, setDeclining] = useState(false)
  const [code, setCode] = useState('')
  const [detail, setDetail] = useState('')
  const forward = FORWARD[record.state]
  const terminal = TERMINAL_STATES.includes(record.state)
  const last = record.history.at(-1)

  return (
    <article className="stack-tight" style={{ padding: 'var(--gap-3) 0', borderBottom: '1px solid var(--line)' }}>
      <div className="row-between">
        <div className="row">
          <strong>
            {record.subject.name} <span className="faint">({record.subject.symbol})</span>
          </strong>
          <code className="tiny mono muted">{record.id}</code>
          {record.screening !== null && record.screening.verdict !== 'CLEAR' && (
            <Badge tone={record.screening.verdict === 'BLOCKED' ? 'bad' : 'warn'} title={record.screening.flags.join(', ')}>
              screening: {record.screening.verdict}
            </Badge>
          )}
          {record.diligence !== null && !record.diligence.admitted && (
            <Badge tone="bad" title={record.diligence.blockers.join(', ')}>
              diligence: {record.diligence.retryable ? 'retry later' : 'blocked'}
            </Badge>
          )}
          {record.narrativeApproved && <Badge tone="good">narrative approved</Badge>}
        </div>
        <span className="small muted">
          updated <Timestamp unix={record.updatedAtUnix} relativeTo={nowUnix} />
        </span>
      </div>

      <div className="row tiny muted">
        <span>
          vault <AddressChip address={record.vault} />
        </span>
        <span>
          token <AddressChip address={record.token} />
        </span>
        <span>
          dev <AddressChip address={record.consent.devSigner} />
        </span>
        <span>coinRef {record.coinRef}</span>
        {last !== undefined && (
          <span>
            last <code>{last.code}</code>
            {last.detail !== null && <span className="faint"> {last.detail.slice(0, 18)}…</span>}
          </span>
        )}
        {record.declineReason !== null && (
          <span>
            declined <code>{record.declineReason}</code>
          </span>
        )}
      </div>

      {action.refusal !== null && <RefusalPanel refusal={action.refusal} />}

      <div className="row">
        {forward !== undefined && (
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={action.busy}
            onClick={() => void action.run(() => onAction(record, forward.action))}
          >
            {forward.label}
          </button>
        )}
        {record.state === 'active' && (
          <>
            <Link to={{ name: 'ops', page: 'narrative', id: record.id }} className="btn btn-small">
              Narrative
            </Link>
            <Link to={{ name: 'ops', page: 'creative', id: record.id }} className="btn btn-small">
              Creative
            </Link>
            <Link to={{ name: 'ops', page: 'accounts', id: record.id }} className="btn btn-small">
              Accounts
            </Link>
            <Link to={{ name: 'ops', page: 'purchases', id: record.vault }} className="btn btn-small">
              Purchases
            </Link>
            <Link to={{ name: 'coin', vault: record.vault }} className="btn btn-small btn-ghost">
              Public page
            </Link>
          </>
        )}
        {(record.state === 'pointed' || record.state === 'accepted') && (
          <Link to={{ name: 'ops', page: 'narrative', id: record.id }} className="btn btn-small">
            Narrative
          </Link>
        )}
        {!terminal && !declining && (
          <button type="button" className="btn btn-small btn-ghost" disabled={action.busy} onClick={() => setDeclining(true)}>
            Decline…
          </button>
        )}
      </div>

      {declining && !terminal && (
        <DeclineForm
          busy={action.busy}
          code={code}
          detail={detail}
          onCode={setCode}
          onDetail={setDetail}
          onCancel={() => setDeclining(false)}
          onSubmit={() => void action.run(() => onDecline(record, code.trim(), detail.trim()))}
        />
      )}
    </article>
  )
}

/** Exported for the rendering test: the decline form, with its refusal beside it. */
export function DeclineForm({
  busy,
  code,
  detail,
  refusal,
  onCode,
  onDetail,
  onCancel,
  onSubmit,
}: {
  busy: boolean
  code: string
  detail: string
  refusal?: Refusal | null
  onCode: (value: string) => void
  onDetail: (value: string) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  const valid = /^[a-z0-9_]{1,64}$/.test(code)
  return (
    <div className="card-flat stack-tight">
      <div className="grid-2">
        <div className="field">
          <label htmlFor={`decline-code`}>Decline code</label>
          <input
            id="decline-code"
            type="text"
            placeholder="e.g. diligence_failed"
            value={code}
            onChange={(event) => onCode(event.currentTarget.value)}
            aria-invalid={code.length > 0 && !valid}
          />
          <span className="field-hint">A machine code, lower_snake_case. It goes on the record&rsquo;s history verbatim.</span>
        </div>
        <div className="field">
          <label htmlFor="decline-detail">Detail (optional)</label>
          <input id="decline-detail" type="text" value={detail} onChange={(event) => onDetail(event.currentTarget.value)} />
        </div>
      </div>
      {refusal !== undefined && refusal !== null && <RefusalPanel refusal={refusal} />}
      <div className="row">
        <button type="button" className="btn btn-small btn-danger" disabled={busy || !valid} onClick={onSubmit}>
          Decline: the dev keeps every fee
        </button>
        <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
