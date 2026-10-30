import { describe, expect, it } from 'vitest'
import { QUALIFICATION_FLOOR_MONTHLY_USD, TIERS } from '../../../../config/protocol.js'
import { CoinTicker } from '../coin.js'
import { InMemoryFleetCounters, Orchestrator } from '../fleet.js'
import { evaluateTier, monthlyProcurementUsd, qfOnlyTier } from '../tiers.js'
import { accruePostings } from '../accrual.js'
import { attemptSpend } from '../spend.js'
import { buildBudgetLedgerView, buildSpendCounters } from '../budget.js'
import { RECEIPT_PUBLISH_LAG_SECONDS, procurementReceipt } from '../receipts.js'
import { decideCadence } from '../schedule.js'
import { RATE_LIMITS } from '@fee-split-vaults/broker'
import type { QfMeasurement } from '@fee-split-vaults/core'
import {
  COIN,
  DAY,
  LISTING_SKU,
  NOW,
  OTHER_COIN,
  T0,
  TOKEN,
  TREASURY,
  USDG,
  VAULT,
  VENDOR_PAYOUT,
  dailyPostings,
  makeAsset,
  makeHarness,
  makeScreening,
  makeSignals,
  makeVault,
  seedWindow,
  usdgPrice,
  warmUp,
} from './harness.js'

/** One listing. The rationale is advisory text and is never parsed for a value. */
function purchase(): Array<{ name: string; input: unknown }> {
  return [
    {
      name: 'propose_purchase',
      input: {
        skuId: LISTING_SKU,
        quantity: 1,
        rationale: 'a listing answers the how-to-buy backlog',
      },
    },
  ]
}

