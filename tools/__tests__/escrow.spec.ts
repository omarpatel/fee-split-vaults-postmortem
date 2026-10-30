import { describe, expect, it } from 'vitest'
import { parseEventSignature } from '../lib/abi.ts'
import { MemoryCache } from '../lib/cache.ts'
import {
  BitqueryEscrowBackend,
  CreditEventShapeError,
  NATIVE_CREDIT_EVENT,
  RpcEscrowBackend,
  TOKEN_CREDIT_EVENT,
  VERIFIED_CREDIT_TOPIC0,
  decodeCredit,
  discoverTopics,
  parseBitqueryEvents,
  resolveCreditEvent,
  resolveCreditEvents,
} from '../lib/escrow.ts'
import { FakeHttpClient, jsonResponse } from '../lib/http.ts'
import { UnservableRangeError, scanLogs } from '../lib/logscan.ts'
import { NATIVE_ASSET_ADDRESS } from '../lib/prices.ts'
import { FakeChainReader } from '../lib/rpc.ts'
import {
  loadFixture,
  loadFixtureText,
  toRawLogs,
  type EscrowFixture,
  type EscrowTokenFixture,
} from './helpers.ts'

const fixture = loadFixture<EscrowFixture>('escrow-credit-logs.json')
const logs = toRawLogs(fixture.logs)
const nativePlan = resolveCreditEvent(NATIVE_CREDIT_EVENT, 'native')

const tokenFixture = loadFixture<EscrowTokenFixture>('escrow-credit-token-logs.json')
const tokenLogs = toRawLogs(tokenFixture.logs)
const tokenPlan = resolveCreditEvent(TOKEN_CREDIT_EVENT, 'token')

function makeReader(extra: readonly (typeof logs)[number][] = []): FakeChainReader {
  const all = [...logs, ...extra]
  return new FakeChainReader({
    chainId: 4663,
    logs: all,
    blockTimeSeconds: fixture.blockTimeSeconds,
    genesisUnix: fixture.genesisUnix,
    latestBlock: all.reduce((max, l) => (l.blockNumber > max ? l.blockNumber : max), 0n),
  })
}

/**
 * THE DEFECT, PINNED.
 *
 * Every one of these asserts something that the old positional decoder got
 * wrong, or would have got wrong. They are the regression tests for
 * "the headline numbers looked right and the asset breakdown was nonsense".
 */
