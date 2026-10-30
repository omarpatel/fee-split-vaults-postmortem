import { describe, expect, it } from 'vitest'

import {
  DEGRADE_LADDER,
  TICK_PHASES,
  airlockView,
  degradeStep,
  describeSkip,
  formatPermille,
  proposalLabel,
  provenanceNotice,
  refusalsByPhase,
  runSummary,
  spendAgainstCap,
  untrustedReaders,
} from '../agent.js'
import { formatMicroUsd } from '../money.js'
import type { AgentRun, AgentRunDigest, AgentRoleView } from '../../api/model.js'

/**
 * The agent page's arithmetic.
 *
 * These are the functions that decide whether the page says "8% of the budget"
 * or "we cannot tell", and whether a scripted stand-in gets a banner. Both are
 * claims about honesty rather than about layout, which is why they are asserted
 * here and not left to be noticed in a screenshot.
 */

const DIGEST: AgentRunDigest = {
  windowId: 'coin_x:1700000000',
  windowStartUnix: 1_700_000_000,
  windowEndUnix: 1_700_001_800,
  admittedMessageCount: 41,
  droppedMessageCount: 260,
  distinctAuthorCount: 19,
  topicCounts: [
    { code: 'price_question', count: 20 },
    { code: 'how_to_buy', count: 13 },
  ],
  signals: ['mention_spike', 'desk_backlog_growing'],
  gists: ['holders asking where the receipts are', 'a lookalike account in the replies'],
  rejectedGistCount: 1,
  readerRefusals: 2,
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: '0xvault:1700001800',
    coinRef: 'coin_x',
    vault: '0xvault',
    atUnix: 1_700_001_800,
    tier: 'T2',
    ranChainPoll: true,
    ranCognition: true,
    nextDueUnix: 1_700_003_600,
    digest: DIGEST,
    proposals: [],
    suppressed: [],
    violations: [],
    refusals: [],
    spends: [],
    publishes: [],
    cost: {
      microUsd: 15_400n,
      degradeLevel: 'full',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    },
    modelProvenance: 'fake',
    ...overrides,
  }
}

describe('spendAgainstCap', () => {
  it('refuses to describe a capless coin as a coin at 0%', () => {
    // The whole rule this module exists for. A tier with no model in the loop
    // has no inference budget; rendering it as "$0.00 of $0.00, 0% used" would
    // describe a coin that CANNOT spend as a coin that has NOT spent.
    expect(spendAgainstCap(0n, 0n)).toBeNull()
    expect(spendAgainstCap(1_000n, 0n)).toBeNull()
  })

  it('measures in integer tenths of a percent, with no float in the path', () => {
    const against = spendAgainstCap(468_000n, 4_680_000n)
    expect(against).not.toBeNull()
    expect(against?.permille).toBe(100)
    expect(formatPermille(against?.permille ?? 0)).toBe('10%')
    expect(against?.spent).toBe('$0.46')
    expect(against?.cap).toBe('$4.68')
  })

  it('clamps the bar but never the reported figure, and flags an overspend', () => {
    const against = spendAgainstCap(9_000_000n, 4_500_000n)
    expect(against?.permille).toBe(2_000)
    expect(against?.barPercent).toBe(100)
    expect(against?.overCap).toBe(true)
  })
})

describe('formatPermille', () => {
  it('keeps the tenth when there is one and drops it when there is not', () => {
    expect(formatPermille(0)).toBe('0%')
    expect(formatPermille(4)).toBe('0.4%')
    expect(formatPermille(100)).toBe('10%')
    expect(formatPermille(1_007)).toBe('100.7%')
  })
})

