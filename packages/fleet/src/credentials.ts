/**
 * WHAT IS REAL IN THIS PROCESS, AND WHAT IS NOT.
 *
 * A fleet that runs on fakes and a fleet that runs on the chain look identical
 * from the outside: both tick, both log, both report healthy. That similarity is
 * the dangerous part, so this module exists to destroy it. Every dependency is
 * resolved through the same two-step - try the real thing, and if there is no
 * credential for it, substitute the fake AND WRITE THAT DOWN - and the written
 * record is printed as a startup banner, carried into every agent-run record,
 * and returned to the caller as data it cannot avoid seeing.
 *
 * THE CREDENTIAL IS RESOLVED BY USING IT, NOT BY GUESSING. There is more than
 * one way for the SDK to find a credential (the environment variable, a profile
 * written by `ant auth login`), and this process can only see one of them.
 * Reading the environment and concluding "no key, therefore no client" would be
 * a false negative for anyone who has logged in. So the client is constructed
 * and then asked to do one token of real work; see oneTokenProbe, which also
 * records why construction alone was not enough.
 *
 * A FAKE NEVER SPEAKS FOR A MODEL. The sandbox client below is not a stub that
 * mimics a model well enough to be mistaken for one:
 *   - it proposes a post, so the publisher path is exercised end to end;
 *   - it NEVER proposes a purchase, at any tier, under any digest, so no fake
 *     output can reach the spend gate and no fake can move a client's money;
 *   - every string it emits says, in the string itself, that it is scripted.
 */

import {
  FakeModelClient,
  MODEL,
  createAnthropicModelClient,
  hashUserId,
  toolUseReply,
} from '@fee-split-vaults/runtime'
import type {
  ModelClient,
  ModelContentBlock,
  ModelRequest,
  ScriptedReply,
} from '@fee-split-vaults/runtime'

/** Where the model output in a run came from. Written per run, never inferred. */
export type ModelProvenance = 'live' | 'fake' | 'unknown'

export interface Substitution {
  /** The dependency that was faked. A closed set, named by the caller. */
  dependency: string
  /** Why, in one line. A machine-ish reason, never a stack trace. */
  reason: string
  /** True when this dependency can authorize or move money. */
  inMoneyPath: boolean
}

/**
 * The list of what is not real, built as the process wires itself up.
 *
 * It is a value rather than a log side effect because the two things that must
 * consume it - the banner and the per-run record - are in different files and
 * neither may be allowed to forget.
 */
export class SubstitutionLedger {
  readonly #substitutions: Substitution[] = []
  readonly #real: Array<{ dependency: string; detail: string }> = []

  /** Record that `dependency` is running as a fake, and why. */
  fake(dependency: string, reason: string, inMoneyPath = false): void {
    this.#substitutions.push({ dependency, reason, inMoneyPath })
  }

  /** Record that `dependency` resolved to the real implementation. */
  real(dependency: string, detail: string): void {
    this.#real.push({ dependency, detail })
  }

  get substitutions(): readonly Substitution[] {
    return this.#substitutions
  }

  get realDependencies(): ReadonlyArray<{ dependency: string; detail: string }> {
    return this.#real
  }

  /** Just the names, for the run record. Sorted, so a diff is readable. */
  names(): string[] {
    return this.#substitutions.map((s) => s.dependency).sort()
  }

  get anyFake(): boolean {
    return this.#substitutions.length > 0
  }

  get anyFakeInMoneyPath(): boolean {
    return this.#substitutions.some((s) => s.inMoneyPath)
  }

  /**
   * Did a real chain resolve?
   *
   * Read by the banner so its one-line summary cannot contradict the list
   * printed directly beneath it. Keyed on the dependency name the adapter
   * loader records, which is the same name the sandbox world would have
   * recorded as a fake - so exactly one of the two is ever true.
   */
  get anyRealChain(): boolean {
    return this.#real.some((entry) => entry.dependency === 'chain')
  }
}

/**
 * The startup banner.
 *
 * Deliberately loud and deliberately first: an operator who scrolls past this
 * has been told. The money-path line is separate from the rest because a faked
 * price book and a faked settlement port are not the same kind of untruth.
 */
