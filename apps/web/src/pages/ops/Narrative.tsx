import { useState } from 'react'

import {
  PROMOTION_ELIGIBLE_STATES,
  type CreativeOutcome,
  type NarrativeCandidateView,
  type NarrativeView,
} from '../../api/operator.js'
import { useAsync } from '../../app/context.js'
import { Link } from '../../app/router.js'
import { Badge, ErrorPanel, Skeleton, Timestamp } from '../../components/primitives.js'
import { RecordPicker, RefusalPanel, StateBadge, Swatch, useAction, useOperator, type Refusal } from './common.js'

/**
 * Narrative: sources, derive, the candidate, approve.
 *
 * The candidate's tagline is the ONE piece of prose in the whole profile and
 * it is shown verbatim, in a blockquote, because the operator is approving
 * those exact words and nothing the console might tidy them into. Themes and
 * tone are closed vocabularies; the palette is two swatches with their hex,
 * because "warm blue" is not something a renderer can be held to.
 */

export function NarrativePage({ id }: { id: string | null }) {
  const { operator, auth, nowUnix } = useOperator()
  const records = useAsync(() => (id === null ? operator.listOnboardings(auth) : Promise.resolve([])), [auth.token, id])
  const narrative = useAsync(() => (id === null ? Promise.resolve(null) : operator.getNarrative(auth, id)), [auth.token, id])
  const derive = useAction<NarrativeView>()
  const approve = useAction<{ narrative: NarrativeView; creative: CreativeOutcome | null }>()

  if (id === null) {
    if (records.error !== null) return <ErrorPanel error={records.error} onRetry={records.reload} />
    if (records.data === null) return <Skeleton height={200} />
    return (
      <div className="stack">
        <p className="small muted">A narrative is derived once the coin has pointed at the vault. Pick a record.</p>
        <RecordPicker
          records={records.data}
          page="narrative"
          eligible={(record) => PROMOTION_ELIGIBLE_STATES.includes(record.state)}
          emptyNote="No onboarding has pointed at its vault yet, so there is nothing to derive a narrative for."
        />
      </div>
    )
  }

  if (narrative.error !== null) return <ErrorPanel error={narrative.error} onRetry={narrative.reload} />
  if (narrative.data === null) return <Skeleton height={320} />

  return (
    <NarrativePageView
      narrative={narrative.data}
      nowUnix={nowUnix}
      deriving={derive.busy}
      deriveRefusal={derive.refusal}
      onDerive={() => void derive.run(() => operator.deriveNarrative(auth, id)).then((r) => r !== null && narrative.reload())}
      approving={approve.busy}
      approveRefusal={approve.refusal}
      approval={approve.result}
      onApprove={(approvedBy) =>
        void approve.run(() => operator.approveNarrative(auth, id, approvedBy)).then((r) => r !== null && narrative.reload())
      }
    />
  )
}

