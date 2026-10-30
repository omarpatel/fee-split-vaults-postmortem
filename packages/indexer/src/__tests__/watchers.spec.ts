import { describe, expect, it } from 'vitest'
import { FakeChain, FakeRpcClient } from '../fake-rpc.js'
import { QuorumRpc } from '../quorum.js'
import { InMemoryIndexerStore } from '../store.js'
import { InMemoryHaltSink, OVERRIDE_TIMELOCK_SECONDS, RecipientWatcher } from '../watchers.js'
import { StaleWatchError } from '../errors.js'
import { harness } from './harness.js'
import {
  addr,
  binding,
  issuedVault,
  launchCoin,
  newChain,
  pinLaunchedToken,
  recipientCancelledLog,
  recipientProposedLog,
  recipientUpdatedLog,
} from './helpers.js'

const TOKEN = addr(0xaa)
const VAULT = addr(0xa1)
const CURVE = addr(0xac)
const THIEF = addr(0xbad)
const SWEEP = 3_600

function launchedChain(recipient = VAULT) {
  const chain = newChain()
  chain.addBlock({ logs: [launchCoin(chain, { token: TOKEN, curve: CURVE, recipient })] })
  return chain
}

/** Re-point the factory record's recipient without changing anything else about the launch. */
function payNow(chain: FakeChain, recipient: string) {
  pinLaunchedToken(chain, { token: TOKEN, curve: CURVE, creatorFeeRecipient: recipient })
}

describe('RecipientWatcher', () => {
  function watcher(chain: FakeChain) {
    const rpc = new QuorumRpc(new FakeRpcClient(chain, 'a'), new FakeRpcClient(chain, 'b'))
    const store = new InMemoryIndexerStore()
    const sink = new InMemoryHaltSink()
    return {
      chain,
      sink,
      store,
      watcher: new RecipientWatcher(rpc, store, sink, { sweepIntervalSeconds: SWEEP }),
    }
  }

  const target = { token: TOKEN, vault: VAULT }

  it('confirms a healthy recipient against a hash-pinned read of getLaunchedToken', async () => {
    const w = watcher(launchedChain())

    const check = await w.watcher.check(target, w.chain.head(), 1_000)
    expect(check.ok).toBe(true)
    expect(check.observation?.blockHash).toBe(w.chain.head().hash)
    expect(check.launched?.curve).toBe(CURVE)
    expect(w.sink.notices).toHaveLength(0)
  })

  it('halts the moment the protocol pays someone else', async () => {
    const w = watcher(launchedChain(THIEF))

    const check = await w.watcher.check(target, w.chain.head(), 1_000)
    expect(check.ok).toBe(false)
    expect(w.sink.byReason('recipient_diverged')).toHaveLength(1)
    expect(w.sink.byReason('recipient_diverged')[0]?.detail).toContain(THIEF)
  })

  it('refuses to confirm a recipient off a record that contradicts the binding', async () => {
    const w = watcher(launchedChain())
    await w.store.putBindings([binding({ token: TOKEN, vault: VAULT, curve: addr(0xdead) })])

    await expect(w.watcher.check(target, w.chain.head(), 1_000)).rejects.toThrow(/binding the chain contradicts/)
    expect(await w.store.recipientObservation(TOKEN)).toBeUndefined()
    expect(w.watcher.lastConfirmedAt(target)).toBeUndefined()
  })

  it('refuses a record the factory says does not exist', async () => {
    const w = watcher(newChain())
    w.chain.addBlock()
    pinLaunchedToken(w.chain, { token: TOKEN, curve: CURVE, creatorFeeRecipient: VAULT, exists: false })

    await expect(w.watcher.check(target, w.chain.head(), 1_000)).rejects.toThrow(/no such launch/)
  })

  it('halts within one sweep interval when the chain is simply unreadable', async () => {
    const w = watcher(launchedChain())
    await w.watcher.check(target, w.chain.head(), 1_000)

    // Inside the interval, silence is tolerated.
    expect(await w.watcher.assertFresh(target, 1_000 + SWEEP)).toBeNull()
    // One second past it, an unconfirmed recipient is treated as a taken one.
    const stale = await w.watcher.assertFresh(target, 1_000 + SWEEP + 1)
    expect(stale?.reason).toBe('watch_stale')
    await expect(w.watcher.requireFresh(target, 1_000 + SWEEP + 1)).rejects.toThrow(StaleWatchError)
  })

  it('treats a never-confirmed vault as stale rather than healthy', async () => {
    const w = watcher(launchedChain())
    const stale = await w.watcher.assertFresh(target, 0)
    expect(stale?.reason).toBe('watch_stale')
    expect(stale?.detail).toContain('ever')
  })

  it('propagates a failed read instead of reporting the recipient unchanged', async () => {
    const w = watcher(newChain())
    w.chain.addBlock()
    // No pinned result: the call fails, exactly as an unreachable node would.
    await expect(w.watcher.check(target, w.chain.head(), 1_000)).rejects.toThrow()
    expect(await w.store.recipientObservation(TOKEN)).toBeUndefined()
  })
})

