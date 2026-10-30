/**
 * demo screening - four stages, cheapest first, UNION OF FLAGS.
 *
 * WHAT A VIEWER SHOULD TAKE AWAY. Every stage may ADD a flag. No stage may
 * remove one, and no stage may lower the severity of one already raised. Stage 3
 * is a language model reading text the coin's creator wrote; the union rule is
 * what makes its compromise survivable, and `assertMonotonic` proves at runtime
 * that a later, more expensive, less trustworthy stage did not clear an earlier
 * one.
 *
 * A screening subject is ENTIRELY attacker-authored - a memecoin's name, symbol,
 * description and images are chosen by the person asking us to promote them - so
 * nothing in that package treats any of it as instructions, dereferences a URL,
 * or lets a value from it reach a payee or an amount.
 *
 * The slur list a real deployment screens against is operator-supplied and
 * deliberately absent from this repository; see DEMO_SLUR_SOURCE below for what
 * stands in for it and why that is not a shortcut. Every other term the subjects
 * below trip is on the shipped default list.
 */

import {
  DEFAULT_LEXICON_SOURCE,
  FakeAdjudicator,
  FakeCsamHashProvider,
  FakeMatcher,
  InMemoryCsamEscalationSink,
  InMemoryScreeningHistory,
  Lexicon,
  LoadedSdnSource,
  PaidMediaReviewQueue,
  SAMPLE_SDN_ENTRIES,
  ScreeningEngine,
  SdnScreener,
  StaticLexiconSource,
  assertPaidMediaApproved,
  assertPaidMediaPermitted,
  specFor,
  type ImageRef,
  type PerceptualMatch,
  type ScreeningReport,
  type SubjectMetadata,
} from '@fee-split-vaults/screening'
import { table } from '../format.ts'
import { NOW } from './fixtures.ts'
import { ok, refused, summarise, type DemoResult, type Pair, type Scene } from './render.ts'

/**
 * THE SLUR LIST IS OPERATOR-SUPPLIED AND DELIBERATELY ABSENT FROM THIS REPO.
 *
 * Stage 1 raises `lexicon_unconfigured` - a RESTRICTED flag that makes a CLEAR
 * verdict impossible - on any deployment that has not loaded one. That is the
 * correct behaviour and it is why the demo supplies these two invented nonsense
 * words rather than turning the check off: the demo shows the MECHANISM with a
 * placeholder list, and a real deployment that forgets to load the real list
 * cannot clear a single coin.
 */
const DEMO_SLUR_SOURCE = new StaticLexiconSource(
  [
    { term: 'zorblat', category: 'slur' },
    { term: 'grintok', category: 'slur' },
  ],
  'demo-placeholder-slurs-v1',
)

const CLEAN_IMAGE: ImageRef = {
  id: 'img-clean',
  sha256: 'a1'.repeat(32),
  byteLength: 41_233,
  mimeType: 'image/png',
}

const LOGO_IMAGE: ImageRef = {
  id: 'img-logo',
  sha256: 'b2'.repeat(32),
  byteLength: 52_910,
  mimeType: 'image/png',
}

/** The one image the perceptual matcher recognises, at a score over threshold. */
const LOGO_MATCHES = new Map<string, PerceptualMatch[]>([
  [LOGO_IMAGE.sha256, [{ id: 'mark:well-known-exchange', score: 0.94 }]],
])

interface EngineOptions {
  adjudication?: unknown
  adjudicatorThrows?: Error
  history?: InMemoryScreeningHistory
}

function makeEngine(options: EngineOptions = {}): ScreeningEngine {
  const adjudicator =
    options.adjudicatorThrows !== undefined
      ? FakeAdjudicator.throwing(options.adjudicatorThrows)
      : FakeAdjudicator.returning(options.adjudication ?? { labels: ['clean'], confidence: 'high' })

  return new ScreeningEngine({
    lexicon: new Lexicon([DEFAULT_LEXICON_SOURCE, DEMO_SLUR_SOURCE]),
    sdn: new SdnScreener(new LoadedSdnSource(SAMPLE_SDN_ENTRIES, NOW - 86_400)),
    perceptual: {
      csam: new FakeCsamHashProvider(new Set(), new Set(), () => NOW),
      escalation: new InMemoryCsamEscalationSink(),
      logos: new FakeMatcher(LOGO_MATCHES),
    },
    adjudicator,
    history: options.history ?? new InMemoryScreeningHistory(),
    clock: () => NOW,
  })
}

function metadata(partial: Partial<SubjectMetadata> = {}): SubjectMetadata {
  return {
    token: '0x00000000000000000000000000000000000000aa',
    name: 'Moon Dog',
    symbol: 'MDOG',
    description: 'A dog coin for dog people. Nothing else going on here.',
    imageRefs: [CLEAN_IMAGE],
    metadataMutable: false,
    observedAtUnix: NOW,
    ...partial,
  }
}