describe('resolveCreditEvent', () => {
  it('gives the NATIVE event the native sentinel and never a token index', () => {
    expect(nativePlan.mode).toBe('native')
    expect(nativePlan.tokenIndex).toBeUndefined()
    expect(nativePlan.spec.topic0).toBe(VERIFIED_CREDIT_TOPIC0.native)
    expect(nativePlan.topic0IsUnverified).toBe(false)
  })

  it('locates the ERC-20 asset by NAME, not by position', () => {
    expect(tokenPlan.tokenIndex).toBe(1)
    expect(tokenPlan.tokenByPosition).toBe(false)
    expect(tokenPlan.spec.topic0).toBe(VERIFIED_CREDIT_TOPIC0.token)
    // Same event, asset named in a different slot: the plan must follow the name.
    const reordered = resolveCreditEvent(
      'CreditedToken(address indexed recipient, address indexed depositor, address indexed token, uint256 amount)',
      'token',
    )
    expect(reordered.tokenIndex).toBe(2)
  })

  it('REFUSES the ERC-20 event in native mode instead of decoding it by position', () => {
    expect(() => resolveCreditEvent(TOKEN_CREDIT_EVENT, 'native')).toThrow(CreditEventShapeError)
    expect(() => resolveCreditEvent(TOKEN_CREDIT_EVENT, 'native')).toThrow(/use --mode token/)
    // The message names BOTH what the mode expects and what it was handed.
    const message = (() => {
      try {
        resolveCreditEvent(TOKEN_CREDIT_EVENT, 'native')
        return ''
      } catch (error) {
        return (error as Error).message
      }
    })()
    expect(message).toContain(NATIVE_CREDIT_EVENT)
    expect(message).toContain('CreditedToken')
    expect(message).toContain('3 indexed parameter(s), not 2')
  })

  it('REFUSES the native event in token mode', () => {
    expect(() => resolveCreditEvent(NATIVE_CREDIT_EVENT, 'token')).toThrow(/use --mode native/)
  })

  it('REFUSES a native signature that claims its second indexed param is an asset', () => {
    // This is the exact shape the tool used to ship as its default, and the
    // exact reading that produced per-asset buckets keyed by depositors.
    expect(() =>
      resolveCreditEvent(
        'Credited(address indexed recipient, address indexed asset, uint256 amount)',
        'native',
      ),
    ).toThrow(/a native credit carries no asset/)
    expect(() =>
      resolveCreditEvent(
        'FeesCredited(address indexed recipient, address indexed quoteAsset, uint256 amount)',
        'native',
      ),
    ).toThrow(CreditEventShapeError)
  })

  it('REFUSES a token signature whose indexed params are named but name no asset', () => {
    expect(() =>
      resolveCreditEvent(
        'CreditedToken(address indexed recipient, address indexed depositor, address indexed operator, uint256 amount)',
        'token',
      ),
    ).toThrow(/none of them names the asset/)
  })

  it('REFUSES a signature whose recipient is not first', () => {
    expect(() =>
      resolveCreditEvent(
        'Credited(address indexed depositor, address indexed recipient, uint256 amount)',
        'native',
      ),
    ).toThrow(/the recipient must come first/)
  })

  it('REFUSES wrong types, wrong arity and a non-uint amount', () => {
    expect(() =>
      resolveCreditEvent('Credited(address indexed recipient, bytes32 indexed x, uint256 amount)', 'native'),
    ).toThrow(/not address/)
    expect(() =>
      resolveCreditEvent(
        'Credited(address indexed recipient, address indexed depositor, uint256 amount, uint256 fee)',
        'native',
      ),
    ).toThrow(/non-indexed parameter\(s\)/)
    expect(() =>
      resolveCreditEvent(
        'Credited(address indexed recipient, address indexed depositor, address amount)',
        'native',
      ),
    ).toThrow(/not a uint amount/)
    // Un-indexed markers: the old decoder silently read these from data.
    expect(() =>
      resolveCreditEvent('Credited(address recipient, address depositor, uint256 amount)', 'native'),
    ).toThrow(/0 indexed parameter\(s\)/)
  })

  it('accepts a fully unnamed token signature but RECORDS that the asset was positional', () => {
    const plan = resolveCreditEvent(
      'CreditedToken(address indexed, address indexed, address indexed, uint256)',
      'token',
    )
    expect(plan.tokenIndex).toBe(1)
    expect(plan.tokenByPosition).toBe(true)
  })

  it('flags an override whose topic0 is not the census-verified one', () => {
    const plan = resolveCreditEvent(
      'SomethingElse(address indexed recipient, address indexed depositor, uint256 amount)',
      'native',
    )
    expect(plan.topic0IsUnverified).toBe(true)
  })

  it('resolveCreditEvents("both") returns native then token', () => {
    const plans = resolveCreditEvents('both')
    expect(plans.map((p) => p.mode)).toEqual(['native', 'token'])
    expect(plans.map((p) => p.spec.topic0)).toEqual([
      VERIFIED_CREDIT_TOPIC0.native,
      VERIFIED_CREDIT_TOPIC0.token,
    ])
  })
})

