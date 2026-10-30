import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { RouterProvider } from '../../app/router.js'
import { FixtureApiClient } from '../../api/fixtures/client.js'
import type * as M from '../../api/model.js'
import { AgentTeamCard } from '../../components/AgentTeam.js'
import { TIERS, type TierId } from '../../protocol.js'
import { AgentPageView } from '../AgentPage.js'

/**
 * THE ROUTE, RENDERED.
 *
 * Every assertion below is made against the markup the real /:vault/agent route
 * produces, from the real fixture backend, through the real components. Nothing
 * is stubbed and no subset is hand-assembled: `AgentPageView` is exactly what
 * `AgentPage` renders once its two requests resolve.
 *
 * What is being defended is not layout. It is that the page cannot be read as
 * making a claim it is not entitled to make - that a dormant role never
 * silently disappears, that a scripted stand-in is announced before any figure,
 * that a tier which cannot call a model is not shown a model budget, and that
 * a proposal the system suppressed is still on the page with its reason.
 */

const NOW = 1_780_000_000

function api(): FixtureApiClient {
  return new FixtureApiClient({ now: () => NOW })
}

interface Loaded {
  agent: M.CoinAgent
  runs: M.AgentRun[]
}

/** Every fixture coin, keyed by tier, with its runs. */
async function loadByTier(): Promise<Map<TierId, Loaded>> {
  const client = api()
  const byTier = new Map<TierId, Loaded>()
  for (const summary of await client.listCoins()) {
    const agent = await client.getCoinAgent(summary.vault)
    if (byTier.has(agent.tier)) continue
    const { runs } = await client.listAgentRuns(summary.vault)
    byTier.set(agent.tier, { agent, runs })
  }
  return byTier
}

/** The route as the browser gets it, minus the browser. */
function render(props: {
  agent: M.CoinAgent
  runs: M.AgentRun[] | null
  runsError?: string | null
  isDemo?: boolean
}): string {
  return renderToStaticMarkup(
    <RouterProvider>
      <AgentPageView
        agent={props.agent}
        runs={props.runs}
        runsError={props.runsError ?? null}
        nowUnix={NOW}
        isDemo={props.isDemo ?? true}
      />
    </RouterProvider>,
  )
}

/**
 * Strip tags and decode entities, so a phrase split across elements still
 * matches as prose. React escapes apostrophes to &#x27; in text nodes, and
 * half the copy on this page is written in the first person about a coin.
 */
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
}

describe('the agent route renders the whole team', () => {
  it('shows all six roles, and a dormant one is rendered rather than hidden', async () => {
    for (const [tier, { agent, runs }] of await loadByTier()) {
      const body = text(render({ agent, runs }))
      for (const role of agent.roles) {
        expect(body, `${tier} is missing ${role.id}`).toContain(role.title)
        if (role.activity === 'dormant') {
          // The code AND the sentence. A dormant role whose reason is not on the
          // page is worse than useless: it reads as a role that broke.
          expect(body, `${tier} ${role.id} code`).toContain(role.dormantCode)
          expect(body, `${tier} ${role.id} reason`).toContain(role.dormantReason)
        }
      }
    }
  })

  it('puts every "may not" on the page, because the refusals are the product', async () => {
    const { agent, runs } = (await loadByTier()).get('T3')!
    const body = text(render({ agent, runs }))
    for (const role of agent.roles) {
      for (const rule of role.mayNot) {
        expect(body, `${role.id}: ${rule}`).toContain(rule)
      }
    }
  })

  it('counts the awake roles in the header rather than leaving it to be counted', async () => {
    const { agent, runs } = (await loadByTier()).get('T2')!
    const awake = agent.roles.filter((role) => role.activity === 'active').length
    expect(text(render({ agent, runs }))).toContain(`${awake} of 6 roles are awake`)
  })
})