describe('formatMicroUsd', () => {
  it('keeps sub-cent precision instead of rendering a real charge as free', () => {
    // A Haiku reader call really does cost this much. Rounded to cents it reads
    // as $0.00, and a day of them accumulated in cents drifts below the truth.
    expect(formatMicroUsd(4_300n)).toBe('$0.0043')
    expect(formatMicroUsd(1n)).toBe('$0.0000')
    expect(formatMicroUsd(0n)).toBe('$0.00')
  })

  it('switches to ordinary cents at a cent, where four decimals are noise', () => {
    expect(formatMicroUsd(10_000n)).toBe('$0.01')
    expect(formatMicroUsd(4_680_000n)).toBe('$4.68')
  })

  it('truncates rather than rounding up, so a charge is never overstated', () => {
    expect(formatMicroUsd(4_399n)).toBe('$0.0043')
    expect(formatMicroUsd(-4_300n)).toBe('-$0.0043')
  })
})

describe('provenanceNotice', () => {
  it('banners a scripted stand-in and says it is not a model', () => {
    const notice = provenanceNotice('fake', 'no credential resolved.')
    expect(notice.banner).toBe(true)
    expect(notice.title).toContain('not a model')
    expect(notice.body).toContain('no credential resolved.')
    expect(notice.body).toContain('fixed script')
  })

  it('banners "unknown" too, because not-sure is a thing to say rather than to hide', () => {
    const notice = provenanceNotice('unknown', 'no call has resolved yet.')
    expect(notice.banner).toBe(true)
    expect(notice.body).toContain('unattributed')
  })

  it('is the only quiet state when the client is confirmed live', () => {
    expect(provenanceNotice('live', 'resolved against a real credential.').banner).toBe(false)
  })
})

describe('degradeStep', () => {
  it('names every level on the ladder', () => {
    for (const rung of DEGRADE_LADDER) expect(degradeStep(rung.level)).toBe(rung)
  })

  it('describes the bottom rung as deterministic operation, not an outage', () => {
    expect(degradeStep('suspend').meaning).toContain('deterministically')
  })

  it('throws on a level it does not know rather than guessing a rung', () => {
    // @ts-expect-error deliberately outside the union: a server that grew a
    // fifth level must not be rendered as "full".
    expect(() => degradeStep('melted')).toThrow(/unknown degrade level/)
  })
})

describe('airlockView', () => {
  it('separates what the reader saw from what the planner received', () => {
    const view = airlockView(DIGEST)
    expect(view.readerSaw).toBe(41)
    expect(view.droppedByCaps).toBe(260)
    expect(view.distinctAuthors).toBe(19)

    // Everything the planner got, and all of it is a number except the gists.
    expect(view.counterCount).toBe(33)
    expect(view.signalCount).toBe(2)
    expect(view.gistCount).toBe(2)
    expect(view.gistChars).toBe(
      DIGEST.gists[0]!.length + DIGEST.gists[1]!.length,
    )
    expect(view.gistsRejected).toBe(1)
    expect(view.readerRefusals).toBe(2)
  })

  it('counts a flood as dropped messages rather than as messages read', () => {
    const view = airlockView({ ...DIGEST, admittedMessageCount: 600, droppedMessageCount: 499_400 })
    expect(view.readerSaw).toBe(600)
    expect(view.droppedByCaps).toBe(499_400)
  })
})

describe('refusalsByPhase', () => {
  it('groups in tick order, not in arrival order', () => {
    const grouped = refusalsByPhase(
      run({
        refusals: [
          { phase: 'publish', code: 'no_account_for_channel', detail: 'nothing bound' },
          { phase: 'guard', code: 'vault_not_active', detail: 'state is PENDING' },
          { phase: 'spend', code: 'paid_media_not_permitted', detail: 'screening' },
        ],
      }),
    )
    expect(grouped.map((group) => group.phase)).toEqual(['guard', 'spend', 'publish'])
  })

  it('shows a phase this build has never heard of rather than dropping it', () => {
    const grouped = refusalsByPhase(
      run({ refusals: [{ phase: 'quantum', code: 'x', detail: 'y' }] }),
    )
    expect(grouped.map((group) => group.phase)).toEqual(['quantum'])
    expect(TICK_PHASES).not.toContain('quantum')
  })

  it('drops nothing and invents nothing when there were no refusals', () => {
    expect(refusalsByPhase(run())).toEqual([])
  })
})