describe('decodeCredit', () => {
  it('assigns the NATIVE sentinel, never the depositor address', () => {
    const credit = decodeCredit(nativePlan, logs[0]!)
    expect(credit.asset).toBe(NATIVE_ASSET_ADDRESS)
    expect(credit.assetKind).toBe('native')
    // The depositor is present in the log and must NOT have become the asset.
    expect(logs[0]!.topics[2]).toContain(fixture.depositor.slice(2))
    expect(credit.asset).not.toContain(fixture.depositor.slice(2))
  })

  it('assigns the ERC-20 asset from the token parameter', () => {
    const credit = decodeCredit(tokenPlan, tokenLogs[0]!)
    expect(credit.asset).toBe(tokenFixture.assets[0]!.address)
    expect(credit.assetKind).toBe('erc20')
    expect(credit.asset).not.toBe(tokenFixture.depositor)
  })
})

describe('RpcEscrowBackend', () => {
  it('decodes every recorded native credit as ETH with the right recipient and amount', async () => {
    const reader = makeReader()
    const backend = new RpcEscrowBackend(reader, {
      chunkBlocks: 500_000,
      exactTimestamps: true,
      anchorSpacing: 100_000,
    })
    const credits = await backend.fetch({
      escrow: fixture.escrow,
      events: [nativePlan],
      fromBlock: 0n,
      toBlock: await reader.blockNumber(),
      fromUnix: fixture.genesisUnix,
      toUnix: fixture.genesisUnix + 30 * 86_400,
    })

    expect(credits).toHaveLength(fixture.logs.length)
    for (const credit of credits) {
      expect(credit.asset).toBe(NATIVE_ASSET_ADDRESS)
      expect(credit.assetKind).toBe('native')
      expect(credit.amountMinor).toBeGreaterThan(0n)
      expect(credit.recipient).toMatch(/^0x[0-9a-f]{40}$/)
    }
    const recipients = new Set(credits.map((c) => c.recipient))
    expect(recipients.size).toBe(5)
    // Exactly one asset key, and it is not any depositor.
    expect(new Set(credits.map((c) => c.asset)).size).toBe(1)
  })

  it('attaches a timestamp consistent with the fixture block time', async () => {
    const reader = makeReader()
    const backend = new RpcEscrowBackend(reader, {
      chunkBlocks: 500_000,
      exactTimestamps: true,
      anchorSpacing: 100_000,
    })
    const credits = await backend.fetch({
      escrow: fixture.escrow,
      events: [nativePlan],
      fromBlock: 0n,
      toBlock: await reader.blockNumber(),
      fromUnix: fixture.genesisUnix,
      toUnix: fixture.genesisUnix + 30 * 86_400,
    })
    const first = credits[0]!
    expect(first.timestampUnix).toBe(fixture.genesisUnix + Number(first.blockNumber))
  })

  it('produces the same credits with interpolated timestamps as with exact ones', async () => {
    const exact = new RpcEscrowBackend(makeReader(), {
      chunkBlocks: 500_000,
      exactTimestamps: true,
      anchorSpacing: 100_000,
    })
    const anchored = new RpcEscrowBackend(makeReader(), {
      chunkBlocks: 500_000,
      exactTimestamps: false,
      anchorSpacing: 50_000,
    })
    const query = {
      escrow: fixture.escrow,
      events: [nativePlan],
      fromBlock: 0n,
      toBlock: 2_600_000n,
      fromUnix: fixture.genesisUnix,
      toUnix: fixture.genesisUnix + 30 * 86_400,
    }
    const a = await exact.fetch(query)
    const b = await anchored.fetch(query)
    expect(b).toHaveLength(a.length)
    // Fixture block time is exactly uniform, so interpolation must be exact too.
    for (let i = 0; i < a.length; i++) {
      expect(b[i]!.timestampUnix).toBe(a[i]!.timestampUnix)
    }
  })

  it('refuses to decode when the signature has the wrong indexed markers', async () => {
    // A plan whose spec claims nothing is indexed, forced past resolveCreditEvent
    // so the DECODE path's own fail-closed check is what is under test here.
    const wrong = parseEventSignature('Credited(address recipient, address depositor, uint256 amount)')
    const backend = new RpcEscrowBackend(makeReader(), {
      chunkBlocks: 500_000,
      exactTimestamps: true,
      anchorSpacing: 100_000,
    })
    await expect(
      backend.fetch({
        escrow: fixture.escrow,
        events: [{ ...nativePlan, spec: { ...wrong, topic0: nativePlan.spec.topic0 } }],
        fromBlock: 0n,
        toBlock: 2_600_000n,
        fromUnix: 0,
        toUnix: 0,
      }),
    ).rejects.toThrow(/expected 1 topics/)
  })

  it('scans BOTH credit events in one filter and tags each credit by its own event', async () => {
    const reader = makeReader(tokenLogs)
    const backend = new RpcEscrowBackend(reader, {
      chunkBlocks: 2_600_000,
      exactTimestamps: true,
      anchorSpacing: 100_000,
    })
    const credits = await backend.fetch({
      escrow: fixture.escrow,
      events: [nativePlan, tokenPlan],
      fromBlock: 0n,
      toBlock: 2_600_000n,
      fromUnix: fixture.genesisUnix,
      toUnix: fixture.genesisUnix + 30 * 86_400,
    })

    expect(credits).toHaveLength(logs.length + tokenLogs.length)
    const native = credits.filter((c) => c.assetKind === 'native')
    const erc20 = credits.filter((c) => c.assetKind === 'erc20')
    expect(native).toHaveLength(logs.length)
    expect(erc20).toHaveLength(tokenLogs.length)
    expect(new Set(erc20.map((c) => c.asset))).toEqual(
      new Set(tokenFixture.assets.map((a) => a.address)),
    )
    // ONE filter carrying a topic0 OR-set, so merging costs no extra requests:
    // every call asks for both topics, and the call count is the chunk count.
    for (const call of reader.getLogsCalls) {
      expect(call.topics?.[0]).toEqual([nativePlan.spec.topic0, tokenPlan.spec.topic0])
    }
    const singleEventCalls = new FakeChainReader({ chainId: 4663, logs: [], latestBlock: 0n })
    await new RpcEscrowBackend(singleEventCalls, {
      chunkBlocks: 2_600_000,
      exactTimestamps: true,
      anchorSpacing: 100_000,
    }).fetch({
      escrow: fixture.escrow,
      events: [nativePlan],
      fromBlock: 0n,
      toBlock: 2_600_000n,
      fromUnix: fixture.genesisUnix,
      toUnix: fixture.genesisUnix + 30 * 86_400,
    })
    expect(reader.getLogsCalls).toHaveLength(singleEventCalls.getLogsCalls.length)
    // A single-event scan sends a bare topic0, not a one-element array.
    expect(singleEventCalls.getLogsCalls[0]!.topics?.[0]).toBe(nativePlan.spec.topic0)
  })

  it('merged totals equal the sum of the two single-event scans, per recipient', async () => {
    const options = { chunkBlocks: 2_600_000, exactTimestamps: true, anchorSpacing: 100_000 }
    const window = {
      escrow: fixture.escrow,
      fromBlock: 0n,
      toBlock: 2_600_000n,
      fromUnix: fixture.genesisUnix,
      toUnix: fixture.genesisUnix + 30 * 86_400,
    }
    const nativeOnly = await new RpcEscrowBackend(makeReader(tokenLogs), options).fetch({
      ...window,
      events: [nativePlan],
    })
    const tokenOnly = await new RpcEscrowBackend(makeReader(tokenLogs), options).fetch({
      ...window,
      events: [tokenPlan],
    })
    const merged = await new RpcEscrowBackend(makeReader(tokenLogs), options).fetch({
      ...window,
      events: [nativePlan, tokenPlan],
    })

    const totalByAsset = (credits: typeof merged): Map<string, bigint> => {
      const out = new Map<string, bigint>()
      for (const c of credits) {
        out.set(`${c.recipient}|${c.asset}`, (out.get(`${c.recipient}|${c.asset}`) ?? 0n) + c.amountMinor)
      }
      return out
    }
    const expected = totalByAsset([...nativeOnly, ...tokenOnly])
    const actual = totalByAsset(merged)
    expect(actual.size).toBe(expected.size)
    for (const [key, value] of expected) expect(actual.get(key)).toBe(value)
    expect(merged).toHaveLength(nativeOnly.length + tokenOnly.length)
  })

  it('topic-filters --recipients on topic 1, and refuses to if the recipient is not there', async () => {
    const reader = makeReader()
    const backend = new RpcEscrowBackend(reader, {
      chunkBlocks: 2_600_000,
      exactTimestamps: true,
      anchorSpacing: 100_000,
    })
    const query = {
      escrow: fixture.escrow,
      events: [nativePlan],
      fromBlock: 0n,
      toBlock: 2_600_000n,
      fromUnix: fixture.genesisUnix,
      toUnix: fixture.genesisUnix + 30 * 86_400,
      recipients: ['0xaaaa000000000000000000000000000000000001'],
    }
    const credits = await backend.fetch(query)
    expect(credits.length).toBeGreaterThan(0)
    expect(new Set(credits.map((c) => c.recipient))).toEqual(
      new Set(['0xaaaa000000000000000000000000000000000001']),
    )
    expect(reader.getLogsCalls[0]!.topics?.[1]).toEqual([
      `0x${'0'.repeat(24)}aaaa000000000000000000000000000000000001`,
    ])

    // A plan whose recipient is NOT the first indexed param must refuse rather
    // than filter topic 1 and return a wrong subset that looks like an answer.
    await expect(
      backend.fetch({ ...query, events: [{ ...nativePlan, recipientIndex: 1 }] }),
    ).rejects.toThrow(/Refusing to filter on the wrong topic/)
  })

  it('fails closed when the endpoint serves a topic that was not asked for', async () => {
    // An endpoint that ignores the topic filter must not have its extra logs
    // decoded against whichever plan happens to be first.
    const reader = new FakeChainReader({
      chainId: 4663,
      logs: tokenLogs,
      blockTimeSeconds: 1,
      genesisUnix: fixture.genesisUnix,
      latestBlock: 2_600_000n,
    })
    reader.getLogs = async (filter) => {
      void filter
      return tokenLogs
    }
    const backend = new RpcEscrowBackend(reader, {
      chunkBlocks: 2_600_000,
      exactTimestamps: true,
      anchorSpacing: 100_000,
    })
    await expect(
      backend.fetch({
        escrow: fixture.escrow,
        events: [nativePlan],
        fromBlock: 0n,
        toBlock: 2_600_000n,
        fromUnix: 0,
        toUnix: 0,
      }),
    ).rejects.toThrow(/ignored the topic filter/)
  })
})