describe('the honesty banner', () => {
  it('is the first thing on the page, before any figure', async () => {
    const { agent, runs } = (await loadByTier()).get('T3')!
    const body = text(render({ agent, runs }))

    const banner = body.indexOf('scripted stand-in')
    expect(banner, 'no stand-in notice on a page running on a fake model').toBeGreaterThan(-1)

    // Nobody should be able to read a dollar figure here without having passed
    // the notice that says a script produced it.
    const firstDollar = body.indexOf('$')
    expect(firstDollar).toBeGreaterThan(-1)
    expect(banner).toBeLessThan(firstDollar)
  })

  it('says a stand-in is not a model, and names every faked dependency', async () => {
    const { agent, runs } = (await loadByTier()).get('T3')!
    const body = text(render({ agent, runs }))
    expect(agent.model.provenance).toBe('fake')
    expect(body).toContain('This is not a model. It is a scripted stand-in.')
    for (const dependency of agent.fakedDependencies) {
      expect(body, dependency).toContain(dependency)
    }
  })

  it('disappears only when the client is live and nothing is faked', async () => {
    const { agent, runs } = (await loadByTier()).get('T3')!
    const live: M.CoinAgent = {
      ...agent,
      model: { ...agent.model, provenance: 'live', detail: 'resolved against a real credential.' },
      fakedDependencies: [],
    }
    const body = text(render({ agent: live, runs, isDemo: false }))
    expect(body).not.toContain('scripted stand-in')
    expect(body).not.toContain('Running on a stand-in right now')
    expect(body).not.toContain('Some of this page is running on a stand-in')

    // A warn callout may still be on the page for a standing divergence freeze,
    // which is a fact about this coin rather than about our own plumbing. The
    // two are different claims and only the second one is being cleared here.
    for (const dependency of agent.fakedDependencies) {
      expect(body, dependency).not.toContain(dependency)
    }
  })

  it('still banners when the client cannot be confirmed either way', async () => {
    const { agent, runs } = (await loadByTier()).get('T3')!
    const unsure: M.CoinAgent = {
      ...agent,
      model: { ...agent.model, provenance: 'unknown', detail: 'no call has resolved yet.' },
      fakedDependencies: [],
    }
    const body = text(render({ agent: unsure, runs }))
    expect(body).toContain('We cannot confirm which client produced this')
    expect(body).toContain('unattributed')
  })
})

describe('the airlock, made legible', () => {
  it('shows what the reader saw against what the planner was given', async () => {
    const { agent, runs } = (await loadByTier()).get('T3')!
    const latest = runs[0]!
    const digest = latest.digest!
    const body = text(render({ agent, runs }))

    expect(body).toContain('What the reader saw, and what the planner was given')
    expect(body).toContain('Messages read at full fidelity')
    expect(body).toContain(String(digest.admittedMessageCount))
    expect(body).toContain(`from ${digest.distinctAuthorCount} distinct authors`)

    // The claim a non-engineer is meant to take away.
    expect(body).toContain('No address, no URL, no handle, no amount')
    expect(body).toContain('holds no tools')
  })

  it('shows the gists as the only text that crossed, and shows all of them', async () => {
    const { agent, runs } = (await loadByTier()).get('T3')!
    const body = text(render({ agent, runs }))
    expect(body).toContain('The only text that crossed')
    for (const gist of runs[0]!.digest!.gists) expect(body).toContain(gist)
  })

  it('reports a flood as messages the caps dropped, not as a bigger bill', async () => {
    const client = api()
    const summaries = await client.listCoins()
    let asserted = false
    for (const summary of summaries) {
      const agent = await client.getCoinAgent(summary.vault)
      const { runs } = await client.listAgentRuns(summary.vault)
      const flooded = runs.find((run) => (run.digest?.droppedMessageCount ?? 0) > 100)
      if (flooded === undefined) continue
      const body = text(render({ agent, runs: [flooded, ...runs.filter((r) => r !== flooded)] }))
      expect(body).toContain(`${flooded.digest!.droppedMessageCount} more were dropped`)
      expect(body).toContain('not as a bigger bill')
      asserted = true
      break
    }
    expect(asserted, 'no flooded window in the demo data').toBe(true)
  })
})