export function NarrativePageView({
  narrative,
  nowUnix,
  deriving,
  deriveRefusal,
  onDerive,
  approving,
  approveRefusal,
  approval,
  onApprove,
}: {
  narrative: NarrativeView
  nowUnix: number
  deriving: boolean
  deriveRefusal: Refusal | null
  onDerive: () => void
  approving: boolean
  approveRefusal: Refusal | null
  approval: { narrative: NarrativeView; creative: CreativeOutcome | null } | null
  onApprove: (approvedBy: string) => void
}) {
  const [approvedBy, setApprovedBy] = useState('')
  const eligible = PROMOTION_ELIGIBLE_STATES.includes(narrative.state)
  const operatorIdValid = /^[A-Za-z0-9_.-]{1,64}$/.test(approvedBy)

  return (
    <div className="stack-loose">
      <div className="row">
        <code className="mono">{narrative.id}</code>
        <StateBadge state={narrative.state} />
        {narrative.approved !== null ? <Badge tone="good">approved</Badge> : narrative.candidate !== null ? <Badge tone="warn">candidate awaiting approval</Badge> : <Badge tone="neutral">nothing derived</Badge>}
      </div>

      <section className="stack">
        <div className="section-head">
          <div>
            <span className="eyebrow">Sources</span>
            <h2>What the dev named</h2>
          </div>
          <p>
            Fetched by code, folded and scrubbed, summarised on the reader plane with no tools. The
            URLs are dev-authored and are never shown on the public page.
          </p>
        </div>
        {narrative.sources.length === 0 ? (
          <div className="card-flat small muted">The onboarding named no narrative sources. Deriving will be refused with <code>no_narrative_sources</code>.</div>
        ) : (
          <ul className="card-flat small mono" style={{ margin: 0, paddingLeft: '1.2em' }}>
            {narrative.sources.map((url) => (
              <li key={url}>{url}</li>
            ))}
          </ul>
        )}
        {deriveRefusal !== null && <RefusalPanel refusal={deriveRefusal} title="Derive refused" />}
        <div className="row">
          <button type="button" className="btn btn-small btn-primary" disabled={deriving || !eligible} onClick={onDerive}>
            {narrative.candidate === null ? 'Derive candidate' : 'Derive again'}
          </button>
          {!eligible && <span className="tiny muted">A narrative is derived once the coin has pointed at the vault.</span>}
        </div>
      </section>

      {narrative.candidate !== null && (
        <section className="stack">
          <div className="section-head">
            <div>
              <span className="eyebrow">Candidate</span>
              <h2>What the reader derived</h2>
            </div>
            <p>Not yet anybody&rsquo;s decision. Only an approved profile reaches the planner or the renderer.</p>
          </div>
          <CandidateCard candidate={narrative.candidate} />
          {approveRefusal !== null && <RefusalPanel refusal={approveRefusal} title="Approval refused" />}
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="field" style={{ maxWidth: '20rem' }}>
              <label htmlFor="approved-by">Approved by (operator id)</label>
              <input
                id="approved-by"
                type="text"
                value={approvedBy}
                onChange={(event) => setApprovedBy(event.currentTarget.value)}
                aria-invalid={approvedBy.length > 0 && !operatorIdValid}
              />
            </div>
            <button type="button" className="btn btn-primary" disabled={approving || !operatorIdValid || !eligible} onClick={() => onApprove(approvedBy)}>
              Approve these exact words
            </button>
          </div>
        </section>
      )}

      {approval !== null && approval.creative !== null && (
        <div className={`callout callout-${approval.creative.rendered ? 'good' : 'warn'}`}>
          <div className="callout-title">{approval.creative.rendered ? 'Approved and rendered' : 'Approved; render did not happen'}</div>
          <div className="small">
            {approval.creative.rendered ? (
              <p style={{ margin: 0 }}>
                {approval.creative.assets.length} assets rendered {approval.creative.narrative ? 'from the narrative' : 'from no narrative'}.{' '}
                <Link to={{ name: 'ops', page: 'creative', id: narrative.id }}>Preview and download</Link>.
              </p>
            ) : (
              <p style={{ margin: 0 }}>
                The approval is on file. The render refused with <code>{approval.creative.error}</code>; retry it from the Creative page.
              </p>
            )}
          </div>
        </div>
      )}

      {narrative.approved !== null && (
        <section className="stack">
          <div className="section-head">
            <div>
              <span className="eyebrow">Approved profile</span>
              <h2>What the planner sees</h2>
            </div>
            <p>
              Approved by <code>{narrative.approved.approvedBy}</code>{' '}
              <Timestamp unix={narrative.approved.approvedAtUnix} relativeTo={nowUnix} />.
            </p>
          </div>
          <CandidateCard candidate={narrative.approved} />
        </section>
      )}
    </div>
  )
}

export function CandidateCard({ candidate }: { candidate: NarrativeCandidateView }) {
  return (
    <article className="card stack">
      <blockquote className="lede" style={{ margin: 0 }} data-tagline>
        {candidate.tagline}
      </blockquote>
      <div className="row">
        <span className="tiny muted">tone</span>
        <Badge tone="accent">{candidate.tone}</Badge>
        <span className="tiny muted">themes</span>
        {candidate.themes.length === 0 ? <span className="tiny faint">none</span> : candidate.themes.map((theme) => <Badge key={theme}>{theme}</Badge>)}
      </div>
      <div className="row">
        <Swatch hex={candidate.palette.primary} label="primary" />
        <Swatch hex={candidate.palette.secondary} label="secondary" />
      </div>
      <div className="tiny muted">
        {candidate.sourceHashes.length} source hash{candidate.sourceHashes.length === 1 ? '' : 'es'} on file
        {candidate.sourceHashes.length > 0 && (
          <>
            : <code className="mono">{candidate.sourceHashes.map((hash) => hash.slice(0, 12)).join(', ')}</code>
          </>
        )}
      </div>
    </article>
  )
}