export function startupBanner(ledger: SubstitutionLedger, provenance: ModelProvenance): string {
  const rule = '='.repeat(78)
  const lines: string[] = [rule]

  if (!ledger.anyFake) {
    lines.push('FLEET: every dependency resolved to a real implementation.')
  } else if (ledger.anyFakeInMoneyPath) {
    lines.push('PARTLY FAKED FLEET - FAKES IN THE MONEY PATH. TREAT NOTHING HERE AS REAL.')
    // "No chain was read" USED TO BE PRINTED UNCONDITIONALLY, and the day the
    // real chain adapter was wired in it became a lie: the fleet read Venue
    // mainnet, said so two lines further down under `real:`, and claimed the
    // opposite here. A banner that contradicts its own list is worse than no
    // banner, because it is the line a reader trusts and stops reading at. So
    // the claim is now made only about the things actually substituted.
    const summary = ledger.anyRealChain
      ? 'A real chain WAS read. No money moved and nothing was sent to a channel.'
      : 'No chain was read, no money moved, and nothing was sent to a channel.'
    lines.push(summary)
  } else {
    lines.push('PARTLY FAKED FLEET - SOME DEPENDENCIES ARE FAKED. See the list below.')
  }

  lines.push(rule)
  lines.push(`model output: ${provenance.toUpperCase()}`)
  if (provenance !== 'live') {
    lines.push('  Model output below is SCRIPTED. It is not a model’s and must not be quoted as one.')
  }

  if (ledger.realDependencies.length > 0) {
    lines.push('real:')
    for (const entry of [...ledger.realDependencies].sort((a, b) => a.dependency.localeCompare(b.dependency))) {
      lines.push(`  ${entry.dependency.padEnd(22)} ${entry.detail}`)
    }
  }

  if (ledger.anyFake) {
    lines.push('faked:')
    for (const s of [...ledger.substitutions].sort((a, b) => a.dependency.localeCompare(b.dependency))) {
      const flag = s.inMoneyPath ? ' [MONEY PATH]' : ''
      lines.push(`  ${s.dependency.padEnd(22)} ${s.reason}${flag}`)
    }
  }

  lines.push(rule)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// The model client
// ---------------------------------------------------------------------------

export interface ResolvedModelClient {
  client: ModelClient
  provenance: ModelProvenance
  /** How it resolved, or why it did not. Goes in the banner verbatim. */
  detail: string
}

export interface ResolveModelOptions {
  /** Defaults to process.env. Injected so the resolution is testable. */
  env?: Record<string, string | undefined>
  /**
   * Force the scripted client even when a credential exists. `--dry-run` sets
   * this: a dry run that quietly spent real inference budget would be a trap.
   */
  forceFake?: boolean
  /** Injected in tests. Defaults to the real SDK constructor. */
  construct?: (apiKey?: string) => Promise<ModelClient>
  /** Injected in tests. Defaults to the one-token probe below. */
  probe?: (client: ModelClient) => Promise<void>
}

/**
 * The smallest possible real request.
 *
 * CONSTRUCTION IS NOT RESOLUTION. This was written first as "construct the
 * client and let it throw", which is what the SDK's own documentation implies -
 * and it is wrong for this SDK: `new Anthropic()` with no key anywhere
 * constructs happily and only fails when a request is actually built, with
 * "Could not resolve authentication method". A fleet that trusted construction
 * therefore reported LIVE, wrote LIVE into every run record, and then refused
 * every cognition phase with an authentication error. That is the exact failure
 * this whole module exists to prevent, so the credential is resolved by USING
 * it, once, for one token.
 */
async function oneTokenProbe(client: ModelClient): Promise<void> {
  await client.complete({
    model: MODEL.haiku45,
    system: [{ text: 'Reply with the single character "1".' }],
    userText: '1',
    maxTokens: 1,
    // Operator-scoped, not a client's: no coin is involved in a startup probe.
    userIdHash: hashUserId('venue-fleet-startup-probe-salt-value-32ch', 'fleet-probe'),
  })
}

/**
 * Resolve a model client, or say why there is none.
 *
 * Order: an explicit environment key, then the SDK's own resolution (which can
 * find a profile this process cannot see, so the absence of an environment
 * variable is never treated as the absence of a credential). Then the probe,
 * because on this SDK the construction cannot fail.
 *
 * THREE OUTCOMES, AND THE THIRD IS THE INTERESTING ONE.
 *   The probe succeeds -> live.
 *   The probe fails on AUTHENTICATION -> there is no credential. Scripted
 *     client, named in the banner, provenance 'fake' in every run record.
 *   The probe fails on anything else - no network, a rate limit, a 500 - and we
 *     cannot tell. The default is the scripted client with the reason attached,
 *     because clearly labelled scripted output is safe here: it cannot reach a
 *     real channel (assertNoFakeAuthoredRealSend) and cannot propose a purchase.
 *     A production deployment sets FLEET_REQUIRE_LIVE_MODEL=1 and gets the
 *     fail-closed posture instead: uncertainty is not permission, so it refuses
 *     to start rather than serving a client scripted answers all night.
 */
export async function resolveModelClient(
  options: ResolveModelOptions = {},
): Promise<ResolvedModelClient> {
  const env = options.env ?? process.env
  const construct =
    options.construct ??
    (async (apiKey?: string): Promise<ModelClient> =>
      createAnthropicModelClient(apiKey === undefined ? {} : { apiKey }))
  const probe = options.probe ?? oneTokenProbe

  if (options.forceFake === true) {
    return {
      client: sandboxModelClient(),
      provenance: 'fake',
      detail: 'forced: this run asked for the scripted client',
    }
  }

  const explicit = env.ANTHROPIC_API_KEY
  const source =
    explicit !== undefined && explicit.length > 0
      ? 'ANTHROPIC_API_KEY from the environment'
      : 'the SDK’s own credential resolution'

  let client: ModelClient
  try {
    client = explicit !== undefined && explicit.length > 0 ? await construct(explicit) : await construct()
  } catch (error) {
    return {
      client: sandboxModelClient(),
      provenance: 'fake',
      detail: `no client could be constructed: ${shortReason(error)}`,
    }
  }

  if (env.FLEET_MODEL_PROBE === '0') {
    // An operator who knows the credential is good and does not want a request
    // at every restart. Their claim, on their say-so, recorded as such.
    return { client, provenance: 'live', detail: `${source} (probe skipped by FLEET_MODEL_PROBE=0)` }
  }

  try {
    await probe(client)
    return { client, provenance: 'live', detail: `${source}, confirmed by a one-token probe` }
  } catch (error) {
    const reason = shortReason(error)
    if (!looksLikeAuthFailure(reason)) {
      if (env.FLEET_REQUIRE_LIVE_MODEL === '1') {
        throw new ModelCredentialUnresolved(
          `the credential probe failed and FLEET_REQUIRE_LIVE_MODEL=1: ${reason}`,
        )
      }
      return {
        client: sandboxModelClient(),
        provenance: 'fake',
        detail: `credential could not be confirmed (${reason}); running scripted`,
      }
    }
    return {
      client: sandboxModelClient(),
      provenance: 'fake',
      detail: `no credential resolved: ${reason}`,
    }
  }
}

/** Refuses to start rather than serving scripted answers as if they were real. */
export class ModelCredentialUnresolved extends Error {
  constructor(message: string) {
    super(`fleet refusing to start: ${message}`)
    this.name = 'ModelCredentialUnresolved'
  }
}

/**
 * Is this "you have no key" or "the network is having a bad day"?
 *
 * Matched on the message because the transport already collapses the SDK's
 * typed errors into ModelCallFailed with a stable prefix, and because the
 * pre-request failure ("could not resolve authentication method") is not an API
 * error at all - it never reaches the wire, so it has no status to match on.
 */
export function looksLikeAuthFailure(reason: string): boolean {
  const text = reason.toLowerCase()
  return (
    text.includes('authentication') ||
    text.includes('could not resolve authentication method') ||
    text.includes('api key') ||
    text.includes('unauthorized') ||
    text.includes('401')
  )
}

function shortReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const firstLine = text.split('\n')[0] ?? text
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine
}

