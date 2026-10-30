/**
 * The alert catalog's own tests.
 *
 * The structural checks at the top are the ones that keep the catalog honest
 * over time: every id defined, every runbook present on disk, every alert a job
 * raises actually in the catalog. An alert with a dangling runbook link is
 * discovered at 3am by the person who most needs it not to be.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALERT_IDS, isAlertId } from '../ids.js'
import { ALERTS } from '../alerts.js'
import { AlertEvaluator, alertsById, renderAlertTable } from '../evaluate.js'
import { emptySignals, type OpsSignals } from '../types.js'
import { collectFiles, readTextFile } from '../../ci/scan.js'
import { DAY, HOUR } from '../../lib/time.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const AT = Math.floor(Date.UTC(2026, 8, 7, 12, 0, 0) / 1000)

function signals(mutate: (s: OpsSignals) => void): OpsSignals {
  const base = emptySignals(AT)
  mutate(base)
  return base
}

describe('catalog structure', () => {
  it('defines every declared alert id exactly once', () => {
    const defined = ALERTS.map((a) => a.id).sort()
    expect(defined).toEqual([...ALERT_IDS].sort())
    expect(new Set(defined).size).toBe(defined.length)
  })

  it('every alert points at a runbook that exists', () => {
    for (const alert of ALERTS) {
      const path = resolve(REPO_ROOT, alert.runbook)
      expect(existsSync(path), `${alert.id} -> ${alert.runbook}`).toBe(true)
    }
  })

  it('every runbook is substantial rather than a placeholder', () => {
    for (const runbook of new Set(ALERTS.map((a) => a.runbook))) {
      const body = readFileSync(resolve(REPO_ROOT, runbook), 'utf8')
      expect(body.length, runbook).toBeGreaterThan(1500)
      // Detection, immediate action, decision point, commands. All four or it
      // is not a runbook, it is a description of a problem.
      for (const heading of ['Detection', 'Immediate actions', 'Decision points', 'Commands']) {
        expect(body, `${runbook} is missing "${heading}"`).toContain(heading)
      }
    }
  })

  it('every alert states its rationale for the person it wakes', () => {
    for (const alert of ALERTS) {
      expect(alert.rationale.length, alert.id).toBeGreaterThan(80)
      expect(alert.title.length, alert.id).toBeGreaterThan(10)
    }
  })

  it('no auto-action widens authority', () => {
    // Every automatic response must be a restriction. The closed list below is
    // the whole vocabulary; adding a member that grants rather than removes
    // authority - "resume_publishing", "approve_spend" - fails here first.
    const restrictionsOnly = new Set([
      'none',
      'freeze_new_authorizations',
      'halt_publishing',
      'halt_paid_media',
      'disable_quote_asset',
      'suspend_vault',
      'throttle_model',
      'halt_sweeps',
    ])
    for (const alert of ALERTS) {
      expect(restrictionsOnly.has(alert.autoAction), `${alert.id}: ${alert.autoAction}`).toBe(true)
    }
  })

  it('every alert a job can raise is in the catalog', async () => {
    // The AlertId union already enforces this at compile time; this catches a
    // literal that slipped in through a cast.
    const jobFiles = collectFiles({ root: resolve(REPO_ROOT, 'ops', 'scheduler'), extensions: ['.ts'] })
    const raised = new Set<string>()
    for (const file of jobFiles) {
      const source = readTextFile(file.absolutePath)
      for (const match of source.matchAll(/alertId:\s*'([a-z_]+)'/g)) {
        if (match[1] !== undefined) raised.add(match[1])
      }
    }
    expect(raised.size).toBeGreaterThan(0)
    for (const id of raised) expect(isAlertId(id), `${id} is raised but not defined`).toBe(true)
  })

  it('renders a table that links every alert to its runbook', () => {
    const table = renderAlertTable()
    for (const alert of ALERTS) expect(table).toContain(alert.id)
  })

  it('indexes by id', () => {
    expect(alertsById().get('ledger_variance_critical')?.severity).toBe('page')
  })
})

describe('the required alerts fire on their condition', () => {
  it('a critical ledger variance pages and freezes new authorizations', () => {
    const result = new AlertEvaluator().evaluate(
      signals((s) => {
        s.ledger.openCriticalVariances = [
          { vault: '0xv', asset: '0xa', deltaMinor: '-4200', detectedAtUnix: AT - 60 },
        ]
      }),
    )
    const firing = result.firing.find((f) => f.alertId === 'ledger_variance_critical')
    expect(firing?.severity).toBe('page')
    expect(firing?.autoAction).toBe('freeze_new_authorizations')
    expect(firing?.scope).toBe('0xv')
  })

  it('a recipient transfer on an active vault pages', () => {
    const result = new AlertEvaluator().evaluate(
      signals((s) => {
        s.chain.recipientTransfersOnActiveVaults = [
          { vault: '0xv', token: '0xt', observedAtUnix: AT - 10, blockHash: '0xb' },
        ]
      }),
    )
    expect(result.firing.map((f) => f.alertId)).toContain('vault_recipient_transferred')
  })

  it('the Venue recipient-change timelock pages BEFORE it executes', () => {
    const soon = new AlertEvaluator().evaluate(
      signals((s) => {
        s.chain.pendingRecipientChangeProposals = [{ token: '0xt', proposedAtUnix: AT - DAY, effectiveAtUnix: AT + 6 * HOUR }]
      }),
    )
    expect(soon.firing.map((f) => f.alertId)).toContain('venue_recipient_change_timelock_firing')

    const distant = new AlertEvaluator().evaluate(
      signals((s) => {
        s.chain.pendingRecipientChangeProposals = [{ token: '0xt', proposedAtUnix: AT, effectiveAtUnix: AT + 10 * DAY }]
      }),
    )
    expect(distant.firing.map((f) => f.alertId)).not.toContain('venue_recipient_change_timelock_firing')
  })

  it('a paused quote asset pages and disables the asset', () => {
    const result = new AlertEvaluator().evaluate(
      signals((s) => {
        s.chain.pausedQuoteAssets = [{ asset: '0xa', symbol: 'USDG', strandedEscrowUsd: 41_000, pausedAtUnix: AT - 300 }]
      }),
    )
    const firing = result.firing.find((f) => f.alertId === 'quote_asset_proxy_paused')
    expect(firing?.autoAction).toBe('disable_quote_asset')
    expect(firing?.facts.stranded_escrow_usd).toBe(41_000)
  })

  it('a single disclosure read-back failure halts publishing', () => {
    const result = new AlertEvaluator().evaluate(
      signals((s) => {
        s.publishing.publishesLastHour = 40
        s.publishing.readBackFailuresLastHour = 1
      }),
    )
    const firing = result.firing.find((f) => f.alertId === 'disclosure_readback_failure')
    expect(firing?.severity).toBe('page')
    expect(firing?.autoAction).toBe('halt_publishing')
  })

  it('spend-gate denials fire only on a real spike, and name the gate', () => {
    const quiet = new AlertEvaluator().evaluate(
      signals((s) => {
        s.spend.denialsLastHour = 6
        s.spend.denialsPerHourBaseline = 1
      }),
    )
    expect(quiet.firing.map((f) => f.alertId)).not.toContain('spend_gate_denials_spiking')

    const evaluator = new AlertEvaluator()
    const spiking = signals((s) => {
      s.spend.denialsLastHour = 400
      s.spend.denialsPerHourBaseline = 2
      s.spend.denialsByGate = { commitment_rule: 380, vendor_reliability: 20 }
    })
    // forSeconds is 10 minutes, so the first observation is pending.
    expect(evaluator.evaluate(spiking).pending.map((f) => f.alertId)).toContain('spend_gate_denials_spiking')
    const later = { ...spiking, atUnix: AT + 20 * 60 }
    const firing = evaluator.evaluate(later).firing.find((f) => f.alertId === 'spend_gate_denials_spiking')
    expect(firing?.facts.top_gate).toBe('commitment_rule')
  })

  it('injection trips need both a floor and a multiple of baseline', () => {
    const evaluator = new AlertEvaluator()
    const one = evaluator.evaluate(
      signals((s) => {
        s.security.injectionDetectorTripsLastHour = 1
        s.security.injectionTripsBaselinePerHour = 0
      }),
    )
    expect(one.firing.concat(one.pending).map((f) => f.alertId)).not.toContain('injection_detector_trip')

    const wave = evaluator.evaluate(
      signals((s) => {
        s.security.injectionDetectorTripsLastHour = 900
        s.security.injectionTripsBaselinePerHour = 2
      }),
    )
    expect(wave.pending.map((f) => f.alertId)).toContain('injection_detector_trip')
  })

  it('a downgrade raises a ticket per coin', () => {
    const result = new AlertEvaluator().evaluate(
      signals((s) => {
        s.tiers.downgradesLastDay = [
          { vault: '0xv1', from: 'T2', to: 'T1', qfPerDay: 40 },
          { vault: '0xv2', from: 'T1', to: 'T0', qfPerDay: 3 },
        ]
      }),
    )
    expect(result.firing.filter((f) => f.alertId === 'tier_gate_crossed_downward')).toHaveLength(2)
  })

  it('inference cost above the tier COGS throttles the model', () => {
    const evaluator = new AlertEvaluator()
    const snapshot = signals((s) => {
      s.cost.perCoin = [{ vault: '0xv', tier: 'T1', inferenceUsdPerDay: 19.5, tierCogsPerDay: 13 }]
    })
    evaluator.evaluate(snapshot)
    const firing = evaluator
      .evaluate({ ...snapshot, atUnix: AT + 2 * HOUR })
      .firing.find((f) => f.alertId === 'inference_cost_over_tier_cogs')
    expect(firing?.autoAction).toBe('throttle_model')
    expect(firing?.facts.overrun_pct).toBe(50)
  })

  it('does not fire when the coin is inside its tier COGS', () => {
    const result = new AlertEvaluator().evaluate(
      signals((s) => {
        s.cost.perCoin = [{ vault: '0xv', tier: 'T1', inferenceUsdPerDay: 4, tierCogsPerDay: 13 }]
      }),
    )
    expect(result.firing.concat(result.pending)).toHaveLength(0)
  })

  it('warns before the gas subsidy lapses and pages in the last week', () => {
    const monthOut = new AlertEvaluator().evaluate(
      signals((s) => {
        s.chain.gasSubsidyExpiryUnix = AT + 20 * DAY
      }),
    )
    expect(monthOut.firing.find((f) => f.alertId === 'gas_subsidy_expiry_approaching')?.severity).toBe('ticket')

    const daysOut = new AlertEvaluator().evaluate(
      signals((s) => {
        s.chain.gasSubsidyExpiryUnix = AT + 3 * DAY
      }),
    )
    expect(daysOut.firing.find((f) => f.alertId === 'gas_subsidy_expiry_approaching')?.severity).toBe('page')
  })

  it('a stalled sweep pages once past the forced interval', () => {
    const result = new AlertEvaluator().evaluate(
      signals((s) => {
        s.sweeps.stalest = [{ scope: '0xv#0xa', secondsSinceLastSweep: 30 * HOUR, pendingUsd: 900 }]
      }),
    )
    expect(result.firing.map((f) => f.alertId)).toContain('escrow_sweep_stalled')
  })

  it('a stalled scheduler is the alert everything else depends on', () => {
    const result = new AlertEvaluator().evaluate(
      signals((s) => {
        s.ops.lastTickUnix = AT - HOUR
      }),
    )
    const firing = result.firing.find((f) => f.alertId === 'scheduler_tick_stalled')
    expect(firing?.severity).toBe('page')
  })

  it('a dead-letter backlog escalates from ticket to page', () => {
    const small = new AlertEvaluator().evaluate(
      signals((s) => {
        s.ops.openDeadLetters = 6
        s.ops.deadLettersByJob = { 'escrow.sweep': 6 }
      }),
    )
    expect(small.firing.find((f) => f.alertId === 'dead_letter_backlog')?.severity).toBe('ticket')

    const large = new AlertEvaluator().evaluate(
      signals((s) => {
        s.ops.openDeadLetters = 40
        s.ops.deadLettersByJob = { 'escrow.sweep': 40 }
      }),
    )
    expect(large.firing.find((f) => f.alertId === 'dead_letter_backlog')?.severity).toBe('page')
  })

  it('a quiet snapshot fires nothing at all', () => {
    const result = new AlertEvaluator().evaluate(emptySignals(AT))
    expect(result.firing).toEqual([])
    expect(result.pending).toEqual([])
  })
})

describe('the evaluator', () => {
  const varianceSignals = signals((s) => {
    s.ledger.openCriticalVariances = [{ vault: '0xv', asset: '0xa', deltaMinor: '-1', detectedAtUnix: AT }]
  })

  it('suppresses a repeat of the same (alert, scope) inside the window', () => {
    const evaluator = new AlertEvaluator({ repeatSuppressionSeconds: 1800 })
    expect(evaluator.evaluate(varianceSignals).firing).toHaveLength(1)
    const again = evaluator.evaluate({ ...varianceSignals, atUnix: AT + 60 })
    expect(again.firing).toHaveLength(0)
    expect(again.suppressed).toHaveLength(1)
  })

  it('fires again once the suppression window has passed', () => {
    const evaluator = new AlertEvaluator({ repeatSuppressionSeconds: 600 })
    evaluator.evaluate(varianceSignals)
    const again = evaluator.evaluate({
      ...varianceSignals,
      atUnix: AT + 601,
      // Keep the tick fresh, or scheduler_tick_stalled fires alongside it.
      ops: { ...varianceSignals.ops, lastTickUnix: AT + 601 },
    })
    expect(again.firing.map((f) => f.alertId)).toEqual(['ledger_variance_critical'])
  })

  it('resets when the condition clears, so the next occurrence is not swallowed', () => {
    const evaluator = new AlertEvaluator({ repeatSuppressionSeconds: 3600 })
    evaluator.evaluate(varianceSignals)
    evaluator.evaluate(emptySignals(AT + 60))
    expect(evaluator.active()).toEqual([])
    expect(evaluator.evaluate({ ...varianceSignals, atUnix: AT + 120 }).firing).toHaveLength(1)
  })

  it('a broken predicate does not take the other alerts down with it', () => {
    const evaluator = new AlertEvaluator({
      definitions: [
        {
          id: 'sweep_shortfall',
          title: 'broken',
          severity: 'info',
          runbook: 'ops/runbooks/stranded-escrow-balance.md',
          rationale: 'x',
          autoAction: 'none',
          forSeconds: 0,
          evaluate() {
            throw new Error('predicate defect')
          },
        },
        ...ALERTS.filter((a) => a.id === 'ledger_variance_critical'),
      ],
    })
    expect(evaluator.evaluate(varianceSignals).firing.map((f) => f.alertId)).toEqual(['ledger_variance_critical'])
  })
})
