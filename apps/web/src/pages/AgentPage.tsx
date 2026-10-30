import { useApp, useAsync } from '../app/context.js'
import { Link } from '../app/router.js'
import {
  AirlockPanel,
  HonestyBanner,
  RunHistory,
  SpendPanel,
  TeamGrid,
  ThisTick,
} from '../components/AgentTeam.js'
import { AddressChip, Badge, ErrorPanel, Skeleton, Timestamp } from '../components/primitives.js'
import type { AgentRun, CoinAgent } from '../api/model.js'
import { TIERS } from '../protocol.js'

/**
 * THE COIN'S AGENT TEAM.
 *
 * The product's central claim is that a coin has a team working for it and that
 * every action is receipted. The receipts ledger already showed what was
 * BOUGHT. This page shows what was DECIDED - including, and mostly, what was
 * refused - because on a disclosed desk the refusals are the thing being sold.
 *
 * The ordering is deliberate and it is not the flattering one. The honesty
 * banner is first, before any figure, so nobody can read a number here without
 * first knowing whether a model produced it. Then the team, then the last tick,
 * then the airlock, then the money, then the history. A reader who stops after
 * the first screen has still learned the two things that matter: who is awake,
 * and whether any of this is real.
 *
 * THE SPLIT BELOW IS NOT DECORATION. `AgentPage` is the only part that fetches;
 * `AgentPageView` takes resolved data and renders. That is what lets the route
 * itself - not a hand-assembled subset of its sections - be rendered to markup
 * in a Node test runner and asserted against, with no DOM and no network. A
 * page whose only proof of correctness is a screenshot has no proof.
 */

export function AgentPage({ vault }: { vault: string }) {
  const { client, env } = useApp()
  const nowUnix = Math.floor(Date.now() / 1_000)

  const agentQuery = useAsync(() => client.getCoinAgent(vault), [vault])
  const runsQuery = useAsync(() => client.listAgentRuns(vault), [vault])

  if (agentQuery.error !== null) {
    return (
      <div className="page stack" style={{ paddingTop: 'var(--gap-4)' }}>
        <ErrorPanel error={agentQuery.error} onRetry={agentQuery.reload} />
        <p className="small muted">
          This page refuses rather than rendering an idle team. A coin whose agents look asleep and
          a coin we cannot reach are different facts, and only one of them is worth acting on.
        </p>
        <Link to={{ name: 'coin', vault }} className="btn">
          Back to the coin page
        </Link>
      </div>
    )
  }

  const agent = agentQuery.data
  if (agent === null) {
    return (
      <div className="page stack" style={{ paddingTop: 'var(--gap-4)' }}>
        <Skeleton height={40} width="45%" />
        <Skeleton height={110} />
        <Skeleton height={260} />
        <Skeleton height={180} />
      </div>
    )
  }

  return (
    <AgentPageView
      agent={agent}
      runs={runsQuery.data?.runs ?? null}
      runsError={runsQuery.error}
      onRetryRuns={runsQuery.reload}
      nowUnix={nowUnix}
      isDemo={env.isDemo}
    />
  )
}

/**
 * The page, given its data. Pure, and every branch is reachable from props.
 *
 * `runs === null` is LOADING, not empty. The distinction is load-bearing: an
 * empty list means this coin has never ticked, and rendering that claim while
 * the request is still in flight would be asserting something we do not know.
 */
export function AgentPageView({
  agent,
  runs,
  runsError,
  onRetryRuns,
  nowUnix,
  isDemo,
}: {
  agent: CoinAgent
  runs: AgentRun[] | null
  runsError: string | null
  onRetryRuns?: () => void
  nowUnix: number
  isDemo: boolean
}) {
  return (
    <div className="page stack-loose" style={{ paddingTop: 'var(--gap-4)' }}>
      <AgentHeader agent={agent} nowUnix={nowUnix} isDemo={isDemo} />

      {/* First, always. Nobody should read a figure below without this. */}
      <HonestyBanner agent={agent} />

      <TeamGrid agent={agent} />

      {runsError !== null ? (
        <ErrorPanel error={runsError} {...(onRetryRuns === undefined ? {} : { onRetry: onRetryRuns })} />
      ) : runs === null ? (
        <>
          <Skeleton height={200} />
          <Skeleton height={160} />
        </>
      ) : (
        <AgentRunSections runs={runs} nowUnix={nowUnix} />
      )}

      <SpendPanel agent={agent} />

      <footer className="small muted">
        Everything above is the operator&rsquo;s own record of its own machinery. It is published
        for the same reason the receipts are:{' '}
        <Link to={{ name: 'coin', vault: agent.vault }}>the coin&rsquo;s receipts page</Link> shows
        what was bought and whether it was delivered; this page shows what was decided and what was
        refused. Neither is worth much without the other.
      </footer>
    </div>
  )
}

