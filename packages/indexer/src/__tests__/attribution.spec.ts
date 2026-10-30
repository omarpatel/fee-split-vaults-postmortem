import { describe, expect, it } from 'vitest'
import { attributeFeeLogs, classifyFee, creatorShareOfFee } from '../attribution.js'
import { DecodeError } from '../errors.js'
import { FakeRpcClient } from '../fake-rpc.js'
import { creatorNetBps, VENUE } from '../protocol.js'
import { harness } from './harness.js'
import {
  addr,
  binding,
  curveTradeLog,
  hash32,
  issuedVault,
  launchCoin,
  newChain,
  pinLaunchedToken,
  poolFeesSweptLog,
  poolIdFor,
  poolRegisteredLog,
  usdg,
  USDG,
} from './helpers.js'

describe('creatorShareOfFee', () => {
  const fee = usdg(100)

  it('branches on the token buyback setting instead of assuming one rate', () => {
    const withoutBuyback = creatorShareOfFee(fee, false, 0)
    const withBuyback = creatorShareOfFee(fee, true, 0)

    // 0.70% of volume out of a 1.00% hook fee is 70% of the fee.
    expect(withoutBuyback).toBe((fee * 70n) / 100n)
    // Buyback on halves it. This is the branch a hardcoded 0.70% would miss.
    expect(withBuyback).toBe(withoutBuyback / 2n)
    expect(creatorNetBps(true, 0)).toBeCloseTo(creatorNetBps(false, 0) / 2, 12)
  })

  it('tracks the protocol config rather than a literal', () => {
    const expected = (fee * BigInt(Math.round(creatorNetBps(false, 250) * 1e6))) / (BigInt(VENUE.hookFeeBps) * 1_000_000n)
    expect(creatorShareOfFee(fee, false, 250)).toBe(expected)
  })

  it('floors, so it can never over-credit', () => {
    expect(creatorShareOfFee(1n, false, 0)).toBe(0n)
    expect(creatorShareOfFee(3n, true, 0)).toBe(1n)
  })
})

describe('classifyFee', () => {
  it('flags the 99% anti-snipe window by time', () => {
    expect(
      classifyFee({ feeMinor: usdg(99), volumeMinor: usdg(100), occurredAtUnix: 102, launchedAtUnix: 100 }),
    ).toBe('anti_snipe_window')
  })

  it('flags it by effective rate even when the timestamp says otherwise', () => {
    expect(
      classifyFee({
        feeMinor: usdg(50),
        volumeMinor: usdg(100),
        occurredAtUnix: 100_000,
        launchedAtUnix: 100,
      }),
    ).toBe('anti_snipe_window')
  })

  it('leaves an ordinary 1% trade alone', () => {
    expect(
      classifyFee({
        feeMinor: usdg(1),
        volumeMinor: usdg(100),
        occurredAtUnix: 100_000,
        launchedAtUnix: 100,
      }),
    ).toBe('trade')
  })
})