/** Every string the scripted client emits carries this, in the string. */
export const SANDBOX_MARKER = 'scripted sandbox output, not a model’s'

/**
 * A reader emission the airlock accepts, and a planner turn that cannot spend.
 *
 * The topic counts are deliberately small: validateDigest clamps any count that
 * exceeds the number of messages trusted code actually admitted, so a scripted
 * census can never inflate a window it did not read.
 */
const SANDBOX_READER_EMISSION = JSON.stringify({
  topicCounts: { how_to_buy: 2, sentiment_positive: 1 },
  signals: ['quiet'],
  gists: [`holders asked how to buy (${SANDBOX_MARKER})`],
  readerRefusals: 0,
})

/**
 * The scripted client.
 *
 * The reader turn carries no tools, so it is identified by their absence -
 * exactly the property Reader.buildRequest is asserted on elsewhere.
 */
export function sandboxModelClient(): FakeModelClient {
  return new FakeModelClient((request: ModelRequest): ScriptedReply => {
    if (request.tools === undefined) {
      const content: ModelContentBlock[] = [{ type: 'text', text: SANDBOX_READER_EMISSION }]
      return { content, stopReason: 'end_turn' }
    }
    // THE PLANNER TURN. A post, never a purchase. `propose_purchase` is not
    // offered to this branch under any tier or screening verdict, so a scripted
    // run cannot reach the spend gate even if the catalog and the tier would
    // otherwise allow it.
    const offersPost = request.tools.some((tool) => tool.name === 'propose_post')
    if (!offersPost) {
      return toolUseReply([
        { name: 'propose_no_action', input: { reason: `no post tool offered; ${SANDBOX_MARKER}` } },
      ])
    }
    return toolUseReply([
      {
        name: 'propose_post',
        input: {
          channel: 'telegram',
          intent: 'answer_backlog',
          topic: 'how_to_buy',
          body:
            'Several holders asked how to buy and where the contract is listed. ' +
            `Answering in the channel with the pinned guide. This copy is ${SANDBOX_MARKER}.`,
          linkRefs: [],
          imageRefs: [],
        },
      },
    ])
  })
}
