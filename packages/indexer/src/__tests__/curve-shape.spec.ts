/**
 * The CurveBuy / CurveSell parameter names are pinned from live chain evidence,
 * not verified source. This spec re-derives every relation the pin rests on
 * from the captured logs (tools/__tests__/fixtures/curve-trade-live-logs.json,
 * method in tools/artifacts/CURVE-SHAPE.md), so a wrong name here fails loudly
 * instead of silently moving a money figure.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CURVE_BUY, CURVE_SELL, decodeEventLog, decodeLaunchedToken, requireAddress, requireBigInt } from '../abi.js'
import { attributeCurveLog } from '../attribution.js'
import { addressEquals, type Hex } from '../hex.js'
import { VENUE } from '../protocol.js'
import type { RpcLog } from '../rpc.js'
import { binding, hash32 } from './helpers.js'

interface FixtureTransfer {
  readonly token: string
  readonly from: string
  readonly to: string
  readonly value: string
}

interface FixtureLog {
  readonly log: {
    readonly address: string
    readonly topics: readonly Hex[]
    readonly data: Hex
    readonly blockNumber: Hex
    readonly blockHash: Hex
    readonly transactionHash: Hex
    readonly logIndex: Hex
  }
  readonly tx: { readonly from: string; readonly to: string; readonly value: string; readonly isLaunchTx: boolean }
  readonly transfers: readonly FixtureTransfer[]
  readonly traderNativeBalance?: { readonly deltaWei: string; readonly gasCostWei: string }
}

interface FixtureCurve {
  readonly curve: string
  readonly token: string
  readonly pairToken: string
  readonly launchBlock: number
  readonly creatorTaxBps: number
  readonly buybackEnabled: boolean
  readonly getLaunchedTokenReturn: Hex
}

interface Fixture {
  readonly chainId: number
  readonly hookFeeBps: number
  readonly launchFeeWei: string
  readonly nativeQuote: string
  readonly curves: readonly FixtureCurve[]
  readonly logs: readonly FixtureLog[]
}

const fixture = JSON.parse(
  readFileSync(new URL('../../../../tools/__tests__/fixtures/curve-trade-live-logs.json', import.meta.url), 'utf8'),
) as Fixture

const curves = new Map(fixture.curves.map((c) => [c.curve, c]))

interface Trade {
  readonly side: 'buy' | 'sell'
  readonly curve: FixtureCurve
  readonly entry: FixtureLog
  readonly log: RpcLog
  readonly sender: string
  readonly trader: string
  readonly amountIn: bigint
  readonly amountOut: bigint
  readonly fee: bigint
  readonly creatorTax: bigint
  /** Quote-side gross: what the fee and creator tax are taken on. */
  readonly gross: bigint
}

const trades: Trade[] = fixture.logs.map((entry) => {
  const log: RpcLog = {
    ...entry.log,
    blockNumber: BigInt(entry.log.blockNumber),
    logIndex: Number(entry.log.logIndex),
    removed: false,
  }
  const side = entry.log.topics[0] === CURVE_BUY.topic0 ? 'buy' : 'sell'
  const decoded = decodeEventLog(side === 'buy' ? CURVE_BUY : CURVE_SELL, log)
  const curve = curves.get(entry.log.address)
  if (curve === undefined) throw new Error(`fixture log from unknown curve ${entry.log.address}`)
  const amountOut = requireBigInt(decoded, 'amountOut')
  const fee = requireBigInt(decoded, 'fee')
  const creatorTax = requireBigInt(decoded, 'creatorTax')
  const amountIn = requireBigInt(decoded, 'amountIn')
  return {
    side,
    curve,
    entry,
    log,
    sender: requireAddress(decoded, 'sender'),
    trader: requireAddress(decoded, 'trader'),
    amountIn,
    amountOut,
    fee,
    creatorTax,
    gross: side === 'buy' ? amountIn : amountOut + fee + creatorTax,
  }
})

const buys = trades.filter((t) => t.side === 'buy')
const sells = trades.filter((t) => t.side === 'sell')

function transfer(t: Trade, token: string, from: string | undefined, to: string | undefined, value: bigint): boolean {
  return t.entry.transfers.some(
    (x) =>
      addressEquals(x.token, token) &&
      BigInt(x.value) === value &&
      (from === undefined || addressEquals(x.from, from)) &&
      (to === undefined || addressEquals(x.to, to)),
  )
}