describe('runSummary', () => {
  it('reads a tick that ran and chose nothing as deliberately quiet', () => {
    const summary = runSummary(
      run({ proposals: [{ kind: 'no_action', reason: 'nothing worth saying' }] }),
    )
    expect(summary.deliberatelyQuiet).toBe(true)
    expect(summary.proposed).toBe(1)
  })

  it('does not call a tick that never ran quiet', () => {
    // "The team ran and decided to do nothing" and "the team did not run" are
    // different facts and the page renders them differently.
    expect(runSummary(run({ ranCognition: false, proposals: [] })).deliberatelyQuiet).toBe(false)
  })

  it('counts suppressions, refusals, publishes and refused spends separately', () => {
    const summary = runSummary(
      run({
        proposals: [
          { kind: 'post', channel: 'telegram', intent: 'answer', topic: 'how_to_buy', linkRefCount: 1, bodyChars: 180 },
        ],
        suppressed: [
          {
            proposal: { kind: 'purchase', skuId: 'sku_a', quantity: 1, rationale: 'sustained' },
            reason: 'divergence freeze',
          },
        ],
        refusals: [{ phase: 'spend', code: 'rolling_cap', detail: 'window cap' }],
        publishes: [
          { channel: 'telegram', intent: 'answer', published: true },
          { channel: 'x', intent: 'answer', published: false, rejectedReason: 'no account' },
        ],
        spends: [
          { status: 'REFUSED', approved: false, requiresHumanApproval: false, code: 'rolling_cap', detail: 'capped' },
        ],
      }),
    )
    expect(summary).toMatchObject({
      proposed: 1,
      suppressed: 1,
      refused: 1,
      published: 1,
      publishRejected: 1,
      spendApproved: 0,
      spendRefused: 1,
      cost: '$0.01',
      deliberatelyQuiet: false,
    })
  })
})

describe('proposalLabel', () => {
  it('carries no model-authored copy, only the closed-vocabulary fields', () => {
    expect(
      proposalLabel({
        kind: 'post',
        channel: 'telegram',
        intent: 'answer',
        topic: 'how_to_buy',
        linkRefCount: 2,
        bodyChars: 180,
      }),
    ).toBe('post to telegram · answer · how_to_buy')
    expect(proposalLabel({ kind: 'purchase', skuId: 'sku_a', quantity: 3, rationale: 'x' })).toBe(
      'buy sku_a ×3',
    )
    expect(proposalLabel({ kind: 'escalation', reason: 'unanswered_backlog', note: 'x' })).toBe(
      'escalate to a human · unanswered_backlog',
    )
    expect(proposalLabel({ kind: 'no_action', reason: 'quiet' })).toBe('no action')
  })
})

describe('describeSkip', () => {
  it('reads every known skip as a correct outcome rather than a failure', () => {
    expect(describeSkip('empty_window')).toContain('cost nothing')
    expect(describeSkip('tier_has_no_model')).toContain('deterministic by design')
    expect(describeSkip('budget_suspended')).toContain('budget is spent')
    expect(describeSkip('budget_insufficient')).toContain('not made')
  })

  it('shows an unrecognised code verbatim rather than swallowing it', () => {
    expect(describeSkip('some_new_reason')).toBe('some_new_reason')
  })
})

describe('untrustedReaders', () => {
  it('names only the roles that consume a stranger’s text', () => {
    const roles: AgentRoleView[] = [
      { id: 'reader', title: 'Reader', mission: '', phases: [], readsUntrustedInput: true, may: [], mayNot: [], activity: 'active' },
      { id: 'planner', title: 'Planner', mission: '', phases: [], readsUntrustedInput: false, may: [], mayNot: [], activity: 'active' },
      { id: 'desk', title: 'Desk', mission: '', phases: [], readsUntrustedInput: true, may: [], mayNot: [], activity: 'dormant' },
    ]
    expect(untrustedReaders(roles).map((role) => role.id)).toEqual(['reader', 'desk'])
  })
})
