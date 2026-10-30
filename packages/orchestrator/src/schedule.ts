/**
 * The cadence.
 *
 * TWO CLOCKS, both fixed, neither reachable from message content.
 *
 *   The COGNITION clock is CORPUS_LIMITS.windowMinutes, epoch-aligned. A window
 *   is processed exactly once, after it has closed. There is no wake-on-mention
 *   path anywhere in this package: a flood raises a counter inside a window that
 *   was going to run anyway, at a cost the corpus caps already bounded.
 *
 *   The CHAIN clock decays with coin age (the indexer's POLL_SCHEDULE) with a
 *   floor at the sweep interval for any vault that can authorise spending, so a
 *   spending coin is never reconciled less often than it can spend.
 *
 * A tick that is early for one clock still runs the other. That is the whole
 * reason they are separate: chain reconciliation must not wait on a cognition
 * window, and cognition must not be dragged onto a chain cadence.
 *
 * The window arithmetic is NOT reimplemented here. closedWindowAt() from the
 * runtime is the single definition, so the window this scheduler decides to run
 * and the window CoinRuntime.runWindow() actually reads can never disagree.
 */

import { CORPUS_LIMITS } from '@fee-split-vaults/core'
import { effectiveIntervalSeconds, type PollPolicyInput } from '@fee-split-vaults/indexer'
import { closedWindowAt, windowStartFor, type CorpusWindow } from '@fee-split-vaults/runtime'

export const WINDOW_SECONDS = CORPUS_LIMITS.windowMinutes * 60

export interface CadenceInput extends PollPolicyInput {
  coinRef: string
  /** windowId of the last cognition window this coin actually processed. */
  lastCognitionWindowId?: string
  lastChainPollUnix?: number
}

export interface CadenceDecision {
  /** The closed window to read, or undefined when it was already processed. */
  cognitionWindow?: CorpusWindow
  runChainPoll: boolean
  chainIntervalSeconds: number
  /** Earliest instant this coin has work again. A scheduler sleeps to it. */
  nextDueUnix: number
}

export function decideCadence(nowUnix: number, input: CadenceInput): CadenceDecision {
  const window = closedWindowAt(input.coinRef, nowUnix)
  const chainInterval = effectiveIntervalSeconds(input)
  const lastPoll = input.lastChainPollUnix
  const runChainPoll = lastPoll === undefined || nowUnix >= lastPoll + chainInterval

  const nextWindowClose = windowStartFor(nowUnix) + WINDOW_SECONDS
  const nextChainPoll = lastPoll === undefined ? nowUnix : lastPoll + chainInterval

  const decision: CadenceDecision = {
    runChainPoll,
    chainIntervalSeconds: chainInterval,
    nextDueUnix: Math.min(nextWindowClose, Math.max(nextChainPoll, nowUnix)),
  }
  if (input.lastCognitionWindowId !== window.windowId) {
    decision.cognitionWindow = window
  }
  return decision
}