/** A healthy desk client: sitting on the T1 gate, whatever the gate is today. */
function qf(overrides: Partial<QfMeasurement> = {}): QfMeasurement {
  return {
    vault: VAULT,
    qfPerDay: TIERS.T1.gateQfPerDay,
    observedDays: 14,
    sustainedDays: 14,
    measuredAtUnix: NOW - 600,
    perAsset: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------

describe('the pipeline runs end to end', () => {
  it('accrues chain postings into the ledger, measures QF, and holds the tier', async () => {
    const h = makeHarness()
    const result = await h.ticker.tick()

    expect(result.refusals.map((r) => r.code)).not.toContain('accrual_failed')
    expect(result.accrual?.recognized).toBeGreaterThan(0)
    expect(result.qf).toBeDefined()
    // The harness pays exactly the T1 gate every day, so the measured median is
    // the gate and the tier the coin already holds is the tier it keeps.
    expect(result.qf?.qfPerDay).toBeCloseTo(TIERS.T1.gateQfPerDay, 6)
    expect(result.tier?.tier).toBe('T1')
    expect(result.tier?.direction).toBe('hold')

    // The ledger balances per asset, which is the property that catches a
    // silently lost fee.
    const verification = await h.ledger.verifyBalances({ vault: VAULT, asset: USDG })
    expect(verification.ok).toBe(true)
  })

  it('is idempotent: a second tick over the same postings recognises nothing new', async () => {
    const h = makeHarness()
    await h.ticker.tick()
    const before = await h.ledger.balanceOf(VAULT, USDG, 'income:fees')

    h.clock.set(NOW + 7_200)
    const second = await h.ticker.tick()
    const after = await h.ledger.balanceOf(VAULT, USDG, 'income:fees')

    expect(after).toBe(before)
    expect(second.accrual?.recognized ?? 0).toBe(0)
    expect(second.accrual?.replayed ?? 0).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------

describe('tier gating', () => {
  it('a one-day wash spike does not clear a gate that a median measures', () => {
    // Six silent days and one enormous one. The MEAN is $10,000/day, which
    // clears T2 outright. The MEDIAN is $0/day, which grants nothing.
    const spike = qf({ qfPerDay: 0, sustainedDays: 0, observedDays: 7 })
    expect(qfOnlyTier(spike.qfPerDay)).toBe('T0')

    const decision = evaluateTier({
      currentTier: 'T0',
      qf: spike,
      signals: makeSignals(),
      screening: makeScreening(),
      budgetBps: 2_000,
      buybackEnabled: false,
      creatorTaxBps: 0,
      nowUnix: NOW,
    })
    expect(decision.tier).toBe('T0')
  })

  it('an upgrade needs sustain AND breadth, not just the QF number', () => {
    const base = {
      currentTier: 'T1' as const,
      qf: qf({ qfPerDay: TIERS.T2.gateQfPerDay, sustainedDays: 3 }),
      screening: makeScreening(),
      budgetBps: 2_000,
      buybackEnabled: false,
      creatorTaxBps: 0,
      nowUnix: NOW,
    }

    expect(evaluateTier({ ...base, signals: makeSignals() }).direction).toBe('hold')

    const sustained = { ...base, qf: qf({ qfPerDay: TIERS.T2.gateQfPerDay, sustainedDays: 14 }) }
    // Sustained but concentrated: still held.
    expect(
      evaluateTier({ ...sustained, signals: makeSignals({ top10HolderSharePct: 90 }) }).direction,
    ).toBe('hold')
    // Sustained, broad, deconcentrated: granted.
    expect(evaluateTier({ ...sustained, signals: makeSignals() }).tier).toBe('T2')
  })

  it('unavailable signals block an upgrade rather than passing as clean', () => {
    const decision = evaluateTier({
      currentTier: 'T1',
      qf: qf({ qfPerDay: TIERS.T2.gateQfPerDay, sustainedDays: 20 }),
      screening: makeScreening(),
      budgetBps: 2_000,
      buybackEnabled: false,
      creatorTaxBps: 0,
      nowUnix: NOW,
    })
    expect(decision.direction).toBe('hold')
    expect(decision.reasons).toContain('signals_unavailable')
  })

  it('downgrades immediately when QF falls, and to T0 when QF is stale', () => {
    const fallen = evaluateTier({
      currentTier: 'T2',
      qf: qf({ qfPerDay: TIERS.T1.gateQfPerDay + 1, sustainedDays: 20 }),
      signals: makeSignals(),
      screening: makeScreening(),
      budgetBps: 2_000,
      buybackEnabled: false,
      creatorTaxBps: 0,
      nowUnix: NOW,
    })
    expect(fallen.direction).toBe('downgrade')
    expect(fallen.tier).toBe('T1')

    const stale = evaluateTier({
      currentTier: 'T2',
      qf: qf({ measuredAtUnix: NOW - 5 * DAY }),
      signals: makeSignals(),
      screening: makeScreening(),
      budgetBps: 2_000,
      buybackEnabled: false,
      creatorTaxBps: 0,
      nowUnix: NOW,
    })
    expect(stale.tier).toBe('T0')
    expect(stale.reasons).toContain('qf_measurement_stale')
  })

  it('the volume a gate needs branches on the token buyback flag', () => {
    const common = {
      currentTier: 'T1' as const,
      qf: qf(),
      signals: makeSignals(),
      screening: makeScreening(),
      budgetBps: 2_000,
      creatorTaxBps: 0,
      nowUnix: NOW,
    }
    const off = evaluateTier({ ...common, buybackEnabled: false }).volumeForCurrentGate
    const on = evaluateTier({ ...common, buybackEnabled: true }).volumeForCurrentGate

    // Buyback halves the creator's net, so the same QF needs twice the volume.
    expect(on).toBeCloseTo(off * 2, 6)
  })

  it('a BLOCKED screening drops the coin to T0 and stops all operations', () => {
    const decision = evaluateTier({
      currentTier: 'T3',
      qf: qf({ qfPerDay: 50_000 }),
      signals: makeSignals(),
      screening: makeScreening({ verdict: 'BLOCKED', paidMediaPermitted: false }),
      budgetBps: 2_000,
      buybackEnabled: false,
      creatorTaxBps: 0,
      nowUnix: NOW,
    })
    expect(decision.tier).toBe('T0')
    expect(decision.operationsPermitted).toBe(false)
  })

  it('a tier whose procurement slice cannot buy anything is not offered', () => {
    // The floor binds on the DIAL, not on QF alone: the monthly slice is
    // qf * dial * 30 / 10_000, so at any given QF there is exactly one dial at
    // which it first covers QUALIFICATION_FLOOR_MONTHLY_USD. Derive that dial
    // from the gate and the floor and straddle it, rather than restating a
    // worked example that only held while both numbers stood still.
    const gate = TIERS.T1.gateQfPerDay
    const dialAtFloor = Math.ceil((QUALIFICATION_FLOOR_MONTHLY_USD * 10_000) / (gate * 30))
    expect(monthlyProcurementUsd(gate, dialAtFloor)).toBeGreaterThanOrEqual(
      QUALIFICATION_FLOOR_MONTHLY_USD,
    )
    expect(monthlyProcurementUsd(gate, dialAtFloor - 1)).toBeLessThan(
      QUALIFICATION_FLOOR_MONTHLY_USD,
    )

    const base = {
      currentTier: 'T0' as const,
      qf: qf({ qfPerDay: gate, sustainedDays: 14 }),
      signals: makeSignals(),
      screening: makeScreening(),
      buybackEnabled: false,
      creatorTaxBps: 0,
      nowUnix: NOW,
    }

    const cleared = evaluateTier({ ...base, budgetBps: dialAtFloor })
    expect(cleared.tier).toBe('T1')

    const unaffordable = evaluateTier({ ...base, budgetBps: dialAtFloor - 1 })
    expect(unaffordable.tier).toBe('T0')
    expect(unaffordable.reasons).toContain('next_tier_below_qualification_floor')
  })
})

// ---------------------------------------------------------------------------

describe('fail closed', () => {
  it('a disabled quote asset stops the money, not just the spend gate', async () => {
    const h = makeHarness()
    await warmUp(h)
    const settledBefore = h.settlement.submitted.length

    // The per-asset kill switch: a paused issuer proxy strands escrow, so the
    // asset stops backing budget authority. QF excludes it, the tier falls, and
    // nothing downstream can spend against it.
    h.assets.setEnabled(USDG, false)
    h.script.calls = purchase()

    const result = await h.ticker.tick()
    expect(result.qf?.qfPerDay).toBe(0)
    expect(result.tier?.tier).toBe('T0')
    expect(h.settlement.submitted).toHaveLength(settledBefore)
  })

  it('the spend gate itself also refuses a disabled asset', async () => {
    const h = makeHarness()
    await warmUp(h)
    const vault = await h.vaults.get(VAULT)
    if (vault === undefined) throw new Error('fixture')

    const outcome = await attemptSpend(
      { ...h.deps.spend, ledger: h.ledger, fleet: h.fleet },
      {
        proposal: {
          vault: VAULT,
          skuId: LISTING_SKU,
          quantity: 1,
          rationale: 'a listing answers the how-to-buy backlog',
          proposedAtUnix: h.clock.nowUnix(),
        },
        vault,
        asset: makeAsset({ enabled: false }),
        price: usdgPrice(h.clock.nowUnix() - 30),
        ledgerView: await buildBudgetLedgerView({
          ledger: h.ledger,
          store: h.ledgerStore,
          vault: VAULT,
          asset: makeAsset(),
          price: usdgPrice(h.clock.nowUnix() - 30),
          unfinalizedPostings: [],
          budgetBps: 2_000,
          inferenceChargedMinor: 0n,
          categorySpendCents: {},
          outstandingObligationsMinor: 0n,
          nowUnix: h.clock.nowUnix(),
        }),
        qf: qf(),
        signals: makeSignals(),
        screening: makeScreening(),
        counters: await buildSpendCounters({
          fleet: h.fleet,
          vault: VAULT,
          vendorId: 'dexscreener',
          nowUnix: h.clock.nowUnix(),
        }),
        relatedPartyOptIn: false,
        nowUnix: h.clock.nowUnix(),
      },
    )
    expect(outcome.code).toBe('asset_kill_switch')
    expect(outcome.status).toBe('refused')
  })

  it('denies paid media when no screening is on file, and escalates', async () => {
    const h = makeHarness({ screening: null })
    const result = await h.ticker.tick()
    expect(result.refusals.map((r) => r.code)).toContain('screening_missing')
    expect(h.escalations.byKind('screening_missing')).toHaveLength(1)
    expect(result.tier?.paidMediaPermitted).toBe(false)
  })

  it('stops spending while an indexer halt is open', async () => {
    const h = makeHarness()
    await warmUp(h)
    h.script.calls = purchase()
    h.chain.putHalt(TOKEN, {
      reason: 'recipient_diverged',
      token: TOKEN,
      vault: VAULT,
      detail: 'fee recipient is not our vault',
      observedAtUnix: NOW - 60,
    } as never)

    const before = h.settlement.submitted.length
    const result = await h.ticker.tick()
    expect(h.escalations.byKind('indexer_halt').length).toBeGreaterThan(0)
    expect(h.settlement.submitted).toHaveLength(before)

    // The first of the three layers: with spend authority suspended the
    // purchase tool is not OFFERED at all, so the model has no way to express
    // a purchase and the attempt shows up as a rejected tool call, not as a
    // proposal that a later gate had to catch.
    expect(result.window?.proposals.some((p) => p.kind === 'purchase')).toBe(false)
    expect(result.window?.violations.map((v) => v.toolName)).toContain('propose_purchase')
  })

  it('refuses when a posting names an asset nobody registered', async () => {
    const h = makeHarness()
    const rogue = dailyPostings(1, 100).map((p) => ({
      ...p,
      id: '0xrogue:0',
      asset: '0xdeadbeef00000000000000000000000000000000',
    }))
    h.chain.putPostings(...rogue)

    const result = await h.ticker.tick()
    expect(result.refusals.map((r) => r.code)).toContain('unknown_asset')
  })

  it('records a settlement failure instead of writing a ledger entry for it', async () => {
    const h = makeHarness()
    await warmUp(h)
    const spentBefore = await h.ledger.balanceOf(VAULT, USDG, 'expense:procurement')
    h.settlement.failNext()
    h.script.calls = purchase()

    const result = await h.ticker.tick()
    expect(result.spends[0]?.status).toBe('settlement_failed')
    expect(await h.ledger.balanceOf(VAULT, USDG, 'expense:procurement')).toBe(spentBefore)
  })
})

// ---------------------------------------------------------------------------

describe('per-coin isolation', () => {
  it('refuses a message stamped for another coin rather than filtering it out', async () => {
    const h = makeHarness()
    h.messages.add({
      sourceId: 's1',
      authorId: 'a1',
      text: 'where do I buy',
      postedAtUnix: NOW - 1_000,
      origin: 'telegram',
      boundCoinRef: OTHER_COIN,
    })
    const result = await h.ticker.tick()
    expect(result.refusals.some((r) => r.code === 'coin_isolation')).toBe(true)
    expect(result.ranCognition).toBe(false)
  })

  it('the fleet refuses to register the same coinRef twice', () => {
    const fleet = new Orchestrator()
    const a = makeHarness()
    fleet.register(a.config, a.deps, 'T1')
    expect(() => fleet.register(a.config, a.deps, 'T1')).toThrow(/already registered/)
  })

  it('two coins get different hashed user ids and separate cost governors', () => {
    const a = makeHarness({ coinRef: COIN })
    const b = makeHarness({ coinRef: OTHER_COIN })
    expect(a.ticker.costGovernor).not.toBe(b.ticker.costGovernor)
    expect(a.ticker.divergence).not.toBe(b.ticker.divergence)
    expect(a.ticker.coinRef).not.toBe(b.ticker.coinRef)
  })

  it('require() throws for a coin the fleet does not hold', () => {
    const fleet = new Orchestrator()
    expect(() => fleet.require('coin_nobody')).toThrow(/no ticker registered/)
  })
})

// ---------------------------------------------------------------------------

describe('the fixed schedule', () => {
  it('processes a closed window exactly once, however many times it is ticked', async () => {
    const h = makeHarness()
    const first = await h.ticker.tick()
    expect(first.ranCognition || first.refusals.some((r) => r.phase === 'cognition')).toBe(true)

    // Same window, ticked again a minute later: no second cognition run.
    h.clock.set(NOW + 60)
    const second = await h.ticker.tick()
    expect(second.ranCognition).toBe(false)
  })

  it('has no wake-on-mention path: the window is a pure function of the clock', () => {
    const quiet = decideCadence(NOW, {
      coinRef: COIN,
      ageSeconds: 60 * DAY,
      spendAuthorityActive: true,
      sweepIntervalSeconds: 3_600,
    })
    const flooded = decideCadence(NOW, {
      coinRef: COIN,
      ageSeconds: 60 * DAY,
      spendAuthorityActive: true,
      sweepIntervalSeconds: 3_600,
    })
    expect(flooded.cognitionWindow?.windowId).toBe(quiet.cognitionWindow?.windowId)
  })

  it('a spending vault is polled at least as often as it can sweep', () => {
    const old = decideCadence(NOW, {
      coinRef: COIN,
      // A 200-day-old coin sits in the weekly band; the sweep floor overrides.
      ageSeconds: 200 * DAY,
      spendAuthorityActive: true,
      sweepIntervalSeconds: 3_600,
    })
    expect(old.chainIntervalSeconds).toBeLessThanOrEqual(3_600)
  })
})

// ---------------------------------------------------------------------------

describe('receipts', () => {
  it('withholds an undelivered commitment for 72 hours and publishes a delivered one at once', () => {
    const base = {
      id: 'db_1',
      vault: VAULT,
      skuId: LISTING_SKU,
      vendorId: 'dexscreener',
      costUsd: 299,
      invoiceHash: '0xabc',
      disbursedAtUnix: NOW,
      predicateResults: [],
    }
    const pending = procurementReceipt({
      vault: VAULT,
      disbursement: base,
      delivered: false,
      description: 'listing',
    })
    const delivered = procurementReceipt({
      vault: VAULT,
      disbursement: base,
      delivered: true,
      description: 'listing',
    })

    expect(pending.publishAfterUnix - pending.occurredAtUnix).toBe(RECEIPT_PUBLISH_LAG_SECONDS)
    expect(delivered.publishAfterUnix).toBe(delivered.occurredAtUnix)
  })
})

// ---------------------------------------------------------------------------

describe('rule 3: no third-party payee', () => {
  it('disburses to the operator treasury and never to a vendor', async () => {
    const h = makeHarness()
    await warmUp(h)
    h.script.calls = purchase()

    const result = await h.ticker.tick()
    expect(result.spends[0]?.status).toBe('disbursed')
    expect(h.settlement.submitted.length).toBeGreaterThan(0)
    for (const pull of h.settlement.submitted) {
      expect(pull.destination).toBe(TREASURY)
      expect(pull.destination).not.toBe(VENDOR_PAYOUT)
    }
  })

  it('writes a procurement receipt withheld for the publication lag', async () => {
    const h = makeHarness()
    await warmUp(h)
    h.script.calls = purchase()
    const result = await h.ticker.tick()
    expect(result.spends[0]?.status).toBe('disbursed')

    const now = h.clock.nowUnix()
    const published = await h.receipts.list(VAULT, { publishedOnly: true, nowUnix: now })
    const all = await h.receipts.list(VAULT, { publishedOnly: false, nowUnix: now })
    expect(all.length).toBeGreaterThan(0)
    expect(published).toHaveLength(0)

    const later = await h.receipts.list(VAULT, {
      publishedOnly: true,
      nowUnix: now + RECEIPT_PUBLISH_LAG_SECONDS + 1,
    })
    expect(later.length).toBe(all.length)
  })

  it('the ledger still balances per asset after a disbursement', async () => {
    const h = makeHarness()
    await warmUp(h)
    h.script.calls = purchase()
    await h.ticker.tick()
    const verification = await h.ledger.verifyBalances({ vault: VAULT, asset: USDG })
    expect(verification.ok).toBe(true)
  })
})

describe('the commitment rule', () => {
  it('refuses a purchase the coin has not banked, whatever the model proposes', async () => {
    // Fees accrued but never claimed or split: nothing is in the budget leg.
    const h = makeHarness({ settle: false })
    await warmUp(h)
    h.script.calls = purchase()

    const result = await h.ticker.tick()
    expect(result.spends[0]?.status).toBe('refused')
    expect(result.spends[0]?.code).toMatch(/solvency|commitment_rule|lifetime_cap|rolling_cap/)
    expect(h.settlement.submitted).toHaveLength(0)
  })

  it('a settlement stamped past midnight still counts against TODAY’s cap', async () => {
    // THE TWO CLOCKS. Every daily money gate is a write and a read against a
    // UTC day key: attemptSpend writes fleet.recordDisbursement, and the gates
    // read vendorSpendTodayCents(vendorId, nowUnix) and disbursementsToday(
    // nowUnix) back out. The write must be stamped with the SAME clock the read
    // uses - the tick clock. A settlement receipt is not that clock: it is a
    // block timestamp reported from outside, and it drifts.
    //
    // Here the tick clock sits twenty-eight minutes before a UTC midnight and
    // the settlement receipt lands two minutes after it. That is a completely
    // ordinary amount of drift, and it is enough: stamp the counter with the
    // receipt and every disbursement this coin makes tonight is filed under
    // TOMORROW, so tonight's counter reads zero and the per-vendor daily cap -
    // two - never binds however many times the desk buys.
    const dayEnd = T0 + DAY
    const tickNow = dayEnd - 1_680
    const h = makeHarness({
      nowUnix: tickNow,
      postings: dailyPostings(14, TIERS.T1.gateQfPerDay, tickNow),
      settlementNowUnix: () => dayEnd + 120,
    })
    await warmUp(h)

    const vault = await h.vaults.get(VAULT)
    if (vault === undefined) throw new Error('fixture')
    expect(new Date(tickNow * 1_000).getUTCDate()).not.toBe(
      new Date((dayEnd + 120) * 1_000).getUTCDate(),
    )

    // One more attempt than the cap allows. Each carries its own proposedAtUnix
    // so it is a distinct purchase rather than a replay of the one before.
    const attempts = RATE_LIMITS.disbursementsPerDayPerVendorPerVault + 1
    const outcomes = []
    for (let i = 0; i < attempts; i += 1) {
      const price = usdgPrice(tickNow - 30)
      outcomes.push(
        await attemptSpend(
          { ...h.deps.spend, ledger: h.ledger, fleet: h.fleet },
          {
            proposal: {
              vault: VAULT,
              skuId: LISTING_SKU,
              quantity: 1,
              rationale: 'a listing answers the how-to-buy backlog',
              proposedAtUnix: tickNow - attempts + i,
            },
            vault,
            asset: makeAsset(),
            price,
            ledgerView: await buildBudgetLedgerView({
              ledger: h.ledger,
              store: h.ledgerStore,
              vault: VAULT,
              asset: makeAsset(),
              price,
              unfinalizedPostings: [],
              budgetBps: 2_000,
              inferenceChargedMinor: 0n,
              // Empty on purpose: the category sub-cap is a share of the period
              // budget and would bite on the third listing of a fourteen-day
              // book, which would mask the gate this test is about.
              categorySpendCents: {},
              outstandingObligationsMinor: 0n,
              nowUnix: tickNow,
            }),
            qf: qf(),
            signals: makeSignals(),
            screening: makeScreening(),
            // Counted fresh each attempt, which is what the ticker does.
            counters: await buildSpendCounters({
              fleet: h.fleet,
              vault: VAULT,
              vendorId: 'dexscreener',
              nowUnix: tickNow,
            }),
            relatedPartyOptIn: false,
            nowUnix: tickNow,
          },
        ),
      )
    }

    // The cap's worth of purchases went through...
    const disbursed = outcomes.filter((o) => o.status === 'disbursed')
    expect(disbursed).toHaveLength(RATE_LIMITS.disbursementsPerDayPerVendorPerVault)

    // ...and the one over the cap was refused, by the daily limiter, naming the
    // vendor. Stamp the counter with settledAtUnix instead of the tick clock
    // and this one disburses too: the money moves and no gate ever objects.
    const last = outcomes[outcomes.length - 1]
    expect(last?.status).toBe('refused')
    expect(last?.code).toBe('rate_limit')
    expect(last?.detail).toContain('dexscreener')
    expect(h.settlement.submitted).toHaveLength(
      RATE_LIMITS.disbursementsPerDayPerVendorPerVault,
    )
  })

  it('the rolling cap stops a coin spending its whole book in one stretch', async () => {
    // A coin that KEEPS EARNING while the loop runs. The default fixture stops
    // paying at NOW, and a coin that stops paying is stopped by the tier gate
    // (sustainedDays falls to 0 the moment the clock passes the last fee day),
    // which is a different refusal than the one under test. Thirty-four days of
    // fees ending four days out keeps QF, the tier and the accrual series
    // healthy across every window the loop walks, so the only thing left that
    // can stop the spending is a spend cap.
    //
    // Thirty days of HISTORY is also what makes the rolling cap the binding
    // cap rather than the category sub-cap. Both are shares of accrual: the
    // rolling cap is 60% of the median daily accrual over 14 days (8.4 medians)
    // and the listing sub-cap is 30% of the 30-day period budget (9 medians).
    // The rolling cap is the tighter of the two only once a full period of
    // accrual exists; on a 14-day-old book the sub-cap would bite first and
    // this test would pass while proving the wrong gate.
    const h = makeHarness({
      postings: dailyPostings(34, TIERS.T1.gateQfPerDay, NOW + 4 * DAY),
    })
    await warmUp(h)
    h.script.calls = purchase()

    // TWELVE HOURS a window, not thirty minutes.
    //
    // The fleet counters are keyed to a UTC day, and RATE_LIMITS caps a vendor
    // at two disbursements per vault per day. A loop that stays inside one day
    // is stopped by that limiter after the second purchase and never reaches a
    // cap at all - which is exactly what this test did while spend.ts stamped
    // fleet.recordDisbursement with the settlement clock instead of the tick
    // clock: the counter was written into a different UTC day from the one the
    // gates read, so the daily limiter never saw a thing and the loop ran on
    // until the rolling cap caught it. Stepping half a day lets the daily
    // limiter reset between purchases, so the cap is what has to stop this.
    //
    // How many windows the cap takes is a function of the tier gate the fixture
    // pays, the dial and the SKU price, so the loop runs UNTIL it bites. The
    // bound is a termination guard, not the expectation.
    const codes: string[] = []
    for (let i = 0; i < 24 && !codes.includes('rolling_cap'); i += 1) {
      const now = h.clock.nowUnix()
      h.prices.pin(usdgPrice(now - 30))
      seedWindow(h.messages, h.config.coinRef, Math.floor(now / 1_800) * 1_800 - 1_800)
      const result = await h.ticker.tick()
      for (const spend of result.spends) codes.push(spend.code)
      h.clock.set(now + 43_200)
    }

    // It really was spending, and the rolling cap is what stopped it.
    expect(codes).toContain('disbursed')
    expect(codes).toContain('rolling_cap')

    // ...and the rolling cap is the FIRST thing that stopped it: nothing was
    // refused before it. A daily rate limit or a sub-cap firing earlier would
    // mean the loop never put the rolling cap under load.
    expect(codes.indexOf('rolling_cap')).toBe(codes.lastIndexOf('disbursed') + 1)

    // More disbursements than one UTC day is allowed to authorize, so the run
    // genuinely crossed the daily limiter instead of being held under it.
    const disbursed = codes.filter((c) => c === 'disbursed').length
    expect(disbursed).toBeGreaterThan(RATE_LIMITS.disbursementsPerDayPerVendorPerVault)
  })

  it('the category sub-cap accumulates across ticks instead of re-checking one invoice', async () => {
    // THE SUB-CAP USED TO BE INERT ON THIS PATH, AND ONLY ON THIS PATH.
    //
    // `categorySubcapGate` bounds one category at a share of the period budget
    // - 30% for listings - by comparing `spent + quote` against it. `spent`
    // arrives in the BudgetLedgerView, and `CoinTicker.#runSpends` built that
    // view with `categorySpendMinor: {}` hardcoded. An empty map means every
    // purchase is measured as though it were the first one in its category, so
    // the gate only ever asked "is ONE listing under the cap?" - which it
    // always is - and never "is this coin's listing spend under the cap?".
    // A coin could therefore buy listings indefinitely, each invoice
    // comfortably inside the sub-cap, and pass through the ceiling in
    // aggregate. Nothing else accumulates per category, so nothing else caught
    // it; the rolling cap is a different, looser bound over all categories at
    // once.
    //
    // FOURTEEN DAYS OF BOOK, deliberately, and this is what makes the sub-cap
    // the binding gate. Both caps are shares of accrual: the listing sub-cap is
    // 30% of the period budget and the rolling cap is 60% of the 14-day median
    // over 14 days (8.4 medians). On a full 30-day book the period budget is 30
    // medians, so the sub-cap is 9 medians and the rolling cap bites first -
    // that is the fixture the rolling-cap test above uses, for exactly that
    // reason. On a 14-day book the period budget is only 14 medians, the
    // sub-cap is 4.2 medians, and it is the tighter of the two. Fees run four
    // days past the loop so the tier gate and the accrual series stay healthy
    // and a spend cap is the only thing left that can stop the spending.
    const h = makeHarness({
      postings: dailyPostings(14, TIERS.T1.gateQfPerDay, NOW + 4 * DAY),
    })
    await warmUp(h)
    h.script.calls = purchase()

    // Half-day steps, as above, so the per-vendor daily limiter resets between
    // purchases and cannot be what stops the run.
    const codes: string[] = []
    for (let i = 0; i < 24 && !codes.includes('category_subcap'); i += 1) {
      const now = h.clock.nowUnix()
      h.prices.pin(usdgPrice(now - 30))
      seedWindow(h.messages, h.config.coinRef, Math.floor(now / 1_800) * 1_800 - 1_800)
      const result = await h.ticker.tick()
      for (const spend of result.spends) codes.push(spend.code)
      h.clock.set(now + 43_200)
    }

    // It really was spending, and the sub-cap is what stopped it.
    expect(codes).toContain('disbursed')
    expect(codes).toContain('category_subcap')

    // The sub-cap is the FIRST refusal: nothing bit before it, so it was the
    // gate genuinely under load rather than a late entry after some other cap
    // had already closed the path.
    expect(codes.indexOf('category_subcap')).toBe(codes.lastIndexOf('disbursed') + 1)

    // AND THIS IS THE ASSERTION THE FIX EXISTS FOR. More than one listing
    // cleared before the cap bit, so the figure the gate compared against grew
    // between purchases. Restore `categorySpendCents: {}` in CoinTicker and
    // this is where it fails: every purchase is re-measured as the first one,
    // the sub-cap never approaches its ceiling, and the loop runs to its bound
    // without ever producing 'category_subcap'.
    const disbursed = codes.filter((c) => c === 'disbursed').length
    expect(disbursed).toBeGreaterThan(1)

    // The refusal names the category and the ceiling it hit, so an operator
    // reading a receipt can tell WHICH bound stopped the desk.
    const refusal = await (async () => {
      const now = h.clock.nowUnix()
      h.prices.pin(usdgPrice(now - 30))
      seedWindow(h.messages, h.config.coinRef, Math.floor(now / 1_800) * 1_800 - 1_800)
      return h.ticker.tick()
    })()
    expect(refusal.spends[0]?.code).toBe('category_subcap')
    expect(refusal.spends[0]?.detail).toContain('listing')
    expect(refusal.spends[0]?.detail).toContain('sub-cap')
  })
})

// ---------------------------------------------------------------------------

describe('the per-category spend counter', () => {
  it('buckets by category, so one category cannot spend another’s room', async () => {
    const fleet = new InMemoryFleetCounters()
    const record = (category: 'listing' | 'kol', amountCents: bigint): Promise<void> =>
      fleet.recordDisbursement({
        vault: VAULT,
        vendorId: 'dexscreener',
        amountCents,
        isRelatedParty: false,
        category,
        atUnix: NOW,
      })

    await record('listing', 29_900n)
    await record('listing', 10_100n)
    await record('kol', 5_000n)

    const totals = await fleet.categorySpend30dCents(VAULT, NOW)
    expect(totals.listing).toBe(40_000n)
    expect(totals.kol).toBe(5_000n)
    // A category nothing was bought in is ABSENT, which the port defines as a
    // measured zero. It is not reported as an explicit 0n it never observed.
    expect(totals.boost).toBeUndefined()
  })

  it('scopes to one vault and to the thirty-day period', async () => {
    const fleet = new InMemoryFleetCounters()
    const other = '0x9999999999999999999999999999999999999999' as const
    const base = {
      vendorId: 'dexscreener',
      amountCents: 1_000n,
      isRelatedParty: false,
      category: 'listing' as const,
    }

    await fleet.recordDisbursement({ ...base, vault: VAULT, atUnix: NOW })
    // Another coin's spend. A sub-cap is one client's budget, and a counter
    // that mixed two coins would refuse one coin for another's purchases.
    await fleet.recordDisbursement({ ...base, vault: other, atUnix: NOW })
    // Just outside the window: the period is trailing, so this has aged out.
    await fleet.recordDisbursement({ ...base, vault: VAULT, atUnix: NOW - 31 * DAY })

    expect((await fleet.categorySpend30dCents(VAULT, NOW)).listing).toBe(1_000n)
    expect((await fleet.categorySpend30dCents(other, NOW)).listing).toBe(1_000n)
  })
})

// ---------------------------------------------------------------------------

describe('accrual precedence', () => {
  it('two sweeps on one day accumulate rather than deduplicating each other', async () => {
    const h = makeHarness({ postings: [] })
    const [first] = dailyPostings(1, 100)
    if (first === undefined) throw new Error('fixture')
    const second = { ...first, id: '0xtx0001:0', txHash: '0xtx0001', logIndex: 0 }

    await accruePostings(h.ledger, [first, second], h.assets)
    // Debit-positive storage, so a credit-normal income account reads negative.
    expect(await h.ledger.balanceOf(VAULT, USDG, 'income:fees')).toBe(-200_000_000n)
  })

  it('a lower-precedence view of an already-recognised day posts nothing new', async () => {
    const h = makeHarness({ postings: [] })
    const [curve] = dailyPostings(1, 100)
    if (curve === undefined) throw new Error('fixture')
    const curveView = {
      ...curve,
      source: 'curve_event' as const,
      phase: 'pre_graduation' as const,
      side: 'buy' as const,
    }

    await accruePostings(h.ledger, [curveView], h.assets)
    const afterCurve = await h.ledger.balanceOf(VAULT, USDG, 'income:fees')

    // The declared order is curve_event > pool_fees_swept, so a sweep view of a
    // day already recognised from the curve is recorded and posts nothing.
    const sweepView = { ...curve, id: '0xsweep:0', txHash: '0xsweep' }
    const result = await accruePostings(h.ledger, [sweepView], h.assets)
    expect(await h.ledger.balanceOf(VAULT, USDG, 'income:fees')).toBe(afterCurve)
    expect(result.recognized).toBe(0)
  })

  it('re-feeding the exact same posting is a byte-identical no-op', async () => {
    const h = makeHarness({ postings: [] })
    const postings = dailyPostings(3, 100)
    await accruePostings(h.ledger, postings, h.assets)
    const before = await h.ledger.balanceOf(VAULT, USDG, 'income:fees')

    const again = await accruePostings(h.ledger, postings, h.assets)
    expect(await h.ledger.balanceOf(VAULT, USDG, 'income:fees')).toBe(before)
    expect(again.replayed).toBe(postings.length)
    expect(again.recognized).toBe(0)
  })
})

// ---------------------------------------------------------------------------

describe('fleet counters', () => {
  it('counts one vendor across the whole book, not per coin', async () => {
    const fleet = new InMemoryFleetCounters()
    await fleet.recordDisbursement({
      vault: VAULT,
      vendorId: 'dexscreener',
      amountCents: 29_900n,
      isRelatedParty: false,
      category: 'listing',
      atUnix: NOW,
    })
    await fleet.recordDisbursement({
      vault: '0x9999999999999999999999999999999999999999',
      vendorId: 'dexscreener',
      amountCents: 29_900n,
      isRelatedParty: false,
      category: 'listing',
      atUnix: NOW,
    })
    expect(await fleet.vendorSpendTodayCents('dexscreener', NOW)).toBe(59_800n)
    expect(await fleet.disbursementsTodayForVault(VAULT, NOW)).toBe(1)
    expect(await fleet.disbursementsToday(NOW)).toBe(2)
  })
})

// ---------------------------------------------------------------------------

describe('the ticker holds no authority it should not', () => {
  it('exposes no method that names a payee, an address, or an amount', () => {
    const methods = Object.getOwnPropertyNames(CoinTicker.prototype)
    expect(methods.sort()).toEqual(['constructor', 'costGovernor', 'divergence', 'tick'].sort())
  })

  it('a T0 coin never calls a model', async () => {
    // Fees far below the T1 gate, so the tier phase cannot upgrade it mid-tick.
    const h = makeHarness({ vault: { tier: 'T0' }, postings: dailyPostings(14, 1) })
    const before = h.model.calls.length
    const result = await h.ticker.tick()
    expect(result.tier?.tier).toBe('T0')
    expect(h.model.calls.length).toBe(before)
    expect(result.refusals.some((r) => r.code === 'tier_has_no_model')).toBe(true)
  })

  it('the vault record is the only thing the tier decision writes', async () => {
    // A registered coin whose credits clear the T1 gate: the upgrade is the
    // point of the test, so the fixture is pinned to the gate, not to a literal.
    const h = makeHarness({
      vault: { tier: 'T0' },
      postings: dailyPostings(14, TIERS.T1.gateQfPerDay),
    })
    await h.ticker.tick()
    const vault = await h.vaults.get(VAULT)
    expect(vault?.tier).toBe('T1')
    expect(vault?.state).toBe(makeVault().state)
  })
})