describe('recipient watching through a full tick', () => {
  it('halts a vault whose fee recipient has been reassigned', async () => {
    const chain = launchedChain(THIEF)
    chain.setFinalized(1n)
    const h = harness(chain, [issuedVault({ token: TOKEN, vault: VAULT })])

    const result = await h.indexer.tick(10_000)
    expect(result.halts.some((halt) => halt.reason === 'recipient_diverged')).toBe(true)
    expect((await h.store.recipientObservation(TOKEN))?.matches).toBe(false)
  })

  it('halts on the CreatorFeeRecipientUpdated event', async () => {
    const chain = launchedChain()
    chain.addBlock({
      logs: [recipientUpdatedLog({ token: TOKEN, previousRecipient: VAULT, newRecipient: THIEF })],
    })
    chain.setFinalized(2n)

    const h = harness(chain, [issuedVault({ token: TOKEN, vault: VAULT })])
    const result = await h.indexer.tick(10_000)

    const transferred = result.halts.filter((halt) => halt.reason === 'recipient_transferred')
    expect(transferred).toHaveLength(1)
    expect(transferred[0]?.detail).toContain('no timelock')
    expect(transferred[0]?.evidence?.txHash).toBeDefined()
  })

  it('records a read failure and, for a spending vault, escalates it to a halt', async () => {
    const chain = newChain()
    chain.addBlock()
    chain.setFinalized(1n)
    // No factory record at all: the read cannot succeed, exactly as an
    // unreachable or pruned node would behave.
    const h = harness(chain, [issuedVault({ token: TOKEN, vault: VAULT, spendAuthorityActive: true })])
    const result = await h.indexer.tick(10_000)

    expect(result.halts.some((halt) => halt.reason === 'read_failure')).toBe(true)
    expect(result.halts.some((halt) => halt.reason === 'watch_stale')).toBe(true)
  })

  it('re-reads on the vault cadence, and still catches a theft within one sweep interval', async () => {
    const chain = launchedChain()
    chain.setFinalized(1n)
    const h = harness(chain, [issuedVault({ token: TOKEN, vault: VAULT, spendAuthorityActive: true })], {
      sweepIntervalSeconds: SWEEP,
    })

    // Forty days old, so the decayed band is weekly and only the spend-authority
    // floor keeps this vault under observation at all.
    const t0 = 600 + 40 * 86_400
    const first = await h.indexer.tick(t0)
    expect(first.halts).toHaveLength(0)

    payNow(chain, THIEF)

    // A minute later the vault is not due, so no wasted quorum call.
    const soon = await h.indexer.tick(t0 + 60)
    expect(soon.halts.some((halt) => halt.reason === 'recipient_diverged')).toBe(false)
    expect((await h.store.recipientObservation(TOKEN))?.matches).toBe(true)

    // One sweep interval later it is due, and the theft surfaces.
    const later = await h.indexer.tick(t0 + SWEEP)
    expect(later.halts.some((halt) => halt.reason === 'recipient_diverged')).toBe(true)
    expect((await h.store.recipientObservation(TOKEN))?.matches).toBe(false)
  })

  it('refreshes the binding economics from the same read', async () => {
    const chain = launchedChain()
    chain.setFinalized(1n)
    const h = harness(chain, [issuedVault({ token: TOKEN, vault: VAULT, spendAuthorityActive: true })], {
      sweepIntervalSeconds: SWEEP,
    })
    await h.indexer.tick(1_000)
    expect((await h.store.bindingByToken(TOKEN))?.buybackEnabled).toBe(false)

    // The owner turns buyback on: the creator rate halves from the next posting.
    pinLaunchedToken(chain, { token: TOKEN, curve: CURVE, creatorFeeRecipient: VAULT, buybackEnabled: true })
    const result = await h.indexer.tick(1_000 + SWEEP)

    expect((await h.store.bindingByToken(TOKEN))?.buybackEnabled).toBe(true)
    expect(result.warnings.join(' ')).toContain('buyback false->true')
  })

  it('does not spam stale halts for an idle vault with no spend authority', async () => {
    const chain = launchedChain()
    chain.setFinalized(1n)
    const h = harness(chain, [issuedVault({ token: TOKEN, vault: VAULT, spendAuthorityActive: false })])
    const result = await h.indexer.tick(10_000)

    expect(result.halts.some((halt) => halt.reason === 'watch_stale')).toBe(false)
  })
})

