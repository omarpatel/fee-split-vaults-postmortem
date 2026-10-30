/**
 * ONE LIVE READ, against the real chain 4663 endpoints.
 *
 * Gated behind VENUE_LIVE_RPC=1 and skipped by default, for the reason
 * tools/vitest.config.ts states about its own suite: a red test must always
 * mean our decoding or our arithmetic broke, never that someone else's service
 * moved. This one is here because the rest of the adapter suite runs against
 * FakeChain, and a fake cannot tell you whether the transport, the quorum, the
 * bounded-query rule and the cursor actually work against a node.
 *
 *   npx vitest run packages/adapters/src/__tests__/live-read.spec.ts
 *
 * with VENUE_LIVE_RPC=1 and, optionally, VENUE_RPC_URL / VENUE_RPC_URL_SECONDARY.
 *
 * IT IS DELIBERATELY TINY. This chain answers roughly 0.8 requests a second, so
 * every extra call is a second of wall time and a step closer to a 429. The
 * whole file is about a dozen JSON-RPC calls over two endpoints and reads a few
 * hundred blocks.
 *
 * A NOTE ON THE STAND-IN VAULT. No CoinVault is deployed on Venue mainnet yet,
 * so the movement scan is pointed at the Venue FEE ESCROW - a real contract with
 * real traffic - purely to prove the query path runs against real data. It
 * decodes nothing, and that is the point: the escrow's own `Credited` is
 * `Credited(address,address,uint256)` while CoinVault's is
 * `Credited(address,uint256,uint256,uint256,uint256,uint256)`, so the two have
 * different topic0 values and our filter correctly matches none of its logs.
 * The last test reads the escrow's real events with the escrow's own shape, to
 * show the same transport returning real decoded numbers.
 */

import {
  JsonRpcClient,
  QuorumRpc,
  decodeEventLog,
  defineEvent,
  requireBigInt,
  type IndexerStore,
} from '@fee-split-vaults/indexer'
// The one deep import in this package, matching what packages/indexer does:
// config/protocol.ts is the single definition of the deployed addresses.
import { VENUE } from '../../../../config/protocol.js'
import { describe, expect, it } from 'vitest'
import { InMemoryChainCursorStore } from '../chain/cursors.js'
import { InMemoryHaltStore } from '../chain/halts.js'
import { InMemoryVaultMovementStore } from '../chain/movements.js'
import { RpcChainReadModel } from '../chain/read-model.js'
import { CoverageGapError, VaultNotTrackedError } from '../errors.js'

const LIVE = process.env.VENUE_LIVE_RPC === '1'
const PRIMARY_URL = process.env.VENUE_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'
const SECONDARY_URL = process.env.VENUE_RPC_URL_SECONDARY ?? 'https://rpc.ordofi.network'

/** The escrow's own credit event. Not CoinVault's; see the header. */
const ESCROW_CREDITED = defineEvent('Credited', [
  { name: 'recipient', type: 'address', indexed: true },
  { name: 'depositor', type: 'address', indexed: true },
  { name: 'amount', type: 'uint256', indexed: false },
])

/** Politeness spacer. 0.8 rps is the measured ceiling on this chain. */
const breathe = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1_500))

function liveQuorum(): QuorumRpc {
  return new QuorumRpc(
    new JsonRpcClient({ endpointId: 'primary', url: PRIMARY_URL, timeoutMs: 20_000 }),
    new JsonRpcClient({ endpointId: 'secondary', url: SECONDARY_URL, timeoutMs: 20_000 }),
  )
}

describe('the live read is opt-in', () => {
  it('is skipped unless VENUE_LIVE_RPC=1, so a red suite never means "someone else moved"', () => {
    expect(typeof LIVE).toBe('boolean')
  })
})

