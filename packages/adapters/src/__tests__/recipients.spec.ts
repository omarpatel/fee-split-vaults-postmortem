/**
 * The recipient reader against a two-provider fake chain: the read is pinned
 * to the agreed HEAD block hash, a token the factory does not know is a refusal
 * rather than an address, and the launch time is the block that carried the
 * TokenLaunched log - or an honest upper bound when the log is out of reach.
 */
import {
  FakeChain,
  FakeRpcClient,
  GET_LAUNCHED_TOKEN_SELECTOR,
  QuorumRpc,
  TOKEN_LAUNCHED,
  addressToTopic,
  encodeAddressArgCall,
  type Hex,
  type PinnedCall,
} from '@fee-split-vaults/indexer'
import { describe, expect, it } from 'vitest'
import { VENUE } from '../../../../config/protocol.js'
import { ChainRecipientReader, RecipientReadError } from '../chain/recipients.js'

const FACTORY = VENUE.contracts.v2Factory
const TOKEN = '0x1111111111111111111111111111111111111111'
const CURVE = '0x2222222222222222222222222222222222222222'
const VAULT = '0x3333333333333333333333333333333333333333'
const PAIR = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const GENESIS = 1_757_000_000

function word(value: bigint | string): string {
  if (typeof value === 'bigint') return value.toString(16).padStart(64, '0')
  return value.toLowerCase().replace(/^0x/, '').padStart(64, '0')
}

/** getLaunchedToken's 15-word struct, with `exists` last. */
function launchedTokenResult(input: { recipient: string; exists: boolean; token?: string }): Hex {
  return `0x${[
    input.token ?? TOKEN,
    CURVE,
    '0x01',
    input.recipient,
    PAIR,
    10_000n,
    10_000n,
    200n,
    0n,
    0n,
    0n,
    0n,
    0n,
    0n,
    input.exists ? 1n : 0n,
  ]
    .map(word)
    .join('')}` as Hex
}

interface Harness {
  chain: FakeChain
  rpc: QuorumRpc
  calls: PinnedCall[]
  reader: ChainRecipientReader
  /** Both providers report `head` as their latest block. */
  lag(head: bigint): void
}

/** Two providers over one chain; every eth_call either makes is recorded. */
function harness(options: { blocks: number; launchAtBlock?: number; scan?: bigint } = { blocks: 10 }): Harness {
  const chain = new FakeChain({ genesisUnix: GENESIS, blockSeconds: 2 })
  for (let n = 0; n < options.blocks; n++) {
    chain.addBlock(
      n === options.launchAtBlock
        ? {
            logs: [
              {
                address: FACTORY,
                topics: [TOKEN_LAUNCHED.topic0, addressToTopic(TOKEN), addressToTopic(CURVE), addressToTopic('0x' + '01'.padStart(40, '0'))],
                data: `0x${word(PAIR)}${word(1n)}${word(10_000n)}` as Hex,
              },
            ],
          }
        : {},
    )
  }
  const calls: PinnedCall[] = []
  const recording = (client: FakeRpcClient): FakeRpcClient => {
    const original = client.call.bind(client)
    client.call = async (request: PinnedCall): Promise<Hex> => {
      calls.push(request)
      return original(request)
    }
    return client
  }
  const a = recording(new FakeRpcClient(chain, 'a'))
  const b = recording(new FakeRpcClient(chain, 'b'))
  const rpc = new QuorumRpc(a, b)
  const reader = new ChainRecipientReader({ rpc, ...(options.scan === undefined ? {} : { launchScanBlocks: options.scan }) })
  return {
    chain,
    rpc,
    calls,
    reader,
    lag: (head) => {
      a.setHeadLag(Number(chain.height - head))
      b.setHeadLag(Number(chain.height - head))
    },
  }
}