describe('OwnerOverrideWatcher', () => {
  const EFFECTIVE = 10_000 + OVERRIDE_TIMELOCK_SECONDS
  const EXPIRES = EFFECTIVE + OVERRIDE_TIMELOCK_SECONDS

  function chainWithProposal(effectiveAtUnix = EFFECTIVE, expiresAtUnix = EXPIRES) {
    const chain = launchedChain()
    chain.addBlock({
      logs: [
        recipientProposedLog({
          token: TOKEN,
          currentRecipient: VAULT,
          proposedRecipient: THIEF,
          effectiveAtUnix,
          expiresAtUnix,
        }),
      ],
    })
    chain.setFinalized(2n)
    return chain
  }

  it('alerts at proposal time, not at execution time', async () => {
    const chain = chainWithProposal()
    const h = harness(chain, [issuedVault({ token: TOKEN, vault: VAULT })])

    const result = await h.indexer.tick(10_000)
    const proposed = result.halts.filter((halt) => halt.reason === 'owner_override_proposed')

    expect(proposed).toHaveLength(1)
    expect(proposed[0]?.detail).toContain(THIEF)
    expect(proposed[0]?.detail).toContain(String(EFFECTIVE))
    // The operational instruction that prevents stranded balances.
    expect(proposed[0]?.detail).toContain('Sweep and claim to zero')

    const pending = await h.store.overrides(TOKEN)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.effectiveAtUnix).toBe(EFFECTIVE)
    expect(pending[0]?.expiresAtUnix).toBe(EXPIRES)
    expect(pending[0]?.currentRecipient).toBe(VAULT)
    expect(pending[0]?.newRecipient).toBe(THIEF)
  })

  it('re-escalates once the timelock is nearly elapsed', async () => {
    const chain = chainWithProposal()
    const h = harness(chain, [issuedVault({ token: TOKEN, vault: VAULT })])

    await h.indexer.tick(10_000)
    h.sink.clear()

    const urgent = await h.indexer.overrideWatcher.review({ token: TOKEN, vault: VAULT }, EFFECTIVE - 60)
    expect(urgent).toHaveLength(1)
    expect(h.sink.byReason('owner_override_executable')).toHaveLength(1)
  })

  it('drops a proposal once its execution window has lapsed', async () => {
    const chain = chainWithProposal()
    const h = harness(chain, [issuedVault({ token: TOKEN, vault: VAULT })])

    await h.indexer.tick(10_000)
    h.sink.clear()

    const raised = await h.indexer.overrideWatcher.review({ token: TOKEN, vault: VAULT }, EXPIRES)
    expect(raised).toHaveLength(0)
    expect(await h.store.overrides(TOKEN)).toHaveLength(0)
  })

  it('clears a proposal the owner cancels', async () => {
    const chain = chainWithProposal()
    chain.addBlock({ logs: [recipientCancelledLog({ token: TOKEN, proposedRecipient: THIEF })] })
    chain.setFinalized(3n)
    const h = harness(chain, [issuedVault({ token: TOKEN, vault: VAULT })])

    const result = await h.indexer.tick(10_000)
    // The proposal still alerted when seen; the cancellation then withdrew it.
    expect(result.halts.filter((halt) => halt.reason === 'owner_override_proposed')).toHaveLength(1)
    expect(result.warnings.join(' ')).toContain('cancelled')
    expect(await h.store.overrides(TOKEN)).toHaveLength(0)
  })

  it('compresses the poll cadence while an override is pending', async () => {
    const t0 = 40 * 86_400
    const chain = chainWithProposal(t0 + OVERRIDE_TIMELOCK_SECONDS, t0 + 2 * OVERRIDE_TIMELOCK_SECONDS)
    const h = harness(chain, [issuedVault({ token: TOKEN, vault: VAULT, spendAuthorityActive: false })], {
      sweepIntervalSeconds: 86_400,
    })

    const result = await h.indexer.tick(t0)
    // A 40-day-old idle vault would otherwise be on the weekly band.
    expect(result.nextPollAtUnix - t0).toBeLessThanOrEqual(600)
  })
})
