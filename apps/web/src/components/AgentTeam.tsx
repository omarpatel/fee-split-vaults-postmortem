import type { ReactNode } from 'react'

import { Link } from '../app/router.js'
import type { AgentRoleView, AgentRun, CoinAgent } from '../api/model.js'
import {
  DEGRADE_LADDER,
  airlockView,
  degradeStep,
  describeSkip,
  formatPermille,
  proposalLabel,
  provenanceNotice,
  refusalsByPhase,
  runSummary,
  spendAgainstCap,
} from '../domain/agent.js'
import { formatMicroUsd } from '../domain/money.js'
import { TIERS, type TierId } from '../protocol.js'
import { Badge, Callout, EmptyState, Figure, Timestamp } from './primitives.js'

/**
 * The agent team, as components.
 *
 * Every one of these is PURE and takes its data as props, so the page's own
 * assertions can be made against rendered markup in a Node test runner without
 * a DOM. That is not a testing convenience; it is what makes it possible to
 * assert that a dormant role's REASON is on the page rather than only that the
 * role is on the page.
 *
 * The one exception is AgentTeamCard at the bottom, which holds a Link and so
 * needs a RouterProvider around it. It still takes every fact as a prop.
 */

// ---------------------------------------------------------------------------
// Honesty
// ---------------------------------------------------------------------------

/**
 * The banner. It is the first thing on the page when anything is faked.
 *
 * Deliberately loud, deliberately not dismissible, and deliberately built from
 * the existing `.callout-warn` rather than a new component: a bespoke widget
 * for this would be a widget someone could later decide is too visually heavy.
 */
