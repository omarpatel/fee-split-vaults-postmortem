/** Shared fixture loading. Tests read recorded JSON, never a live endpoint. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RawLog } from '../lib/rpc.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures')

export function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T
}

export function loadFixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

interface RawLogJson {
  address: string
  topics: string[]
  data: string
  blockNumber: string
  blockHash: string
  transactionHash: string
  logIndex: number
  removed: boolean
}

/** JSON log rows carry blockNumber as a string; the reader wants bigint. */
export function toRawLogs(rows: readonly RawLogJson[]): RawLog[] {
  return rows.map((row) => ({
    address: row.address.toLowerCase(),
    topics: row.topics.map((t) => t.toLowerCase()),
    data: row.data,
    blockNumber: BigInt(row.blockNumber),
    blockHash: row.blockHash,
    transactionHash: row.transactionHash,
    logIndex: row.logIndex,
    removed: row.removed,
  }))
}

/**
 * The NATIVE credit event: Credited, 3 topics, 1 data word.
 *
 * There is deliberately no `quoteAsset` here. The address at indexed position 1
 * is the DEPOSITOR, and a fixture that named it "quoteAsset" is what let a
 * positional decoder look correct. Every credit in this fixture is ETH.
 */
export interface EscrowFixture {
  escrow: string
  eventSignature: string
  topic0: string
  genesisUnix: number
  blockTimeSeconds: number
  depositor: string
  nativeAsset: { address: string; symbol: string; decimals: number }
  priceUsdEth: number
  logs: RawLogJson[]
}

/** The ERC-20 side: CreditedToken, 4 topics, asset at indexed position 1. */
export interface EscrowTokenFixture {
  escrow: string
  eventSignature: string
  topic0: string
  depositor: string
  genesisUnix: number
  blockTimeSeconds: number
  assets: Array<{ address: string; symbol: string; decimals: number }>
  priceUsdBySymbol: Record<string, number>
  logs: RawLogJson[]
}

export interface PoolFeesFixture {
  hook: string
  factory: string
  sweepSignature: string
  sweepTopic0: string
  launchSignature: string
  launchTopic0: string
  genesisUnix: number
  blockTimeSeconds: number
  groundTruth: Array<{
    poolId: string
    token: string
    volumeMinor: string
    buybackEnabled: boolean
    creatorTaxBps: number
    sweeps: number
  }>
  sweepLogs: RawLogJson[]
  launchLogs: RawLogJson[]
}

export interface CurveFixture {
  source: string
  signature: string
  topic0: string
  expectedBps: number
  logs: RawLogJson[]
}
