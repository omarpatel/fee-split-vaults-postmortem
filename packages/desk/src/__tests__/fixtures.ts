/**
 * Shared fixtures. The default sheet is deliberately INCOMPLETE: holder counts,
 * the anti-snipe exempt list and the ledger figures are absent, because the
 * behaviour under a partial sheet is the behaviour that matters.
 */

import { VENUE } from '../../../../config/protocol.js'
import { buildFactSheet, type FactSheet } from '../factsheet/builder.js'
import {
  FakeDeskChainReader,
  FakeFeeLedger,
  FakeHolderIndex,
  type FakeChainState,
} from '../factsheet/chain-reader.js'
import { urlExplorer } from '../factsheet/render.js'
import type { InboundMessage } from '../message.js'
import { LinkPolicy } from '../moderation/blocklist.js'
import { ModerationEngine } from '../moderation/engine.js'
import type { OutboundOptions } from '../answer.js'

export const NOW = 1_757_000_000
export const VAULT = '0x1111111111111111111111111111111111111111'
export const TOKEN = '0x2222222222222222222222222222222222222222'
export const QUOTE = '0x3333333333333333333333333333333333333333'
export const RECIPIENT = '0x4444444444444444444444444444444444444444'
export const EXPLORER_BASE = 'https://explorer.example'

export const OUTBOUND: OutboundOptions = { operatorName: 'Example Ops Ltd' }

export function chainState(overrides: Partial<FakeChainState> = {}): FakeChainState {
  return {
    chainId: VENUE.chainId,
    block: { hash: '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', number: 56_321_180, timestampUnix: NOW },
    identity: { name: 'Example Coin', symbol: 'EXMP', decimals: 18 },
    supply: {
      totalSupplyMinor: 1_000_000_000_000000000000000000n,
      burnedMinor: 0n,
      lockedMinor: 200_000_000_000000000000000000n,
    },
    pool: {
      poolId: '0x0000000000000000000000000000000000000000000000000000000000000042',
      quoteAssetAddress: QUOTE,
      quoteAssetSymbol: 'USDG',
      quoteAssetDecimals: 6,
      quoteReserveMinor: 250_000_000000n,
      tokenReserveMinor: 500_000_000000000000000000n,
    },
    feeConfig: {
      buybackEnabled: false,
      creatorTaxBps: 0,
      feeRecipient: RECIPIENT,
    },
    lock: { lpLocked: true, unlockUnix: NOW + 86_400 * 365 },
    antiSnipe: { initialBps: 9_900, windowSeconds: 3 },
    launch: { launchUnix: NOW - 86_400 * 30 },
    ...overrides,
  }
}

export interface SheetOptions {
  state?: Partial<FakeChainState>
  withHolders?: boolean
  withLedger?: boolean
  nowUnix?: number
}

export async function makeSheet(options: SheetOptions = {}): Promise<FactSheet> {
  const reader = new FakeDeskChainReader(chainState(options.state))
  return buildFactSheet({
    vault: VAULT,
    token: TOKEN,
    tier: 'T1',
    reader,
    holders: options.withHolders
      ? new FakeHolderIndex({
          holderCount: 1_842,
          top10SharePct: 21.5,
          deployerSharePct: 3.2,
          observedAtUnix: options.nowUnix ?? NOW,
        })
      : undefined,
    ledger: options.withLedger
      ? new FakeFeeLedger({
          last24hUsd: { usd: 412.5, priceSource: 'test-oracle', pricedAtUnix: options.nowUnix ?? NOW },
          lifetimeUsd: { usd: 9_310.25, priceSource: 'test-oracle', pricedAtUnix: options.nowUnix ?? NOW },
          observedAtUnix: options.nowUnix ?? NOW,
        })
      : undefined,
    explorer: urlExplorer(EXPLORER_BASE, 'the chain 4663 explorer'),
    nowUnix: options.nowUnix ?? NOW,
  })
}

export function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'telegram',
    chatId: '-100200300',
    messageId: '9001',
    authorId: 'user-1',
    authorUsername: 'holder_one',
    authorDisplayName: 'Holder One',
    text: 'hello',
    sentAtUnix: NOW,
    ...overrides,
  }
}

export function makeModeration(overrides: Partial<ConstructorParameters<typeof ModerationEngine>[0]> = {}) {
  return new ModerationEngine({
    vault: VAULT,
    linkPolicy: new LinkPolicy({
      mode: 'allowlist',
      allowedHosts: ['explorer.example', 'examplecoin.io'],
      officialHosts: ['examplecoin.io'],
    }),
    admins: [{ userId: 'admin-1', username: 'example_admin', displayName: 'Example Admin' }],
    ...overrides,
  })
}