export function HonestyBanner({ agent }: { agent: CoinAgent }) {
  const notice = provenanceNotice(agent.model.provenance, agent.model.detail)
  const faked = agent.fakedDependencies
  if (!notice.banner && faked.length === 0) return null

  return (
    <div className="callout callout-warn">
      <div className="callout-title">
        {notice.banner ? notice.title : 'Some of this page is running on a stand-in'}
      </div>
      <div className="small">
        <p style={{ marginTop: 0 }}>{notice.body}</p>
        {faked.length > 0 && (
          <>
            <p style={{ marginBottom: '0.25rem' }}>
              <strong>Running on a stand-in right now:</strong>
            </p>
            <ul className="checklist" style={{ marginBottom: 0 }}>
              {faked.map((dependency) => (
                <li key={dependency}>{dependency}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The team
// ---------------------------------------------------------------------------

function RoleCard({ role }: { role: AgentRoleView }) {
  const dormant = role.activity === 'dormant'
  return (
    <div className={`role${dormant ? ' is-dormant' : ''}`}>
      <div className="role-head">
        <span className="role-title">{role.title}</span>
        <Badge tone={dormant ? 'neutral' : 'good'}>{dormant ? 'dormant' : 'active'}</Badge>
      </div>

      <p className="small muted" style={{ margin: 0 }}>
        {role.mission}
      </p>

      <div className="row tiny faint">
        <span>
          phase{role.phases.length === 1 ? '' : 's'}: <code>{role.phases.join(', ')}</code>
        </span>
        {role.readsUntrustedInput && (
          <Badge tone="warn" title="This role consumes attacker-authored text.">
            reads untrusted input
          </Badge>
        )}
      </div>

      {dormant && (
        <div className="withheld">
          <strong className="tiny mono">{role.dormantCode ?? 'dormant'}</strong>
          <p style={{ margin: '0.25rem 0 0' }}>{role.dormantReason}</p>
        </div>
      )}

      <div>
        <span className="eyebrow">May</span>
        <ul className="role-rules is-may">
          {role.may.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </div>

      <div>
        <span className="eyebrow">May not</span>
        <ul className="role-rules is-may-not">
          {role.mayNot.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export function TeamGrid({ agent }: { agent: CoinAgent }) {
  const active = agent.roles.filter((role) => role.activity === 'active').length
  return (
    <section className="stack">
      <div className="section-head">
        <div>
          <span className="eyebrow">The team</span>
          <h2>
            Six roles, {active} awake at {agent.tier}
          </h2>
        </div>
        <p>
          Every role is listed whether or not it is running. A dormant role with its reason stated
          is more useful than a role that quietly disappears, and the &ldquo;may not&rdquo; column is
          the part you are actually buying: what reads a stranger&rsquo;s message cannot spend, and
          what can spend never reads one.
        </p>
      </div>
      <div className="role-grid">
        {agent.roles.map((role) => (
          <RoleCard key={role.id} role={role} />
        ))}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// The airlock
// ---------------------------------------------------------------------------

/**
 * THE SECURITY STORY, FOR SOMEONE WHO DOES NOT READ CODE.
 *
 * Left: what the reader saw, at full fidelity, including the messages the caps
 * dropped before it ever got there. Right: everything the planner received.
 * The middle is the boundary, and the whole point is that the right column is
 * numbers and the left column is a stranger's text.
 */
export function AirlockPanel({ run }: { run: AgentRun }) {
  if (run.digest === null) {
    return (
      <section className="stack">
        <div className="section-head">
          <div>
            <span className="eyebrow">The airlock</span>
            <h2>Nothing crossed this window</h2>
          </div>
        </div>
        <EmptyState title={run.skipped === undefined ? 'No reader window ran' : describeSkip(run.skipped)}>
          The airlock only has something to show when the reader ran. A window that cost nothing is
          the normal case, not a fault.
        </EmptyState>
      </section>
    )
  }

  const view = airlockView(run.digest)
  return (
    <section className="stack">
      <div className="section-head">
        <div>
          <span className="eyebrow">The airlock</span>
          <h2>What the reader saw, and what the planner was given</h2>
        </div>
        <p>
          The half of the system that reads a stranger&rsquo;s message holds no tools and can only
          emit counts. The half that decides what to do never sees the message. This is that
          boundary, for the window below.
        </p>
      </div>

      <div className="airlock">
        <div className="airlock-side is-untrusted">
          <span className="eyebrow">Reader · untrusted side</span>
          <Figure
            label="Messages read at full fidelity"
            value={<span className="num">{view.readerSaw}</span>}
            sub={`from ${String(view.distinctAuthors)} distinct authors`}
            note={
              view.droppedByCaps > 0
                ? `${String(view.droppedByCaps)} more were dropped by deterministic caps before the reader saw them. A flood shows up as this number, not as a bigger bill.`
                : 'No message was dropped by the caps in this window.'
            }
          />
          <p className="tiny faint" style={{ marginBottom: 0 }}>
            This role holds no tools, cannot post, cannot spend, and cannot be woken by a message.
          </p>
        </div>

        <div className="airlock-seal" aria-hidden="true">
          <span>airlock</span>
        </div>

        <div className="airlock-side">
          <span className="eyebrow">Planner · trusted side</span>
          <Figure
            label="Everything it received"
            value={
              <span className="num">
                {view.counterCount} counts · {view.signalCount} signal
                {view.signalCount === 1 ? '' : 's'} · {view.gistCount} gist
                {view.gistCount === 1 ? '' : 's'}
              </span>
            }
            sub={`${String(view.gistChars)} characters of scrubbed text in total`}
            note="No address, no URL, no handle, no amount. The digest schema has no field capable of holding one."
          />
          <div className="row tiny faint">
            {view.gistsRejected > 0 && (
              <Badge tone="warn">
                {view.gistsRejected} gist{view.gistsRejected === 1 ? '' : 's'} dropped at the boundary
              </Badge>
            )}
            {view.readerRefusals > 0 && (
              <Badge tone="neutral">{view.readerRefusals} reader refusals</Badge>
            )}
          </div>
        </div>
      </div>

      <div className="card-flat">
        <span className="eyebrow">The only text that crossed</span>
        {run.digest.gists.length === 0 ? (
          <p className="small muted" style={{ marginBottom: 0 }}>
            No gist crossed in this window. The planner acted on counters alone.
          </p>
        ) : (
          <>
            {run.digest.gists.map((gist) => (
              <p className="gist" key={gist}>
                {gist}
              </p>
            ))}
            <p className="tiny faint" style={{ marginBottom: 0 }}>
              Scrubbed by trusted code before the planner saw it, and scrubbed again before it
              reached this page. Anything address-shaped, link-shaped, handle-shaped or
              amount-shaped is replaced rather than escaped.
            </p>
          </>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// This tick
// ---------------------------------------------------------------------------

function ProposalRow({ label, tone, detail }: { label: string; tone: 'good' | 'warn' | 'neutral'; detail?: ReactNode }) {
  return (
    <li style={{ marginBottom: 'var(--gap-2)' }}>
      <Badge tone={tone}>{label}</Badge>
      {detail !== undefined && <div className="tiny muted">{detail}</div>}
    </li>
  )
}

export function ThisTick({ run, nowUnix }: { run: AgentRun; nowUnix: number }) {
  const summary = runSummary(run)
  const grouped = refusalsByPhase(run)

  return (
    <section className="stack">
      <div className="section-head">
        <div>
          <span className="eyebrow">This tick</span>
          <h2>What the team did at its last window</h2>
        </div>
        <p>
          <Timestamp unix={run.atUnix} relativeTo={nowUnix} />, on the fixed 30-minute schedule. A
          tick that proposed nothing is a result, not a gap.
        </p>
      </div>

      <div className="figure-grid">
        <Figure
          label="Proposed"
          value={<span className="num">{summary.proposed}</span>}
          note={summary.deliberatelyQuiet ? 'The planner ran and chose to do nothing.' : undefined}
        />
        <Figure
          label="Suppressed"
          value={<span className="num">{summary.suppressed}</span>}
          note="Proposals a freeze removed. Kept so you can see what was stopped."
        />
        <Figure
          label="Refused"
          value={<span className="num">{summary.refused}</span>}
          note="Phases that declined to act on an input they did not have."
        />
        <Figure
          label="Inference cost"
          value={<span className="num">{summary.cost}</span>}
          isSource
          note="This window only. Charged against the coin's budget before any procurement."
        />
      </div>

      {run.freeze !== undefined && (
        <Callout tone="warn" title={`Divergence freeze: ${run.freeze.level}`}>
          {run.freeze.reason}
        </Callout>
      )}

      {run.skipped !== undefined && (
        <Callout tone="info" title="No model was called in this window">
          {describeSkip(run.skipped)}
        </Callout>
      )}

      <div className="grid-2">
        <div className="card">
          <span className="eyebrow">Proposals</span>
          {run.proposals.length === 0 ? (
            <p className="small muted">Nothing was proposed.</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 'var(--gap-2) 0 0' }}>
              {run.proposals.map((proposal, index) => (
                <ProposalRow
                  key={`${proposal.kind}-${String(index)}`}
                  tone={proposal.kind === 'no_action' ? 'neutral' : 'good'}
                  label={proposalLabel(proposal)}
                  detail={
                    proposal.kind === 'post'
                      ? `${String(proposal.bodyChars)} characters of copy, ${String(proposal.linkRefCount)} allowlisted link id${proposal.linkRefCount === 1 ? '' : 's'}. The copy itself is on the receipts ledger, with its permalink.`
                      : proposal.kind === 'purchase'
                        ? proposal.rationale
                        : proposal.kind === 'escalation'
                          ? proposal.note
                          : proposal.reason
                  }
                />
              ))}
            </ul>
          )}

          {run.violations.length > 0 && (
            <div className="withheld" style={{ marginTop: 'var(--gap-3)' }}>
              <strong className="tiny">Rejected tool calls</strong>
              {run.violations.map((violation) => (
                <p className="tiny" key={`${violation.toolName}:${violation.field}`} style={{ margin: '0.25rem 0 0' }}>
                  <code>
                    {violation.toolName}.{violation.field}
                  </code>{' '}
                  {violation.message}
                </p>
              ))}
              <p className="tiny" style={{ marginBottom: 0 }}>
                Never repaired and never partially accepted. A malformed proposal is discarded whole.
              </p>
            </div>
          )}
        </div>

        <div className="card">
          <span className="eyebrow">Suppressed and refused</span>
          {summary.suppressed === 0 && summary.refused === 0 ? (
            <p className="small muted">Nothing was suppressed and no phase refused.</p>
          ) : (
            <>
              {run.suppressed.map((entry, index) => (
                <div className="receipt" key={`s-${String(index)}`}>
                  <Badge tone="warn">{proposalLabel(entry.proposal)}</Badge>
                  <p className="tiny muted" style={{ margin: '0.35rem 0 0' }}>
                    {entry.reason}
                  </p>
                </div>
              ))}
              {grouped.map((group) => (
                <div className="receipt" key={group.phase}>
                  <strong className="small">{group.phase}</strong>
                  {group.codes.map((refusal) => (
                    <p className="tiny muted" key={refusal.code} style={{ margin: '0.25rem 0 0' }}>
                      <code>{refusal.code}</code> — {refusal.detail}
                    </p>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {(run.publishes.length > 0 || run.spends.length > 0) && (
        <div className="grid-2">
          {run.publishes.length > 0 && (
            <div className="card-flat">
              <span className="eyebrow">Published</span>
              {run.publishes.map((attempt, index) => (
                <p className="small" key={`p-${String(index)}`} style={{ marginBottom: '0.25rem' }}>
                  <Badge tone={attempt.published ? 'good' : 'bad'}>
                    {attempt.published ? 'sent' : 'refused'}
                  </Badge>{' '}
                  {attempt.channel} · {attempt.intent}
                  {attempt.rejectedReason !== undefined && (
                    <span className="tiny muted"> — {attempt.rejectedReason}</span>
                  )}
                </p>
              ))}
            </div>
          )}
          {run.spends.length > 0 && (
            <div className="card-flat">
              <span className="eyebrow">Spend gate</span>
              {run.spends.map((spend, index) => (
                <p className="small" key={`sp-${String(index)}`} style={{ marginBottom: '0.25rem' }}>
                  <Badge tone={spend.approved ? 'good' : 'bad'}>{spend.status}</Badge>{' '}
                  {spend.skuId ?? 'unknown sku'}
                  <span className="tiny muted">
                    {' '}
                    — <code>{spend.code}</code> {spend.detail}
                  </span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------

export function SpendPanel({ agent }: { agent: CoinAgent }) {
  const step = degradeStep(agent.spend.degradeLevel)
  const tier = TIERS[agent.tier]
  /**
   * A deterministic tier has no inference budget, however the arithmetic falls.
   *
   * The governor still derives a ceiling from the tier's COGS - a fraction of a
   * cent, at T0 - and rendering that as a budget would say this coin MAY call a
   * model and has chosen not to. It may not, at any volume. So the cap is
   * suppressed on the tier fact rather than on the figure being zero, which it
   * is not.
   */
  const against = tier.usesModel
    ? spendAgainstCap(agent.spend.todayMicroUsd, agent.spend.dailyCapMicroUsd)
    : null

  return (
    <section className="stack">
      <div className="section-head">
        <div>
          <span className="eyebrow">Spend</span>
          <h2>What the team cost this coin today</h2>
        </div>
        <p>
          {against === null ? (
            <>
              No model runs for this coin at {agent.tier}, so nothing is charged to its procurement
              budget for inference. The ladder below is shown anyway, because it is what would
              govern the spend if this coin qualified for a tier that uses one.
            </>
          ) : (
            <>
              Model spend is charged to this coin&rsquo;s procurement budget FIRST, before any
              third-party media. The cap below is per coin and per UTC day, and it is never
              exceeded: the team degrades instead.
            </>
          )}
        </p>
      </div>

      <div className="figure-grid">
        <Figure
          label={`Inference today (${agent.spend.dayKey} UTC)`}
          value={<span className="num">{formatMicroUsd(agent.spend.todayMicroUsd)}</span>}
          isSource
          sub={`${String(agent.spend.callsToday)} metered model call${agent.spend.callsToday === 1 ? '' : 's'}`}
        />
        <Figure
          label="Daily model cap for this coin"
          value={
            <span className="num">
              {against === null ? 'none' : formatMicroUsd(agent.spend.dailyCapMicroUsd)}
            </span>
          }
          note={
            against === null
              ? `${agent.tier} (${tier.name}) is deterministic by design: no model is in the loop at this tier, at any volume, so there is no inference budget to spend against.`
              : `${formatPermille(against.permille)} of it used so far today.`
          }
        />
        <Figure
          label={`All-in cost to serve at ${agent.tier}`}
          value={<span className="num">{formatMicroUsd(agent.spend.tierCogsPerDayMicroUsd)}</span>}
          note={`The modelled daily cost of the whole ${tier.name} tier, of which inference is one part. Not a cap.`}
        />
      </div>

      {against !== null && (
        <div>
          <div className="band-rail" aria-hidden="true">
            {Array.from({ length: 20 }, (_, i) => (
              <span
                key={i}
                className={`band-tick${i * 5 < against.barPercent ? ' is-active' : ''}`}
              />
            ))}
          </div>
          <p className="tiny faint" style={{ marginTop: '0.35rem' }}>
            {against.spent} of {against.cap}
            {against.overCap && ' — over cap, which should be impossible; treat it as a defect.'}
          </p>
        </div>
      )}

      <div className="card-flat">
        <div className="row-between">
          <span className="eyebrow">Degrade ladder</span>
          <Badge tone={step.tone === 'neutral' ? 'neutral' : step.tone}>{step.label}</Badge>
        </div>
        <ol className="steps">
          {DEGRADE_LADDER.map((rung) => (
            <li key={rung.level} data-state={rung.level === agent.spend.degradeLevel ? 'done' : 'todo'}>
              <strong className="small">{rung.label}</strong>
              <div className="tiny muted">{rung.meaning}</div>
            </li>
          ))}
        </ol>
        <p className="tiny faint" style={{ marginBottom: 0 }}>
          Degrade, never overspend. The bottom rung is deterministic operation, not an outage: a
          coin that has burned its day still gets its indexer, its ledger and its receipts.
        </p>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export function RunHistory({ runs, nowUnix }: { runs: AgentRun[]; nowUnix: number }) {
  if (runs.length === 0) {
    return (
      <EmptyState title="This coin has not ticked yet">
        Nothing has run for it, which is different from having run and done nothing. When the first
        window closes it will appear here with its counters, its proposals and its refusals.
      </EmptyState>
    )
  }

  return (
    <section className="stack">
      <div className="section-head">
        <div>
          <span className="eyebrow">History</span>
          <h2>Every window, including the quiet ones</h2>
        </div>
        <p>
          Newest first. A window with no messages costs nothing and is recorded anyway, because the
          absence of a call is the thing a fixed schedule is supposed to produce.
        </p>
      </div>

      <div className="run-meter" aria-hidden="true">
        {[...runs].reverse().map((run) => (
          <span
            key={run.id}
            className={`run-tick ${run.freeze !== undefined ? 'is-frozen' : run.ranCognition ? 'is-ran' : 'is-quiet'}`}
          />
        ))}
      </div>

      <div className="card">
        {runs.map((run) => {
          const summary = runSummary(run)
          return (
            <div className="run" key={run.id}>
              <div className="row-between">
                <div className="row">
                  <strong className="small">
                    <Timestamp unix={run.atUnix} relativeTo={nowUnix} />
                  </strong>
                  {run.ranChainPoll && <Badge tone="neutral">chain poll</Badge>}
                  {run.ranCognition ? (
                    <Badge tone="accent">reader + planner</Badge>
                  ) : (
                    <Badge tone="neutral">{describeSkip(run.skipped ?? 'no window')}</Badge>
                  )}
                  {run.freeze !== undefined && <Badge tone="warn">freeze: {run.freeze.level}</Badge>}
                  {run.modelProvenance !== 'live' && (
                    <Badge tone="warn" title="Not produced by a model.">
                      {run.modelProvenance}
                    </Badge>
                  )}
                </div>
                <span className="num small">{summary.cost}</span>
              </div>

              <div className="row tiny muted" style={{ marginTop: '0.35rem' }}>
                {run.digest !== null && (
                  <span>
                    read {run.digest.admittedMessageCount}
                    {run.digest.droppedMessageCount > 0 &&
                      ` (+${String(run.digest.droppedMessageCount)} capped)`}
                  </span>
                )}
                <span>proposed {summary.proposed}</span>
                {summary.suppressed > 0 && <span>suppressed {summary.suppressed}</span>}
                {summary.refused > 0 && <span>refused {summary.refused}</span>}
                {summary.published > 0 && <span>published {summary.published}</span>}
                {summary.spendRefused > 0 && <span>spend refused {summary.spendRefused}</span>}
              </div>

              {run.refusals.length > 0 && (
                <p className="tiny faint" style={{ margin: '0.35rem 0 0' }}>
                  {run.refusals.map((refusal) => `${refusal.phase}: ${refusal.code}`).join(' · ')}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// The pointer, from the receipts page
// ---------------------------------------------------------------------------

/**
 * The card that sends a reader of the receipts page to the team page.
 *
 * IT DELIBERATELY MAKES NO CLAIM ABOUT WHICH ROLES ARE AWAKE. Activation is a
 * server-side decision - it reads the vault state, the screening verdict, the
 * standing freeze and the degrade level - and a card that recomputed it here
 * from the two or three facts the coin page happens to hold would be a second
 * implementation of the same rule, free to disagree with the first. The two
 * badges below are TIER FACTS, read from config/protocol.ts, which is the one
 * table both sides already share.
 *
 * It also fetches nothing. The agent routes are gated by the operator token and
 * the coin page is a public artifact; adding a call here would either leak that
 * gate or render a 401 on a page that is otherwise readable by anyone.
 */
export function AgentTeamCard({ vault, tier }: { vault: string; tier: TierId }) {
  const spec = TIERS[tier]
  return (
    <section className="card stack">
      <div className="row-between">
        <div>
          <span className="eyebrow">The team</span>
          <h2 style={{ margin: '0.15rem 0 0' }}>Six roles work this coin</h2>
        </div>
        <div className="row">
          <Badge tone="accent">
            {tier} · {spec.name}
          </Badge>
          <Badge tone={spec.usesModel ? 'good' : 'neutral'}>
            {spec.usesModel ? 'model in the loop' : 'deterministic, no model'}
          </Badge>
          <Badge tone={spec.paidMedia ? 'good' : 'neutral'}>
            {spec.paidMedia ? 'buys third-party media' : 'buys no media'}
          </Badge>
        </div>
      </div>

      <p className="small muted" style={{ margin: 0 }}>
        This page shows what was <strong>bought</strong> for this coin. The team page shows what was{' '}
        <strong>decided</strong>: which of the six roles is awake at {tier} and which is dormant with
        the reason stated, what the reader saw against what the planner was allowed to receive,
        every proposal that was suppressed and every phase that refused, and what the models cost
        this coin today against its cap.
      </p>

      <div className="row">
        <Link to={{ name: 'agent', vault }} className="btn">
          See the team and its refusals
        </Link>
        <span className="tiny faint">
          Read-only. Nothing on it can be actioned, by you or by us.
        </span>
      </div>
    </section>
  )
}