describe('ChainRecipientReader.creatorFeeRecipient', () => {
  it('reads getLaunchedToken on the launch factory pinned to the agreed HEAD block hash, on both providers', async () => {
    const h = harness({ blocks: 10 })
    h.lag(6n)
    h.chain.setCallResultAnyBlock(FACTORY, encodeAddressArgCall(GET_LAUNCHED_TOKEN_SELECTOR, TOKEN), launchedTokenResult({ recipient: VAULT, exists: true }))

    await expect(h.reader.creatorFeeRecipient(TOKEN)).resolves.toBe(VAULT)

    const headHash = h.chain.blockAt(6n)?.hash
    expect(h.calls).toHaveLength(2)
    for (const call of h.calls) {
      expect(call.to.toLowerCase()).toBe(FACTORY.toLowerCase())
      expect(call.blockHash).toBe(headHash)
      expect(call.data).toBe(encodeAddressArgCall(GET_LAUNCHED_TOKEN_SELECTOR, TOKEN))
    }
  })

  it('refuses a token the factory has no record of rather than returning the zero recipient', async () => {
    const h = harness({ blocks: 4 })
    h.lag(3n)
    h.chain.setCallResultAnyBlock(
      FACTORY,
      encodeAddressArgCall(GET_LAUNCHED_TOKEN_SELECTOR, TOKEN),
      launchedTokenResult({ recipient: '0x' + '0'.repeat(40), exists: false }),
    )
    await expect(h.reader.creatorFeeRecipient(TOKEN)).rejects.toMatchObject({ code: 'token_not_launched' })
  })

  it('refuses a struct that describes a different token than the one asked about', async () => {
    const h = harness({ blocks: 4 })
    h.lag(3n)
    h.chain.setCallResultAnyBlock(
      FACTORY,
      encodeAddressArgCall(GET_LAUNCHED_TOKEN_SELECTOR, TOKEN),
      launchedTokenResult({ recipient: VAULT, exists: true, token: CURVE }),
    )
    await expect(h.reader.creatorFeeRecipient(TOKEN)).rejects.toBeInstanceOf(RecipientReadError)
  })

  it('propagates an RPC failure; a read that did not happen is never "still pointed"', async () => {
    const h = harness({ blocks: 4 })
    h.lag(3n)
    // No call result configured: the fake node errors, as a real one would on a bad read.
    await expect(h.reader.creatorFeeRecipient(TOKEN)).rejects.toThrow(/no fake result/)
  })
})

describe('ChainRecipientReader.launchedAtUnix', () => {
  it('is the timestamp of the block carrying TokenLaunched(token), found scanning back from the head', async () => {
    const h = harness({ blocks: 12, launchAtBlock: 4 })
    h.lag(10n)
    h.chain.setCallResultAnyBlock(FACTORY, encodeAddressArgCall(GET_LAUNCHED_TOKEN_SELECTOR, TOKEN), launchedTokenResult({ recipient: VAULT, exists: true }))

    await expect(h.reader.launchedAtUnix(TOKEN)).resolves.toBe(GENESIS + 4 * 2)
  })

  it('does not see a launch that is above the agreed head', async () => {
    const h = harness({ blocks: 12, launchAtBlock: 9, scan: 4n })
    h.lag(6n)
    h.chain.setCallResultAnyBlock(FACTORY, encodeAddressArgCall(GET_LAUNCHED_TOKEN_SELECTOR, TOKEN), launchedTokenResult({ recipient: VAULT, exists: true }))

    // Scan window is blocks 3..6; the log at 9 is above the head. The answer
    // is the oldest scanned block's time, an upper bound, not the log's.
    await expect(h.reader.launchedAtUnix(TOKEN)).resolves.toBe(GENESIS + 3 * 2)
  })

  it('returns the oldest scanned block time as an upper bound when the launch predates the scan window', async () => {
    const h = harness({ blocks: 20, launchAtBlock: 1, scan: 5n })
    h.lag(18n)
    h.chain.setCallResultAnyBlock(FACTORY, encodeAddressArgCall(GET_LAUNCHED_TOKEN_SELECTOR, TOKEN), launchedTokenResult({ recipient: VAULT, exists: true }))

    const bound = await h.reader.launchedAtUnix(TOKEN)
    // Window is 14..18. The true launch (block 1) is earlier than the bound.
    expect(bound).toBe(GENESIS + 14 * 2)
    expect(bound).toBeGreaterThan(GENESIS + 1 * 2)
  })

  it('refuses to date a token the factory does not know, rather than scanning for a launch that never happened', async () => {
    const h = harness({ blocks: 6 })
    h.lag(5n)
    h.chain.setCallResultAnyBlock(
      FACTORY,
      encodeAddressArgCall(GET_LAUNCHED_TOKEN_SELECTOR, TOKEN),
      launchedTokenResult({ recipient: VAULT, exists: false }),
    )
    await expect(h.reader.launchedAtUnix(TOKEN)).rejects.toMatchObject({ code: 'token_not_launched' })
  })
})