describe('this tick', () => {
  it('shows a suppressed proposal WITH its reason, rather than dropping it', async () => {
    const client = api()
    let asserted = false
    for (const summary of await client.listCoins()) {
      const agent = await client.getCoinAgent(summary.vault)
      const { runs } = await client.listAgentRuns(summary.vault)
      if (runs[0]?.suppressed.length === 0) continue

      const body = text(render({ agent, runs }))
      for (const entry of runs[0]!.suppressed) {
        // What was stopped...
        expect(body).toContain(entry.proposal.kind === 'purchase' ? entry.proposal.skuId : '')
        // ...and why. The reason is the informative half.
        expect(body).toContain(entry.reason)
      }
      expect(body).toContain('Suppressed')
      asserted = true
      break
    }
    expect(asserted, 'no coin shows a suppression on its latest tick').toBe(true)
  })

  it('groups refusals by the phase that refused', async () => {
    const withRefusal: M.AgentRun = {
      ...(await loadByTier()).get('T3')!.runs[0]!,
      refusals: [
        { phase: 'spend', code: 'rolling_cap', detail: 'the rolling window cap was already met' },
        { phase: 'publish', code: 'no_account_for_channel', detail: 'nothing is bound to x' },
      ],
    }
    const { agent } = (await loadByTier()).get('T3')!
    const body = text(render({ agent, runs: [withRefusal] }))

    expect(body).toContain('rolling_cap')
    expect(body).toContain('the rolling window cap was already met')
    expect(body).toContain('no_account_for_channel')
    expect(body).toContain('spend')
    expect(body).toContain('publish')
  })

  it('reads a tick that ran and chose nothing as a result, not as a gap', async () => {
    const { agent, runs } = (await loadByTier()).get('T2')!
    const quiet: M.AgentRun = {
      ...runs[0]!,
      proposals: [{ kind: 'no_action', reason: 'nothing worth saying this window' }],
      suppressed: [],
      publishes: [],
    }
    const body = text(render({ agent, runs: [quiet] }))
    expect(body).toContain('The planner ran and chose to do nothing.')
    expect(body).toContain('A tick that proposed nothing is a result, not a gap.')
  })

  it('never puts a post body on the page, only its length', async () => {
    const { agent, runs } = (await loadByTier()).get('T3')!
    const post = runs
      .flatMap((run) => run.proposals)
      .find((proposal) => proposal.kind === 'post')
    expect(post, 'no post proposal in the demo data').toBeDefined()
    const body = text(render({ agent, runs }))
    expect(body).toContain(`${post!.kind === 'post' ? post!.bodyChars : 0} characters of copy`)
  })
})

describe('spend against the cap', () => {
  it('shows the day, the cap and where on the degrade ladder the team is', async () => {
    const { agent, runs } = (await loadByTier()).get('T3')!
    const body = text(render({ agent, runs }))

    expect(body).toContain(`Inference today (${agent.spend.dayKey} UTC)`)
    expect(body).toContain('Daily model cap for this coin')
    expect(body).toContain(
      `${agent.spend.callsToday} metered model call${agent.spend.callsToday === 1 ? '' : 's'}`,
    )
    // The ladder is shown whole, so the bottom rung reads as deterministic
    // operation rather than as an outage waiting to happen.
    for (const rung of ['Full', 'Batched', 'Downgraded', 'Suspended']) {
      expect(body).toContain(rung)
    }
    expect(body).toContain('Degrade, never overspend.')
  })

  it('refuses to show a model budget at a tier that never calls a model', async () => {
    // The T0 governor still derives a ceiling of a fraction of a cent from the
    // tier's COGS. Rendering that as a budget would say this coin MAY call a
    // model and chose not to. It may not, at any volume.
    const { agent, runs } = (await loadByTier()).get('T0')!
    expect(TIERS.T0.usesModel).toBe(false)
    expect(agent.spend.dailyCapMicroUsd).toBeGreaterThan(0n)

    const body = text(render({ agent, runs }))
    expect(body).toContain('no model is in the loop at this tier, at any volume')
    expect(body).toContain('there is no inference budget to spend against')
    // No utilisation bar, because there is no budget for it to be a share of.
    expect(body).not.toContain('used so far today')
    // ...and the section does not promise a cap it then declines to show.
    expect(body).toContain('No model runs for this coin at T0')
    expect(body).not.toContain('The cap below is per coin and per UTC day')
  })

  it('tells a T0 reader in the header that no model runs, instead of naming one', async () => {
    const { agent, runs } = (await loadByTier()).get('T0')!
    const body = text(render({ agent, runs }))
    expect(body).toContain('no model in the loop at this tier')
    expect(body).not.toContain('claude-sonnet-5')
  })
})