describe('curve trade shape, pinned from live chain 4663 logs', () => {
  it('rests on a sample wide enough to pin both sides', () => {
    expect(fixture.chainId).toBe(VENUE.chainId)
    expect(buys.length).toBeGreaterThanOrEqual(20)
    expect(sells.length).toBeGreaterThanOrEqual(20)
    expect(new Set(buys.map((t) => t.curve.curve)).size).toBeGreaterThanOrEqual(5)
    expect(new Set(sells.map((t) => t.curve.curve)).size).toBeGreaterThanOrEqual(5)
    // The fixture's per-curve tax came from getLaunchedToken; decode it the way the indexer does.
    for (const curve of fixture.curves) {
      const launched = decodeLaunchedToken(curve.getLaunchedTokenReturn)
      expect(launched.curve).toBe(curve.curve)
      expect(launched.creatorTaxBps).toBe(curve.creatorTaxBps)
    }
  })

  it('trader is who the memecoin is minted to on a buy and burned from on a sell', () => {
    for (const t of buys) expect(transfer(t, t.curve.token, t.curve.curve, t.trader, t.amountOut)).toBe(true)
    for (const t of sells) expect(transfer(t, t.curve.token, t.trader, t.curve.curve, t.amountIn)).toBe(true)
  })

  it('amountIn on a buy is the gross quote paid: tx.value, the quote Transfer, or value minus the launch fee', () => {
    const launchFee = BigInt(fixture.launchFeeWei)
    let direct = 0
    let viaLaunch = 0
    let viaErc20 = 0
    for (const t of buys) {
      const native = addressEquals(t.curve.pairToken, fixture.nativeQuote)
      if (!native) {
        expect(transfer(t, t.curve.pairToken, undefined, t.curve.curve, t.amountIn)).toBe(true)
        viaErc20++
      } else if (t.entry.tx.isLaunchTx) {
        expect(BigInt(t.entry.tx.value) - t.amountIn).toBe(launchFee)
        viaLaunch++
      } else if (addressEquals(t.entry.tx.to, t.curve.curve) && addressEquals(t.entry.tx.from, t.trader)) {
        expect(BigInt(t.entry.tx.value)).toBe(t.amountIn)
        direct++
      }
    }
    expect(direct).toBeGreaterThanOrEqual(20)
    expect(viaLaunch).toBeGreaterThanOrEqual(5)
    expect(viaErc20).toBeGreaterThanOrEqual(5)
  })

  it('amountOut on a sell is the NET quote the trader received', () => {
    let measured = 0
    for (const t of sells) {
      if (!addressEquals(t.curve.pairToken, fixture.nativeQuote)) {
        expect(transfer(t, t.curve.pairToken, t.curve.curve, t.trader, t.amountOut)).toBe(true)
        measured++
      } else if (t.entry.traderNativeBalance !== undefined) {
        const { deltaWei, gasCostWei } = t.entry.traderNativeBalance
        expect(BigInt(deltaWei)).toBe(t.amountOut - BigInt(gasCostWei))
        measured++
      }
    }
    expect(measured).toBeGreaterThanOrEqual(20)
  })

  it('creatorTax is gross * creatorTaxBps / 10_000 on every log, so it is bps of VOLUME', () => {
    const taxes = new Set<number>()
    for (const t of trades) {
      expect(t.creatorTax).toBe((t.gross * BigInt(t.curve.creatorTaxBps)) / 10_000n)
      taxes.add(t.curve.creatorTaxBps)
    }
    // Zero-tax curves would make the relation vacuous; the sample spans real rates.
    expect([...taxes].filter((bps) => bps > 0).length).toBeGreaterThanOrEqual(4)
  })

  it('fee is hookFeeBps of the gross on every sell and every buy outside the anti-snipe window', () => {
    const fee = (gross: bigint) => (gross * BigInt(fixture.hookFeeBps)) / 10_000n
    for (const t of sells) expect(t.fee).toBe(fee(t.gross))

    let ordinary = 0
    for (const t of buys) {
      if (t.fee === fee(t.gross)) {
        ordinary++
        continue
      }
      // The surcharge only ever adds, and only near launch.
      expect(t.fee).toBeGreaterThan(fee(t.gross))
      expect(Number(t.log.blockNumber) - t.curve.launchBlock).toBeLessThanOrEqual(20)
    }
    expect(ordinary).toBeGreaterThanOrEqual(20)
  })

  it('attributes a live log to the emitting curve with the fee as gross and volume as the gross quote', () => {
    const block = { number: 0n, hash: hash32(0), parentHash: hash32(0), timestampUnix: 1_000_000 }
    for (const t of trades) {
      const bound = binding({
        curve: t.curve.curve,
        token: t.curve.token,
        quoteAsset: t.curve.pairToken,
        creatorTaxBps: t.curve.creatorTaxBps,
        buybackEnabled: t.curve.buybackEnabled,
      })
      const posting = attributeCurveLog(t.log, bound, block)
      expect(posting.side).toBe(t.side)
      expect(posting.counterparty).toBe(t.trader)
      expect(posting.grossFeeMinor).toBe(t.fee)
      expect(posting.volumeMinor).toBe(t.gross)
      expect(posting.asset).toBe(t.curve.pairToken)
      const effectiveBps = (t.fee * 10_000n) / t.gross
      expect(posting.classification).toBe(effectiveBps > 2n * BigInt(VENUE.hookFeeBps) ? 'anti_snipe_window' : 'trade')
    }
  })
})
