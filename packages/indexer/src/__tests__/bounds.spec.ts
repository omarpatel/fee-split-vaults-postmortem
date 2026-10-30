import { describe, expect, it } from 'vitest'
import { CURVE_BUY, POOL_FEES_SWEPT, TOKEN_LAUNCHED } from '../abi.js'
import { ChainMismatchError, QuorumDisagreementError, UnboundedQueryError, WatchSetError } from '../errors.js'
import { FakeChain, FakeRpcClient } from '../fake-rpc.js'
import { addressToTopic } from '../hex.js'
import { assertBoundedWatchSet } from '../indexer.js'
import { QuorumRpc } from '../quorum.js'
import { assertBoundedLogQuery, DEFAULT_QUERY_LIMITS } from '../rpc.js'
import { addr, curveTradeLog, FACTORY, HOOK, hash32, issuedVault, newChain, usdg } from './helpers.js'

describe('assertBoundedLogQuery', () => {
  const base = { fromBlock: 0n, toBlock: 10n }

  it('refuses a query with no address filter', () => {
    expect(() => assertBoundedLogQuery({ ...base, address: [], topics: [] })).toThrow(UnboundedQueryError)
  })

  it('refuses the launch firehose: a shared Venue contract with no identifier allowlist', () => {
    expect(() =>
      assertBoundedLogQuery({ ...base, address: [FACTORY], topics: [TOKEN_LAUNCHED.topic0] }),
    ).toThrow(/firehose/)

    expect(() =>
      assertBoundedLogQuery({ ...base, address: [HOOK], topics: [POOL_FEES_SWEPT.topic0, []] }),
    ).toThrow(UnboundedQueryError)
  })

  it('admits a shared contract narrowed to our own identifiers', () => {
    expect(() =>
      assertBoundedLogQuery({
        ...base,
        address: [HOOK],
        topics: [POOL_FEES_SWEPT.topic0, [hash32(1), hash32(2)]],
      }),
    ).not.toThrow()

    expect(() =>
      assertBoundedLogQuery({
        ...base,
        address: [FACTORY],
        topics: [[TOKEN_LAUNCHED.topic0], [addressToTopic(addr(1))]],
      }),
    ).not.toThrow()
  })

  it('admits a per-launch curve address without a topic allowlist', () => {
    expect(() =>
      assertBoundedLogQuery({ ...base, address: [addr(0x300)], topics: [[CURVE_BUY.topic0]] }),
    ).not.toThrow()
  })

  it('refuses an unbounded block span or an oversized address set', () => {
    expect(() =>
      assertBoundedLogQuery({ fromBlock: 0n, toBlock: 1_000_000n, address: [addr(1)], topics: [] }),
    ).toThrow(/span/)

    const many = Array.from({ length: DEFAULT_QUERY_LIMITS.maxAddressesPerQuery + 1 }, (_, i) => addr(i + 1))
    expect(() => assertBoundedLogQuery({ ...base, address: many, topics: [] })).toThrow(/chunk the watch set/)
  })
})

describe('assertBoundedWatchSet', () => {
  it('refuses a watch set larger than the ceiling', () => {
    const many = Array.from({ length: 11 }, (_, i) => issuedVault({ token: addr(i + 1) }))
    expect(() => assertBoundedWatchSet(many, 10)).toThrow(WatchSetError)
  })

  it('refuses a duplicated token', () => {
    expect(() =>
      assertBoundedWatchSet([issuedVault({ token: addr(1) }), issuedVault({ token: addr(1) })]),
    ).toThrow(/twice/)
  })
})

describe('QuorumRpc', () => {
  function pair(a: FakeChain, b: FakeChain): QuorumRpc {
    return new QuorumRpc(new FakeRpcClient(a, 'primary'), new FakeRpcClient(b, 'secondary'))
  }

  it('refuses to be constructed from one endpoint twice', () => {
    const chain = newChain()
    expect(
      () => new QuorumRpc(new FakeRpcClient(chain, 'same'), new FakeRpcClient(chain, 'same')),
    ).toThrow(/not a quorum/)
  })

  it('agrees when both endpoints read the same chain', async () => {
    const chain = newChain()
    chain.addBlock()
    chain.setFinalized(1n)
    const rpc = pair(chain, chain)

    await expect(rpc.assertChain()).resolves.toBeUndefined()
    expect((await rpc.head()).number).toBe(1n)
    expect((await rpc.finalized()).number).toBe(1n)
  })

  it('tolerates lag by agreeing at the lower height', async () => {
    const chain = newChain()
    chain.addBlocks(5)
    const primary = new FakeRpcClient(chain, 'primary')
    const secondary = new FakeRpcClient(chain, 'secondary', { headLagBlocks: 2 })
    const rpc = new QuorumRpc(primary, secondary)

    const head = await rpc.head()
    expect(head.number).toBe(chain.height - 2n)
  })

  it('refuses when the two endpoints are on different forks', async () => {
    const a = newChain()
    a.addBlock()
    const b = newChain()
    b.reorgFrom(1n)
    b.addBlock()

    const rpc = pair(a, b)
    await expect(rpc.head()).rejects.toThrow(QuorumDisagreementError)
  })

  it('refuses when the two endpoints return different logs', async () => {
    const a = newChain()
    const b = newChain()
    const curve = addr(0x300)
    a.addBlock({ logs: [curveTradeLog({ curve, trader: addr(1), amountIn: 1n, amountOut: 1n, fee: usdg(10) })] })
    b.addBlock({ logs: [curveTradeLog({ curve, trader: addr(1), amountIn: 1n, amountOut: 1n, fee: usdg(99) })] })

    const rpc = pair(a, b)
    await expect(
      rpc.getLogs({ fromBlock: 1n, toBlock: 1n, address: [curve], topics: [[CURVE_BUY.topic0]] }),
    ).rejects.toThrow(QuorumDisagreementError)
  })

  it('refuses an endpoint on the wrong chain', async () => {
    const right = newChain()
    const wrong = new FakeChain({ chainId: 1 })
    wrong.addBlock()
    await expect(pair(right, wrong).assertChain()).rejects.toThrow(ChainMismatchError)
  })

  it('has no single-provider fallback: one endpoint failing fails the read', async () => {
    const chain = newChain()
    chain.addBlock()
    const primary = new FakeRpcClient(chain, 'primary')
    const secondary = new FakeRpcClient(chain, 'secondary')
    secondary.failNext(1, 'endpoint down')

    await expect(new QuorumRpc(primary, secondary).head()).rejects.toThrow(/endpoint down/)
  })

  it('checks the bound before contacting either provider', async () => {
    const chain = newChain()
    const rpc = pair(chain, chain)
    await expect(
      rpc.getLogs({ fromBlock: 0n, toBlock: 1n, address: [], topics: [] }),
    ).rejects.toThrow(UnboundedQueryError)
  })
})