/** Split out so the two run-derived sections share one null check. */
function AgentRunSections({ runs, nowUnix }: { runs: AgentRun[]; nowUnix: number }) {
  const latest = runs[0]
  if (latest === undefined) {
    return <RunHistory runs={runs} nowUnix={nowUnix} />
  }
  return (
    <>
      <ThisTick run={latest} nowUnix={nowUnix} />
      <AirlockPanel run={latest} />
      <RunHistory runs={runs} nowUnix={nowUnix} />
    </>
  )
}

function AgentHeader({
  agent,
  nowUnix,
  isDemo,
}: {
  agent: CoinAgent
  nowUnix: number
  isDemo: boolean
}) {
  const tier = TIERS[agent.tier]
  const active = agent.roles.filter((role) => role.activity === 'active').length

  return (
    <header className="stack">
      <div className="row-between">
        <div>
          <span className="eyebrow">Member coin · agent team</span>
          <h1>The team working for this coin</h1>
        </div>
        <div className="row">
          <Badge tone="accent">
            {agent.tier} · {tier.name}
          </Badge>
          <Badge tone={agent.vaultState === 'ACTIVE' ? 'good' : 'warn'}>{agent.vaultState}</Badge>
          {agent.halted && <Badge tone="bad">indexer halt</Badge>}
          {agent.freeze !== 'none' && <Badge tone="warn">freeze: {agent.freeze}</Badge>}
          {isDemo && <Badge tone="warn">demo data</Badge>}
        </div>
      </div>

      <p className="lede">
        {active} of {agent.roles.length} roles are awake at this tier. The rest are listed below with
        the reason they are not, because &ldquo;we do not do that at this tier&rdquo; and &ldquo;that
        broke&rdquo; are different answers and you should be able to tell which one you are getting.
      </p>

      <div className="row small muted">
        <span>
          vault <AddressChip address={agent.vault} />
        </span>
        <span>
          last tick{' '}
          {agent.lastTickAtUnix === null ? (
            // Never 0, never "just now". A coin that has not ticked has not ticked.
            <strong>never</strong>
          ) : (
            <Timestamp unix={agent.lastTickAtUnix} relativeTo={nowUnix} />
          )}
        </span>
        <span>
          next due{' '}
          {agent.nextDueUnix === null ? (
            <strong>not scheduled</strong>
          ) : (
            <Timestamp unix={agent.nextDueUnix} relativeTo={nowUnix} />
          )}
        </span>
        {/*
          A tier with no model in the loop gets told so, rather than being given
          two model ids it will never call. Naming a planner model for a
          deterministic tier reads as a claim that one runs.
        */}
        {tier.usesModel ? (
          <>
            <span>
              reader <code>{agent.model.readerModel}</code>
            </span>
            <span>
              planner <code>{agent.model.plannerModel}</code>
            </span>
          </>
        ) : (
          <span>
            <strong>no model in the loop at this tier</strong>
          </span>
        )}
        {agent.model.viaBatch && (
          <Badge tone="neutral" title="Non-urgent calls are routed through the Batch API.">
            batched
          </Badge>
        )}
        {agent.screeningVerdict === null ? (
          <Badge tone="warn" title="Absence of a screening is not a pass.">
            no screening on file
          </Badge>
        ) : (
          agent.screeningVerdict !== 'CLEAR' && (
            <Badge tone="warn">screening: {agent.screeningVerdict}</Badge>
          )
        )}
      </div>
    </header>
  )
}