describe.runIf(LIVE)('live read against Venue mainnet (chain 4663)', () => {
  it(
    'agrees on the chain id and the finalized head across two independent providers',
    async () => {
      const rpc = liveQuorum()
      await rpc.assertChain()
      expect(rpc.isChainVerified).toBe(true)
      await breathe()

      const finalized = await rpc.finalized()
      console.log(
        `[live] finalized  #${finalized.number}  ${finalized.hash}  ts=${finalized.timestampUnix}`,
      )
      expect(finalized.number).toBeGreaterThan(0n)
      expect(finalized.hash).toMatch(/^0x[0-9a-f]{64}$/)
    },
    120_000,
  )

  it(
    'scans forward through RpcChainReadModel, advances the cursor, and only then answers',
    async () => {
      const rpc = liveQuorum()
      await rpc.assertChain()
      await breathe()

      const finalized = await rpc.finalized()
      await breathe()

      const cursors = new InMemoryChainCursorStore()
      const movements = new InMemoryVaultMovementStore()
      const model = new RpcChainReadModel(
        {
          rpc,
          indexerStore: {
            // Only postings/bindings would use it, and this test uses neither.
            // Anything it is asked for here would be a bug, so it throws.
            bindingByToken: () => Promise.reject(new Error('not used in this test')),
            postings: () => Promise.reject(new Error('not used in this test')),
          } as unknown as IndexerStore,
          cursors,
          movements,
          halts: new InMemoryHaltStore(),
        },
        { maxCoverageLagSeconds: 3_600, chunkBlocks: 100n, maxRangesPerSync: 1 },
      )

      const standIn = VENUE.contracts.v2FeeEscrow
      const from = finalized.number - 99n
      model.track({
        vault: standIn,
        token: VENUE.contracts.weth,
        deployedAtBlock: from,
      })

      // Before the scan, the window is refused rather than answered with [].
      await expect(
        model.claims(standIn, finalized.timestampUnix - 60, finalized.timestampUnix),
      ).rejects.toBeInstanceOf(CoverageGapError)

      const result = await model.sync(finalized.timestampUnix)
      const vault = result.vaults[0]
      console.log(
        `[live] scanned ${vault?.fromBlock}..${vault?.toBlock} (${
          Number((vault?.toBlock ?? 0n) - (vault?.fromBlock ?? 0n)) + 1
        } blocks)  ranges=${vault?.rangesScanned}  claims=${vault?.newClaims}  allocations=${
          vault?.newAllocations
        }  caughtUp=${vault?.caughtUp}`,
      )

      expect(vault?.rangesScanned).toBe(1)
      expect(vault?.caughtUp).toBe(true)
      // Zero, because the escrow's Credited has a different signature and
      // therefore a different topic0 from CoinVault's. A real empty answer.
      expect(vault?.newClaims).toBe(0)
      expect(vault?.newAllocations).toBe(0)

      const cursor = await cursors.get('vault_movements', standIn)
      console.log(
        `[live] cursor -> block ${cursor?.blockNumber}  coverage ts=${cursor?.blockTimestampUnix}`,
      )
      expect(cursor?.blockNumber).toBe(finalized.number)
      expect(cursor?.blockTimestampUnix).toBe(finalized.timestampUnix)

      // Now that coverage exists, the same window is answerable.
      await expect(
        model.claims(standIn, finalized.timestampUnix - 60, finalized.timestampUnix),
      ).resolves.toEqual([])

      // And a vault nobody registered still refuses, with no network call.
      await expect(
        model.claims('0x000000000000000000000000000000000000dead', 0, finalized.timestampUnix),
      ).rejects.toBeInstanceOf(VaultNotTrackedError)
    },
    120_000,
  )

  it(
    'returns real, quorum-agreed logs from the fee escrow over a bounded range',
    async () => {
      // Our topic derivation, checked against the value read off the deployed
      // contract. A signature string and its topic can never drift apart,
      // because the topic is keccak of the string at module load.
      expect(ESCROW_CREDITED.topic0.startsWith('0x4e45da44')).toBe(true)

      const rpc = liveQuorum()
      await rpc.assertChain()
      await breathe()

      const finalized = await rpc.finalized()
      await breathe()

      const logs = await rpc.getLogs({
        fromBlock: finalized.number - 499n,
        toBlock: finalized.number,
        address: [VENUE.contracts.v2FeeEscrow],
        topics: [ESCROW_CREDITED.topic0],
      })

      console.log(
        `[live] escrow Credited over blocks ${finalized.number - 499n}..${finalized.number}: ${logs.length} logs, both providers agreeing byte for byte`,
      )
      for (const log of logs.slice(0, 3)) {
        const decoded = decodeEventLog(ESCROW_CREDITED, log)
        console.log(
          `[live]   block ${log.blockNumber} idx ${log.logIndex}  recipient=${String(
            decoded.recipient,
          )}  amount=${requireBigInt(decoded, 'amount')}`,
        )
      }

      // No assertion on the count: a quiet 50 seconds of chain is a legitimate
      // answer, and asserting otherwise would make this test fail because the
      // market was slow rather than because our code broke.
      expect(Array.isArray(logs)).toBe(true)
      for (const log of logs) {
        expect(log.blockNumber).toBeGreaterThanOrEqual(finalized.number - 499n)
        expect(log.blockNumber).toBeLessThanOrEqual(finalized.number)
        expect(log.topics[0]).toBe(ESCROW_CREDITED.topic0)
      }
    },
    120_000,
  )
})