/** The union, with each flag's stage and severity. This IS the verdict. */
function flagTable(report: ScreeningReport): string {
  if (report.flags.length === 0) return '  (no flags raised by any stage)'
  return table(report.flags, [
    { header: 'flag', value: (f) => f.code },
    { header: 'stage', value: (f) => specFor(f.code).stage },
    { header: 'severity', value: (f) => f.severity },
    { header: 'public decline code', value: (f) => specFor(f.code).publicCode },
    { header: 'evidence (scrubbed)', value: (f) => f.evidence ?? f.detail ?? '-' },
  ])
}

function verdictLine(report: ScreeningReport): string {
  return [
    `verdict            : ${report.verdict}`,
    `paid media         : ${report.paidMediaPermitted ? 'permitted' : 'REFUSED'}`,
    `stages run         : ${report.stagesRun.join(', ')}`,
    `flags (union)      : ${report.flags.length}`,
    `expires            : ${new Date(report.expiresAtUnix * 1000).toISOString()}`,
  ].join('\n')
}

export async function runScreeningDemo(): Promise<DemoResult> {
  const scenes: Scene[] = []
  const facts: Pair[] = []

  // -------------------------------------------------------------------------
  // 1. CLEAN, through all four stages.
  // -------------------------------------------------------------------------
  {
    const engine = makeEngine()
    const report = await engine.screen(metadata())
    const queue = new PaidMediaReviewQueue()
    queue.enqueue({
      id: 'rev-1',
      vault: '0x1111111111111111111111111111111111111111',
      token: report.subject.token,
      creativeHash: 'c1'.repeat(32),
      submittedAtUnix: NOW,
      report,
    })
    const claimed = queue.claim('reviewer-1', NOW)
    const decided = queue.decide('rev-1', {
      reviewerId: 'reviewer-1',
      decision: 'approve',
      decidedAtUnix: NOW,
    })
    let gateError: unknown
    try {
      assertPaidMediaApproved(queue.get('rev-1')!, NOW)
    } catch (caught: unknown) {
      gateError = caught
    }

    scenes.push({
      id: 'screening.clear',
      title: 'A clean coin, through all four stages',
      proves:
        'The cheap deterministic stages run always, the model stage runs on a closed rubric with enum-only output, and a person still has to approve the exact creative before a dollar of paid media moves. A CLEAR verdict is the only one that reaches the last gate.',
      verdict: ok(
        'CLEAR',
        `stages ${report.stagesRun.join(' -> ')}; reviewer ${claimed?.claimedBy ?? '-'} approved; paid media ${gateError === undefined ? 'permitted' : 'REFUSED'}`,
      ),
      given: [
        { label: 'name', value: metadata().name },
        { label: 'symbol', value: metadata().symbol },
        { label: 'description', value: metadata().description ?? '' },
        { label: 'images', value: '1, addressed by content hash - screening never fetches a remote URL' },
      ],
      path: [
        'stage 1 lexicon + trademark + sanctions: free, pure, deterministic, always',
        'stage 2 perceptual: the mandatory child-safety hash check ran and returned no_match, then logo matching',
        'stage 3 adjudication: closed rubric, enum-only output, no free text crosses back',
        'stage 4 human: a reviewer claimed and approved THIS creative hash, not the coin in general',
      ],
      blocks: [
        { label: 'union of flags', text: flagTable(report), plain: true },
        { label: 'verdict', text: verdictLine(decided) },
      ],
    })

    facts.push({
      label: 'child-safety check on a clean image',
      value: 'ran, returned no_match; a match is a preservation-and-report event and never reaches a public artefact',
    })
  }

  // -------------------------------------------------------------------------
  // 2. RESTRICTED, and stage 3 cannot lift it.
  // -------------------------------------------------------------------------
  {
    const engine = makeEngine({ adjudication: { labels: ['clean'], confidence: 'high' } })
    const subject = metadata({
      token: '0x00000000000000000000000000000000000000bb',
      name: 'Nintendo Dog',
      symbol: 'NDOG',
      description: 'A tribute coin. Elon Musk would love this one.',
      imageRefs: [LOGO_IMAGE],
    })
    const report = await engine.screen(subject)

    const queue = new PaidMediaReviewQueue()
    queue.enqueue({
      id: 'rev-2',
      vault: '0x1111111111111111111111111111111111111111',
      token: report.subject.token,
      creativeHash: 'c2'.repeat(32),
      submittedAtUnix: NOW,
      report,
    })
    queue.decide('rev-2', { reviewerId: 'reviewer-1', decision: 'approve', decidedAtUnix: NOW })
    let gateError: unknown
    try {
      assertPaidMediaApproved(queue.get('rev-2')!, NOW)
    } catch (caught: unknown) {
      gateError = caught
    }

    scenes.push({
      id: 'screening.restricted',
      title: 'A third-party mark, a public figure, and a logo - with a model that says it is fine',
      proves:
        'Stage 3 was handed a subject already carrying three RESTRICTED flags and returned "clean". The verdict did not move. Approval authorises paid media for one creative; it never deletes a flag, and a human approving a RESTRICTED subject still does not get paid media.',
      verdict: refused(
        `${report.verdict}: NO PAID MEDIA`,
        gateError instanceof Error ? gateError.message : 'the paid-media gate did not refuse',
      ),
      given: [
        { label: 'name', value: subject.name },
        { label: 'description', value: subject.description ?? '' },
        { label: 'image', value: 'matches an allowlisted mark at 0.94 against a 0.85 threshold' },
        { label: 'stage 3 said', value: '{ labels: ["clean"], confidence: "high" }' },
      ],
      path: [
        'stage 1 flagged the trademark and the public figure',
        'stage 2 flagged the logo match',
        'stage 3 adjudicated the subject as clean and added nothing',
        'mergeFlags unioned the result and assertMonotonic proved nothing was cleared',
        'a reviewer then approved the creative - and the paid-media gate STILL refused, because the verdict is not CLEAR',
      ],
      blocks: [
        { label: 'union of flags', text: flagTable(report), plain: true },
        { label: 'verdict', text: verdictLine(report) },
        {
          label: 'organic operations vs paid media',
          text: [
            'organic (desk, moderation, pinned facts) : PERMITTED - RESTRICTED is not a ban',
            `paid media                              : REFUSED - ${gateError instanceof Error ? gateError.message : 'n/a'}`,
          ].join('\n'),
        },
      ],
    })
  }

  // -------------------------------------------------------------------------
  // 3. BLOCKED at stage 1, and the later stages never get a vote.
  // -------------------------------------------------------------------------
  const blockedHistory = new InMemoryScreeningHistory()
  {
    const engine = makeEngine({
      adjudication: { labels: ['clean'], confidence: 'high' },
      history: blockedHistory,
    })
    const subject = metadata({
      token: '0x00000000000000000000000000000000000000cc',
      name: 'Memorial Fund Coin',
      symbol: 'RIP',
      description: 'Launched for the plane crash victims. Rest in peace.',
    })
    const report = await engine.screen(subject)

    const queue = new PaidMediaReviewQueue()
    let queueError: unknown
    try {
      queue.enqueue({
        id: 'rev-3',
        vault: '0x1111111111111111111111111111111111111111',
        token: report.subject.token,
        creativeHash: 'c3'.repeat(32),
        submittedAtUnix: NOW,
        report,
      })
    } catch (caught: unknown) {
      queueError = caught
    }

    let opsError: unknown
    try {
      assertPaidMediaPermitted(report, NOW)
    } catch (caught: unknown) {
      opsError = caught
    }

    scenes.push({
      id: 'screening.blocked',
      title: 'A coin named for someone else\'s worst day',
      proves:
        'Stage 3 costs a model call and is SKIPPED once a subject is already blocked, because nothing a later stage returns can lift a block. A BLOCKED subject is never queued for review either - it is declined, and the dev keeps 100% of their fees.',
      verdict: refused(
        'BLOCKED',
        `${report.flags.filter((f) => f.severity === 'block').length} block-severity flags; adjudication never ran`,
      ),
      given: [
        { label: 'name', value: subject.name },
        { label: 'description', value: subject.description ?? '' },
      ],
      path: [
        'stage 1 matched the tragedy lexicon',
        'stage 2 ran (there are images), and added nothing',
        'stage 3 was SKIPPED - a block cannot be lifted, so the model call would be money spent to learn nothing',
        'the block was recorded against the TOKEN, not against this metadata',
      ],
      blocks: [
        { label: 'union of flags', text: flagTable(report), plain: true },
        { label: 'verdict', text: verdictLine(report) },
        {
          label: 'what the operator may do with this coin',
          text: [
            `paid media   : ${opsError instanceof Error ? `REFUSED - ${opsError.message}` : 'permitted'}`,
            `human review : ${queueError instanceof Error ? `REFUSED - ${queueError.message}` : 'queued'}`,
            'the dev      : keeps 100% of their creator fees; the vault never charges outside ACTIVE',
            'published    : a decline record carrying the coarse public code and nothing else',
          ].join('\n'),
        },
      ],
    })
  }

  // -------------------------------------------------------------------------
  // 4. The block follows the token, not the metadata.
  // -------------------------------------------------------------------------
  {
    const engine = makeEngine({ history: blockedHistory })
    const renamed = metadata({
      token: '0x00000000000000000000000000000000000000cc',
      name: 'Happy Puppy Coin',
      symbol: 'HAPPY',
      description: 'A cheerful coin about puppies and sunshine.',
    })
    const report = await engine.screen(renamed)
    scenes.push({
      id: 'screening.sticky_block',
      title: 'The blocked coin renames itself to something harmless',
      proves:
        'Blocks follow the TOKEN, not the metadata. A coin blocked for exploiting a tragedy that renames itself is the same coin, and re-screening the new name from scratch would launder it.',
      verdict: refused('BLOCKED', 'previously_blocked, carried forward under different metadata'),
      given: [
        { label: 'token', value: `${renamed.token} - the same contract as scene 3` },
        { label: 'name now', value: renamed.name },
        { label: 'description now', value: renamed.description ?? '' },
        { label: 'this metadata alone', value: 'would screen CLEAR on every stage' },
      ],
      path: [
        'the history was consulted before stage 1 ran at all',
        'the token carried an earlier block, so previously_blocked was raised first',
        'every subsequent stage could only add to that',
      ],
      blocks: [
        { label: 'union of flags', text: flagTable(report), plain: true },
        { label: 'verdict', text: verdictLine(report) },
      ],
    })
  }

  // -------------------------------------------------------------------------
  // 5. Fail closed: a stage that throws.
  // -------------------------------------------------------------------------
  {
    const engine = makeEngine({
      adjudicatorThrows: new Error('adjudication provider timed out after 30s'),
    })
    const report = await engine.screen(
      metadata({ token: '0x00000000000000000000000000000000000000dd', name: 'Ordinary Cat', symbol: 'MEOW' }),
    )
    scenes.push({
      id: 'screening.fail_closed',
      title: 'The adjudication provider is down',
      proves:
        'A stage that cannot run does not skip and does not pass. The outage becomes a flag of its own, and because the verdict is the union of flags, one unavailable stage decides the whole screening - a coin that would otherwise be CLEAR cannot buy paid media until the provider is back.',
      verdict: refused(
        report.verdict,
        `${report.flags.map((f) => f.code).join(', ')} - an outage is never a clearance`,
      ),
      given: [
        { label: 'subject', value: 'Ordinary Cat (MEOW) - raises nothing at stages 1 or 2' },
        { label: 'stage 3', value: 'threw: adjudication provider timed out after 30s' },
        { label: 'without this rule', value: 'the coin would have been CLEAR and eligible for paid media' },
      ],
      path: [
        'stages 1 and 2 completed and raised nothing',
        'stage 3 threw',
        'the stage returned adjudication_unavailable instead of returning nothing',
        'the union carried it into the verdict: RESTRICTED, so organic operations continue and paid media does not',
        'a throw the stage itself does not catch becomes internal_fail_closed, which is a BLOCK',
      ],
      blocks: [
        { label: 'union of flags', text: flagTable(report), plain: true },
        { label: 'verdict', text: verdictLine(report) },
      ],
    })
  }

  facts.push(
    { label: 'stages', value: '1 lexicon/trademark/sanctions, 2 perceptual, 3 adjudication, 4 human' },
    { label: 'flag algebra', value: 'union only - every stage may add, no stage may remove or downgrade' },
    { label: 'proof that holds', value: 'assertMonotonic runs at every stage boundary, at runtime, not in a test' },
    { label: 'verdicts', value: 'CLEAR, RESTRICTED (organic only, no paid media), BLOCKED' },
    { label: 'a reviewer may', value: 'approve a CLEAR creative. Never clear a flag, never override a block.' },
    { label: 'what a decline publishes', value: 'a coarse public code. Never the matched term, never the offending text.' },
    { label: 'keys held by this package', value: 'none. No spending, posting or signing surface.' },
    {
      label: 'slur list in this demo',
      value: 'two invented nonsense words. Without ANY slur list, stage 1 refuses to clear a single coin.',
    },
    {
      label: 'sanctions list in this demo',
      value: 'the documented sample, wrapped as authoritative. The shipped SampleSdnSource cannot produce a CLEAR.',
    },
  )

  return summarise(
    'screening',
    'four stages, union of flags, and no stage can clear a prior stage\'s hit',
    [
      'Five subjects, all four stages, and the union rule doing the work. One clears and reaches',
      'paid media. One is RESTRICTED by a mark and a logo and stays RESTRICTED even though the',
      'model stage says it is clean and a human approves it. One is BLOCKED at the first stage',
      'and never reaches the model at all - then renames itself and is blocked again. One has its',
      'model stage fail, and an outage becomes a block rather than a pass.',
    ],
    scenes,
    facts,
  )
}