describe('scanLogs range narrowing', () => {
  it('halves the range when the endpoint caps the result set, and still returns everything', async () => {
    const reader = makeReader()
    reader.maxLogsPerCall = 50
    const scanned = await scanLogs(reader, {
      address: fixture.escrow,
      topics: [nativePlan.spec.topic0],
      fromBlock: 0n,
      toBlock: 2_600_000n,
      chunkBlocks: 2_600_000,
    })
    expect(scanned).toHaveLength(logs.length)
    // It had to narrow, so it made many more calls than the one chunk requested.
    expect(reader.getLogsCalls.length).toBeGreaterThan(1)
  })

  it('gives up loudly when a SINGLE block cannot be served', async () => {
    const reader = new FakeChainReader({ chainId: 4663, logs: [], latestBlock: 10n })
    reader.maxLogsPerCall = -1 // every call throws
    await expect(
      scanLogs(reader, { address: fixture.escrow, fromBlock: 5n, toBlock: 5n, chunkBlocks: 1 }),
    ).rejects.toThrow(UnservableRangeError)
  })

  it('drops logs that were reorged out rather than counting a fee that no longer exists', async () => {
    const removed = logs.map((log, i) => (i === 0 ? { ...log, removed: true } : log))
    const reader = new FakeChainReader({ chainId: 4663, logs: removed, latestBlock: 2_600_000n })
    const scanned = await scanLogs(reader, {
      address: fixture.escrow,
      fromBlock: 0n,
      toBlock: 2_600_000n,
      chunkBlocks: 2_600_000,
    })
    expect(scanned).toHaveLength(logs.length - 1)
  })

  it('serves a repeat scan from cache without touching the reader again', async () => {
    const reader = makeReader()
    const cache = new MemoryCache()
    const options = {
      address: fixture.escrow,
      topics: [nativePlan.spec.topic0],
      fromBlock: 0n,
      toBlock: 2_600_000n,
      chunkBlocks: 2_600_000,
      cache,
    }
    await scanLogs(reader, options)
    const callsAfterFirst = reader.getLogsCalls.length
    const second = await scanLogs(reader, options)
    expect(reader.getLogsCalls.length).toBe(callsAfterFirst)
    expect(second).toHaveLength(logs.length)
    expect(cache.hits).toBeGreaterThan(0)
    expect(cache.hits).toBe(cache.store.size)
  })
})