describe('binding and attribution', () => {
  const tokenA = addr(0xaa)
  const vaultA = addr(0xa1)
  const curveA = addr(0xac)
  const poolA = poolIdFor(tokenA)

  const tokenB = addr(0xbb)
  const vaultB = addr(0xb1)
  const curveB = addr(0xbc)
  const poolB = poolIdFor(tokenB)

  function twoCoinChain() {
    const chain = newChain()
    chain.addBlock({
      logs: [
        launchCoin(chain, { token: tokenA, curve: curveA, recipient: vaultA }),
        launchCoin(chain, { token: tokenB, curve: curveB, recipient: vaultB }),
      ],
    })
    return chain
  }

  const vaults = [
    issuedVault({ token: tokenA, vault: vaultA }),
    issuedVault({ token: tokenB, vault: vaultB }),
  ]

  it('binds curve, quote asset and a CANDIDATE pool id before any fee arrives', async () => {
    const chain = twoCoinChain()
    chain.setFinalized(chain.height)
    const h = harness(chain, vaults)
    const result = await h.indexer.tick(10_000)

    expect(result.bindingsResolved).toBe(2)
    const bound = await h.store.bindingByToken(tokenA)
    expect(bound?.curve).toBe(curveA)
    expect(bound?.quoteAsset).toBe(USDG.address)
    expect(bound?.candidatePoolId).toBe(poolA)
    // TokenLaunched carries no pool id and the hook has not registered one:
    // the candidate is a query key, never an attribution key.
    expect(bound?.poolId).toBeUndefined()
    expect(await h.store.bindingByPoolId(poolA)).toBeUndefined()
  })

  it('takes buyback and creator tax from the factory record, not from the consent', async () => {
    const chain = newChain()
    chain.addBlock({
      logs: [launchCoin(chain, { token: tokenA, curve: curveA, recipient: vaultA, buybackEnabled: true, creatorTaxBps: 50 })],
    })
    chain.setFinalized(chain.height)
    const h = harness(chain, [issuedVault({ token: tokenA, vault: vaultA, buybackEnabled: false, creatorTaxBps: 0 })])
    const result = await h.indexer.tick(10_000)

    const bound = await h.store.bindingByToken(tokenA)
    expect(bound?.buybackEnabled).toBe(true)
    expect(bound?.creatorTaxBps).toBe(50)
    expect(result.warnings.join(' ')).toContain('chain applied')
  })

  it('refuses to bind when the factory record contradicts the launch log', async () => {
    const chain = twoCoinChain()
    // Same token, different curve than TokenLaunched reported.
    pinLaunchedToken(chain, { token: tokenA, curve: addr(0xdead), creatorFeeRecipient: vaultA })
    chain.setFinalized(chain.height)
    const h = harness(chain, vaults)

    await expect(h.indexer.tick(10_000)).rejects.toThrow(/refusing to bind/)
    expect(await h.store.bindingByToken(tokenA)).toBeUndefined()
  })

  it('attributes post-graduation fees by poolId once PoolRegistered confirms the join', async () => {
    const chain = twoCoinChain()
    chain.addBlock({
      logs: [
        poolRegisteredLog({ poolId: poolA, memecoin: tokenA }),
        poolRegisteredLog({ poolId: poolB, memecoin: tokenB }),
        // ONE emitter, ONE quote asset, TWO coins. Only the poolId separates
        // them, which is the entire reason escrow events cannot be used here.
        poolFeesSweptLog({ poolId: poolA, protocolAmount: usdg(3), buybackAmount: usdg(2), creatorAmount: usdg(7), tokensLocked: 42n }),
        poolFeesSweptLog({ poolId: poolB, protocolAmount: usdg(30), creatorAmount: usdg(70) }),
      ],
    })
    chain.setFinalized(chain.height)

    const h = harness(chain, vaults)
    const result = await h.indexer.tick(10_000)

    const a = await h.store.postings({ token: tokenA })
    const b = await h.store.postings({ token: tokenB })

    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(a[0]?.source).toBe('pool_fees_swept')
    expect(a[0]?.phase).toBe('post_graduation')
    expect(a[0]?.vault).toBe(vaultA)
    // The event names no asset: the binding's pair token is the one applied.
    expect(a[0]?.asset).toBe(USDG.address)
    // The chain reported the creator leg, so no rate is applied to it.
    expect(a[0]?.derivation).toBe('explicit')
    expect(a[0]?.creditedMinor).toBe(usdg(7))
    expect(a[0]?.grossFeeMinor).toBe(usdg(12))
    expect(a[0]?.buybackAmountMinor).toBe(usdg(2))
    expect(a[0]?.tokensLocked).toBe(42n)
    expect(b[0]?.creditedMinor).toBe(usdg(70))

    expect(result.graduations).toEqual(expect.arrayContaining([tokenA, tokenB]))
    expect((await h.store.bindingByToken(tokenA))?.graduatedAtUnix).toBeDefined()
    expect(await h.store.bindingByPoolId(poolB)).toMatchObject({ token: tokenB, poolId: poolB })
  })

  it('refuses a sweep under a pool id no registration has confirmed', async () => {
    const chain = twoCoinChain()
    chain.addBlock({
      logs: [poolFeesSweptLog({ poolId: poolA, protocolAmount: usdg(3), creatorAmount: usdg(7) })],
    })
    chain.setFinalized(chain.height)

    const h = harness(chain, vaults)
    await expect(h.indexer.tick(10_000)).rejects.toThrow(/not in the watch set/)
    expect(await h.store.postings({})).toHaveLength(0)
  })

  it('refuses a registration that names another memecoin under our derived pool id', async () => {
    const chain = twoCoinChain()
    chain.addBlock({ logs: [poolRegisteredLog({ poolId: poolA, memecoin: addr(0xdead) })] })
    chain.setFinalized(chain.height)

    const h = harness(chain, vaults)
    await expect(h.indexer.tick(10_000)).rejects.toThrow(/must not attribute/)
    expect((await h.store.bindingByToken(tokenA))?.poolId).toBeUndefined()
  })

  it('attributes curve trades to the emitting curve, volume gross on both sides', async () => {
    const chain = twoCoinChain()
    chain.addBlock({
      logs: [
        curveTradeLog({
          curve: curveA,
          sender: addr(0x77),
          trader: addr(0x11),
          amountIn: usdg(1_000),
          amountOut: 5n * 10n ** 23n,
          fee: usdg(10),
          creatorTax: usdg(20),
        }),
        curveTradeLog({
          curve: curveB,
          side: 'sell',
          trader: addr(0x22),
          amountIn: 5n * 10n ** 23n,
          amountOut: usdg(970),
          fee: usdg(10),
          creatorTax: usdg(20),
        }),
      ],
    })
    chain.setFinalized(chain.height)

    const h = harness(chain, vaults)
    await h.indexer.tick(10_000)

    const [buy] = await h.store.postings({ token: tokenA })
    const [sell] = await h.store.postings({ token: tokenB })
    expect(buy).toMatchObject({
      vault: vaultA,
      asset: USDG.address,
      source: 'curve_event',
      phase: 'pre_graduation',
      side: 'buy',
      classification: 'trade',
      counterparty: addr(0x11),
      volumeMinor: usdg(1_000),
      grossFeeMinor: usdg(10),
      creditedMinor: creatorShareOfFee(usdg(10), false, 0),
    })
    // A sell reports the NET quote paid out; the fee was taken on the gross.
    expect(sell).toMatchObject({ vault: vaultB, side: 'sell', counterparty: addr(0x22), volumeMinor: usdg(1_000), grossFeeMinor: usdg(10) })
    expect(await h.store.getCursor('curve_trades')).toBeDefined()
  })

  it('backfills a coin onboarded after the fee cursor had already run ahead', async () => {
    // The coin launches, graduates and earns while we have no client at all, so
    // the fee cursor advances past its whole history. Onboarding it later must
    // not silently forfeit those fees.
    const chain = twoCoinChain()
    chain.addBlock({
      logs: [
        poolRegisteredLog({ poolId: poolA, memecoin: tokenA }),
        poolFeesSweptLog({ poolId: poolA, protocolAmount: usdg(3), creatorAmount: usdg(7) }),
      ],
    })
    chain.addBlocks(3)
    chain.setFinalized(chain.height)

    const h = harness(chain, [])
    const first = await h.indexer.tick(10_000)
    expect(await h.store.postings({})).toHaveLength(0)
    expect(await h.store.getCursor('pool_fees')).toBe(first.head.number)

    h.registry.put(issuedVault({ token: tokenA, vault: vaultA }))
    await h.indexer.tick(20_000)
    // One tick to rewind and re-scan, and the history is recovered.
    await h.indexer.tick(30_000)

    const recovered = await h.store.postings({ token: tokenA })
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.grossFeeMinor).toBe(usdg(10))
  })

  it('binds a retrofit coin from consent-supplied launch facts', async () => {
    // No TokenLaunched in range at all: the coin launched and graduated before
    // our start block, which is the ordinary case for an existing coin.
    const chain = newChain()
    pinLaunchedToken(chain, { token: tokenA, curve: curveA, creatorFeeRecipient: vaultA })
    chain.addBlock({
      logs: [poolFeesSweptLog({ poolId: poolA, protocolAmount: usdg(3), creatorAmount: usdg(7) })],
    })
    chain.setFinalized(chain.height)

    const retrofit = issuedVault({
      token: tokenA,
      vault: vaultA,
      launch: { curve: curveA, poolId: poolA, quoteAsset: USDG.address, launchedAtUnix: 0, launchBlockNumber: 0n },
    })

    const h = harness(chain, [retrofit])
    const result = await h.indexer.tick(10_000)

    expect(result.bindingsResolved).toBe(1)
    const postings = await h.store.postings({ token: tokenA })
    expect(postings).toHaveLength(1)
    expect(postings[0]?.creditedMinor).toBe(usdg(7))
  })

  it('refuses retrofit launch facts whose pool id is not the one the chain derives', async () => {
    const chain = newChain()
    pinLaunchedToken(chain, { token: tokenA, curve: curveA, creatorFeeRecipient: vaultA })
    chain.addBlock()
    chain.setFinalized(chain.height)

    const retrofit = issuedVault({
      token: tokenA,
      vault: vaultA,
      launch: { curve: curveA, poolId: hash32(0x999), quoteAsset: USDG.address, launchedAtUnix: 0, launchBlockNumber: 0n },
    })

    await expect(harness(chain, [retrofit]).indexer.tick(10_000)).rejects.toThrow(/does not match the pool key/)
  })

  it('refuses to silently drop a fee log it cannot attribute', async () => {
    const chain = newChain()
    const block = chain.addBlock({
      logs: [poolFeesSweptLog({ poolId: hash32(0xdead), protocolAmount: 1n, creatorAmount: 1n })],
    })
    const logs = await new FakeRpcClient(chain, 'x').getLogs({
      fromBlock: block.number,
      toBlock: block.number,
      address: [VENUE.contracts.v2MemeHook],
      topics: [null, [hash32(0xdead)]],
    })

    await expect(
      attributeFeeLogs(logs, {
        bindingByCurve: async () => undefined,
        bindingByPoolId: async () => undefined,
        blockFor: () => block,
      }),
    ).rejects.toThrow(DecodeError)
  })

  it('refuses to invent a timestamp for a block it has not hydrated', async () => {
    const chain = newChain()
    const block = chain.addBlock({
      logs: [poolFeesSweptLog({ poolId: hash32(0x400), protocolAmount: 1n, creatorAmount: 1n })],
    })
    const logs = await new FakeRpcClient(chain, 'x').getLogs({
      fromBlock: block.number,
      toBlock: block.number,
      address: [VENUE.contracts.v2MemeHook],
      topics: [null, [hash32(0x400)]],
    })

    await expect(
      attributeFeeLogs(logs, {
        bindingByCurve: async () => undefined,
        bindingByPoolId: async () => binding(),
        blockFor: () => undefined,
      }),
    ).rejects.toThrow(/refusing to invent a timestamp/)
  })
})