describe('loading, error and empty states', () => {
  it('renders skeletons while the runs are in flight and asserts nothing about them', async () => {
    const { agent } = (await loadByTier()).get('T2')!
    const html = render({ agent, runs: null })
    expect(html).toContain('skeleton')
    // Loading is NOT empty: it must not claim the coin has never ticked.
    expect(text(html)).not.toContain('This coin has not ticked yet')
    expect(text(html)).not.toContain('What the team did at its last window')
  })

  it('shows an error panel rather than a plausible number when the runs fail', async () => {
    const { agent } = (await loadByTier()).get('T2')!
    const body = text(render({ agent, runs: null, runsError: 'agent_not_wired: no fleet handle' }))
    expect(body).toContain('Could not load this')
    expect(body).toContain('agent_not_wired: no fleet handle')
    expect(body).toContain('It shows an error rather than a plausible number')
  })

  it('distinguishes a coin that has never ticked from a coin that ticked quietly', async () => {
    const { agent } = (await loadByTier()).get('T2')!
    const body = text(render({ agent, runs: [] }))
    expect(body).toContain('This coin has not ticked yet')
    expect(body).toContain('which is different from having run and done nothing')
  })

  it('renders a never-ticked coin as never, not as the epoch and not as now', async () => {
    const { agent } = (await loadByTier()).get('T2')!
    const fresh: M.CoinAgent = { ...agent, lastTickAtUnix: null, nextDueUnix: null }
    const body = text(render({ agent: fresh, runs: [] }))
    expect(body).toContain('last tick never')
    expect(body).toContain('next due not scheduled')
    expect(body).not.toContain('1970')
  })

  it('says so when no screening is on file, rather than reading absence as a pass', async () => {
    const { agent, runs } = (await loadByTier()).get('T2')!
    const unscreened: M.CoinAgent = { ...agent, screeningVerdict: null }
    expect(text(render({ agent: unscreened, runs }))).toContain('no screening on file')
  })
})

describe('the card on the coin page', () => {
  it('links to the team page for that exact vault', () => {
    const vault = '0x1111111111111111111111111111111111111111'
    const html = renderToStaticMarkup(
      <RouterProvider>
        <AgentTeamCard vault={vault} tier="T2" />
      </RouterProvider>,
    )
    expect(html).toContain(`href="/${vault}/agent"`)
    expect(text(html)).toContain('See the team and its refusals')
  })

  it('states the tier posture from the protocol table rather than guessing at roles', () => {
    const deterministic = text(
      renderToStaticMarkup(
        <RouterProvider>
          <AgentTeamCard vault="0x2222222222222222222222222222222222222222" tier="T0" />
        </RouterProvider>,
      ),
    )
    expect(deterministic).toContain('deterministic, no model')
    expect(deterministic).toContain('buys no media')

    const flagship = text(
      renderToStaticMarkup(
        <RouterProvider>
          <AgentTeamCard vault="0x3333333333333333333333333333333333333333" tier="T3" />
        </RouterProvider>,
      ),
    )
    expect(flagship).toContain('model in the loop')
    expect(flagship).toContain('buys third-party media')
  })
})