describe('discoverTopics', () => {
  it('censuses topic0 and names the signatures it recognises', async () => {
    const census = await discoverTopics(makeReader(tokenLogs), {
      escrow: fixture.escrow,
      fromBlock: 0n,
      toBlock: 2_600_000n,
      chunkBlocks: 2_600_000,
    })
    expect(census).toHaveLength(2)
    const native = census.find((c) => c.topic0 === VERIFIED_CREDIT_TOPIC0.native)!
    expect(native.count).toBe(logs.length)
    expect(native.matchedSignature).toBe('Credited(address,address,uint256)')
    expect(native.topicCount).toBe(3)
    expect(native.dataWords).toBe(1)

    const token = census.find((c) => c.topic0 === VERIFIED_CREDIT_TOPIC0.token)!
    expect(token.count).toBe(tokenLogs.length)
    expect(token.matchedSignature).toBe('CreditedToken(address,address,address,uint256)')
    expect(token.topicCount).toBe(4)
    expect(token.dataWords).toBe(1)
  })
})

describe('BitqueryEscrowBackend', () => {
  it('parses a recorded GraphQL response into the same credit shape as the RPC path', () => {
    const credits = parseBitqueryEvents(loadFixtureText('bitquery-escrow-events.json'), nativePlan)
    expect(credits).toHaveLength(6)
    for (const credit of credits) {
      expect(credit.asset).toBe(NATIVE_ASSET_ADDRESS)
      expect(credit.assetKind).toBe('native')
      expect(typeof credit.amountMinor).toBe('bigint')
      expect(credit.timestampUnix).toBeGreaterThan(1_700_000_000)
    }
  })

  it('agrees with the RPC backend on the first six credits', async () => {
    const viaGraphql = parseBitqueryEvents(loadFixtureText('bitquery-escrow-events.json'), nativePlan)
    const reader = makeReader()
    const viaRpc = await new RpcEscrowBackend(reader, {
      chunkBlocks: 2_600_000,
      exactTimestamps: true,
      anchorSpacing: 100_000,
    }).fetch({
      escrow: fixture.escrow,
      events: [nativePlan],
      fromBlock: 0n,
      toBlock: 2_600_000n,
      fromUnix: 0,
      toUnix: 0,
    })
    for (let i = 0; i < viaGraphql.length; i++) {
      expect(viaGraphql[i]!.recipient).toBe(viaRpc[i]!.recipient)
      expect(viaGraphql[i]!.amountMinor).toBe(viaRpc[i]!.amountMinor)
      expect(viaGraphql[i]!.timestampUnix).toBe(viaRpc[i]!.timestampUnix)
      expect(viaGraphql[i]!.asset).toBe(viaRpc[i]!.asset)
    }
  })

  it('fails closed on a GraphQL errors block instead of reporting zero credits', () => {
    expect(() => parseBitqueryEvents(loadFixtureText('bitquery-error.json'), nativePlan)).toThrow(
      /not supported/,
    )
  })

  it('fails closed when the response has no Events field at all', () => {
    expect(() => parseBitqueryEvents('{"data":{}}', nativePlan)).toThrow(/schema has changed/)
  })

  it('pages until a short page and sends the auth header', async () => {
    const rows = JSON.parse(loadFixtureText('bitquery-escrow-events.json')) as unknown
    const http = new FakeHttpClient([{ match: 'graphql', respond: jsonResponse(rows) }])
    const backend = new BitqueryEscrowBackend(http, {
      url: 'https://streaming.bitquery.io/graphql',
      token: 'test-token',
      network: 'robinhood',
      pageSize: 25_000,
    })
    const credits = await backend.fetch({
      escrow: fixture.escrow,
      events: [nativePlan],
      fromBlock: 0n,
      toBlock: 0n,
      fromUnix: 1_780_000_000,
      toUnix: 1_790_000_000,
    })
    expect(credits).toHaveLength(6)
    expect(http.requests).toHaveLength(1)
    expect(http.requests[0]!.headers?.authorization).toBe('Bearer test-token')
    // The token must never leak into the URL, only the header.
    expect(http.requests[0]!.url).not.toContain('test-token')
  })

  it('issues one paged query PER credit event and merges what comes back', async () => {
    // The GraphQL Events selection takes a single topic0, so a merged scan is
    // one paged query per event. Each query must get ONLY its own event's rows;
    // routing by the topic0 in the request body is how that is asserted.
    const nativeRows = JSON.parse(loadFixtureText('bitquery-escrow-events.json')) as unknown
    const tokenRows = {
      data: {
        EVM: {
          Events: tokenFixture.logs.map((log) => ({
            Block: {
              Number: log.blockNumber,
              Time: new Date(
                (tokenFixture.genesisUnix + Number(log.blockNumber)) * 1000,
              ).toISOString(),
              Hash: log.blockHash,
            },
            Transaction: { Hash: log.transactionHash },
            Log: {
              Index: String(log.logIndex),
              Data: log.data,
              Topics: log.topics.map((Hash) => ({ Hash })),
            },
          })),
        },
      },
    }
    const http = new FakeHttpClient([
      {
        match: 'graphql',
        respond: (req) =>
          (req.body ?? '').includes(VERIFIED_CREDIT_TOPIC0.token)
            ? jsonResponse(tokenRows)
            : jsonResponse(nativeRows),
      },
    ])
    const backend = new BitqueryEscrowBackend(http, {
      url: 'https://streaming.bitquery.io/graphql',
      token: 'test-token',
      network: 'robinhood',
      pageSize: 25_000,
    })
    const credits = await backend.fetch({
      escrow: fixture.escrow,
      events: [nativePlan, tokenPlan],
      fromBlock: 0n,
      toBlock: 0n,
      fromUnix: 1_780_000_000,
      toUnix: 1_790_000_000,
    })
    expect(http.requests).toHaveLength(2)
    const sent = http.requests.map(
      (r) => (JSON.parse(r.body ?? '{}') as { variables: { topic0: string } }).variables.topic0,
    )
    expect(sent).toEqual([VERIFIED_CREDIT_TOPIC0.native, VERIFIED_CREDIT_TOPIC0.token])

    expect(credits).toHaveLength(6 + tokenFixture.logs.length)
    expect(credits.filter((c) => c.assetKind === 'native')).toHaveLength(6)
    expect(credits.filter((c) => c.assetKind === 'erc20')).toHaveLength(tokenFixture.logs.length)
    // Merged output is one time-ordered series, not two concatenated blocks.
    for (let i = 1; i < credits.length; i++) {
      expect(credits[i]!.timestampUnix).toBeGreaterThanOrEqual(credits[i - 1]!.timestampUnix)
    }
  })
})
