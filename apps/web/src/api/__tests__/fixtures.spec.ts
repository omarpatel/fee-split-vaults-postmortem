import { describe, expect, it } from 'vitest'

import { splitCredit } from '../../domain/fees.js'
import { partitionByLag, PUBLISH_LAG_SECONDS } from '../../domain/lag.js'
import { usdToCents } from '../../domain/money.js'
import { TIERS, TIER_ORDER } from '../../protocol.js'
import { demoSignature } from '../../wallet/demo-signature.js'
import { ApiError } from '../client.js'
import { FixtureApiClient } from '../fixtures/client.js'

const NOW = 1_780_000_000

function client(): FixtureApiClient {
  return new FixtureApiClient({ now: () => NOW })
}

async function signIn(api: FixtureApiClient, address: string) {
  const challenge = await api.requestChallenge(address)
  return await api.verifySignature(address, challenge.message, demoSignature(address, challenge.message))
}

describe('the fixture backend', () => {
  it('offers a coin at every tier', async () => {
    const coins = await client().listCoins()
    const tiers = new Set(coins.map((coin) => coin.tier))
    for (const tier of TIER_ORDER) expect(tiers.has(tier)).toBe(true)
  })

  it('shows no coin at a tier its own fee flow could not have earned', async () => {
    // The demo dataset is the only place a coin's tier is asserted rather than
    // computed, so nothing else can catch a badge the real pipeline would have
    // refused. Checked against the live gates, not against a remembered number:
    // when a gate moves, this is where a stale seed coin surfaces.
    for (const coin of await client().listCoins()) {
      expect(coin.qfPerDayUsd, `${coin.symbol} is badged ${coin.tier}`).toBeGreaterThanOrEqual(
        TIERS[coin.tier].gateQfPerDay,
      )
    }
  })

  it('offers coins on both sides of the buyback branch', async () => {
    const coins = await client().listCoins()
    expect(coins.some((coin) => coin.buybackEnabled)).toBe(true)
    expect(coins.some((coin) => !coin.buybackEnabled)).toBe(true)
  })

  it('reports fee legs that match the split arithmetic exactly', async () => {
    const api = client()
    for (const summary of await api.listCoins()) {
      const coin = await api.getCoin(summary.vault)
      const split = splitCredit(
        coin.period.qfGrossCents,
        {
          operatorBps: coin.operatorBps,
          budgetBps: coin.budgetBps,
          referrerBps: coin.referrerBps,
        },
        coin.state === 'ACTIVE',
      )
      expect(coin.period.devLegCents).toBe(split.dev)
      expect(coin.period.budgetCents).toBe(split.budget)
      expect(coin.period.operatorFeeCents).toBe(split.operator)
      expect(coin.period.referrerCents).toBe(split.referrer)
    }
  })

  it('derives the 7-day gross from the stated daily median', async () => {
    const api = client()
    for (const summary of await api.listCoins()) {
      const coin = await api.getCoin(summary.vault)
      expect(coin.period.qfGrossCents).toBe(usdToCents(coin.qfPerDayUsd * 7))
    }
  })

  it('gives every USD figure a price source', async () => {
    const api = client()
    for (const summary of await api.listCoins()) {
      const coin = await api.getCoin(summary.vault)
      for (const entry of coin.period.perAsset) {
        expect(entry.usd.priceSource.length).toBeGreaterThan(0)
        expect(entry.usd.blockHash).toBeDefined()
      }
    }
  })

  it('produces commitments inside the lag window that the public filter hides', async () => {
    const api = client()
    const flagship = (await api.listCoins()).find((coin) => coin.tier === 'T3')
    expect(flagship).toBeDefined()

    const page = await api.listReceipts(flagship?.vault ?? '')
    const partition = partitionByLag(page.items, NOW)

    expect(partition.withheldCount).toBeGreaterThan(0)
    expect(partition.published.length).toBeGreaterThan(0)
    for (const withheldCandidate of page.items) {
      if (partition.published.includes(withheldCandidate)) continue
      expect(withheldCandidate.executed).toBe(false)
      expect(NOW - withheldCandidate.occurredAtUnix).toBeLessThan(PUBLISH_LAG_SECONDS)
    }
  })

  it('publishes an unexecuted commitment once it is old enough', async () => {
    const api = client()
    const flagship = (await api.listCoins()).find((coin) => coin.tier === 'T3')
    const page = await api.listReceipts(flagship?.vault ?? '')
    const published = partitionByLag(page.items, NOW).published

    expect(published.some((item) => !item.executed)).toBe(true)
  })

  it('flags the related-party vendor wherever it appears', async () => {
    const api = client()
    const flagship = (await api.listCoins()).find((coin) => coin.tier === 'T3')
    const vendors = await api.listVendorScorecards(flagship?.vault ?? '')
    const related = vendors.find((vendor) => vendor.isRelatedParty)

    expect(related).toBeDefined()

    const page = await api.listReceipts(flagship?.vault ?? '')
    for (const item of page.items) {
      if (item.vendorId === related?.vendorId) expect(item.vendorIsRelatedParty).toBe(true)
    }
  })

  it('excludes withheld purchases from vendor spend', async () => {
    const api = client()
    const flagship = (await api.listCoins()).find((coin) => coin.tier === 'T3')
    const vendors = await api.listVendorScorecards(flagship?.vault ?? '')
    const failing = vendors.find((vendor) => vendor.predicatesFailed > 0)

    expect(failing).toBeDefined()
    expect(failing?.withheldCents).toBeGreaterThan(0n)
    // A vendor that failed everything it sold has no attributable spend, so its
    // cost per buyer must be absent rather than zero.
    if (failing?.attributedNewBuyers === 0) {
      expect(failing.costPerAttributedBuyerCents).toBeNull()
    }
  })

  it('never reports a cost per buyer of zero', async () => {
    const api = client()
    for (const summary of await api.listCoins()) {
      for (const vendor of await api.listVendorScorecards(summary.vault)) {
        expect(vendor.costPerAttributedBuyerCents).not.toBe(0n)
      }
    }
  })

  it('404s an unknown vault instead of inventing one', async () => {
    await expect(client().getCoin('0x'.padEnd(42, 'f'))).rejects.toBeInstanceOf(ApiError)
  })
})

describe('the fixture backend’s wallet auth', () => {
  it('issues a challenge that states what signing does not authorise', async () => {
    const api = client()
    const address = api.demoDevAddresses[0]?.devSigner ?? ''
    const challenge = await api.requestChallenge(address)

    expect(challenge.message).toContain('authorises no transfer')
    expect(challenge.message).toContain(challenge.nonce)
  })

  it('rejects a signature it cannot recompute', async () => {
    const api = client()
    const address = api.demoDevAddresses[0]?.devSigner ?? ''
    const challenge = await api.requestChallenge(address)

    await expect(
      api.verifySignature(address, challenge.message, `0x${'ab'.repeat(65)}`),
    ).rejects.toBeInstanceOf(ApiError)
  })

  it('rejects a signature over a different message', async () => {
    const api = client()
    const address = api.demoDevAddresses[0]?.devSigner ?? ''
    const challenge = await api.requestChallenge(address)

    await expect(
      api.verifySignature(address, `${challenge.message} `, demoSignature(address, challenge.message)),
    ).rejects.toBeInstanceOf(ApiError)
  })

  it('signs in and returns only the vaults that address controls', async () => {
    const api = client()
    const entry = api.demoDevAddresses[0]
    const session = await signIn(api, entry?.devSigner ?? '')

    expect(session.vaults).toEqual([entry?.vault])
    const mine = await api.listDevVaults(session)
    expect(mine.map((coin) => coin.vault)).toEqual([entry?.vault])
  })

  it('refuses a vault the signed-in address does not control', async () => {
    const api = client()
    const [mine, theirs] = api.demoDevAddresses
    const session = await signIn(api, mine?.devSigner ?? '')

    await expect(api.getDevVault(session, theirs?.vault ?? '')).rejects.toBeInstanceOf(ApiError)
  })

  it('refuses an unknown session token', async () => {
    const api = client()
    const entry = api.demoDevAddresses[0]
    await expect(
      api.getDevVault(
        { token: 'forged', address: entry?.devSigner ?? '', expiresAtUnix: NOW + 600, vaults: [] },
        entry?.vault ?? '',
      ),
    ).rejects.toBeInstanceOf(ApiError)
  })
})

describe('the fixture backend’s dev controls', () => {
  it('builds a setDial transaction addressed to the vault itself', async () => {
    const api = client()
    const entry = api.demoDevAddresses[0]
    const session = await signIn(api, entry?.devSigner ?? '')
    const tx = await api.buildDialTx(session, entry?.vault ?? '', 1_000)

    expect(tx.to).toBe(entry?.vault)
    expect(tx.value).toBe('0')
    expect(tx.data.startsWith('0x')).toBe(true)
  })

  it('refuses a dial above the vault’s frozen ceiling', async () => {
    const api = client()
    const entry = api.demoDevAddresses[0]
    const session = await signIn(api, entry?.devSigner ?? '')
    const coin = await api.getCoin(entry?.vault ?? '')

    await expect(
      api.buildDialTx(session, entry?.vault ?? '', coin.budgetBpsMax + 100),
    ).rejects.toBeInstanceOf(ApiError)
  })

  it('says in the summary that lowering the dial takes notice', async () => {
    const api = client()
    const entry = api.demoDevAddresses[0]
    const session = await signIn(api, entry?.devSigner ?? '')
    const coin = await api.getCoin(entry?.vault ?? '')
    const lower = await api.buildDialTx(session, entry?.vault ?? '', Math.max(0, coin.budgetBps - 500))

    expect(lower.summary).toContain('notice')
  })

  it('describes terminate() as unconditional and 100% to the dev', async () => {
    const api = client()
    const entry = api.demoDevAddresses[0]
    const session = await signIn(api, entry?.devSigner ?? '')
    const tx = await api.buildTerminateTx(session, entry?.vault ?? '')

    expect(tx.summary).toContain('100%')
    expect(tx.summary).toContain('cannot be refused')
  })
})

describe('the fixture backend’s onboarding', () => {
  it('predicts a vault address the client can reproduce', async () => {
    const api = client()
    const quote = await api.quoteConsent({
      devSigner: '0x00000000000000000000000000000000000000a1',
      devPayout: '0x00000000000000000000000000000000000000a2',
      token: '0x00000000000000000000000000000000000000a3',
      budgetBpsMax: 4_000,
    })

    expect(quote.predictedVault).toMatch(/^0x[0-9a-f]{40}$/)
    expect(quote.salt).toMatch(/^0x[0-9a-f]{64}$/)
    expect(quote.digest).toMatch(/^0x[0-9a-f]{64}$/)

    const again = await api.submitConsent({ consent: quote.consent, signature: `0x${'11'.repeat(65)}` })
    expect(again.vault).toBe(quote.predictedVault)
  })

  it('refuses a ceiling above what the operator offers', async () => {
    await expect(
      client().quoteConsent({
        devSigner: '0x00000000000000000000000000000000000000a1',
        devPayout: '0x00000000000000000000000000000000000000a2',
        token: '0x00000000000000000000000000000000000000a3',
        budgetBpsMax: 9_000,
      }),
    ).rejects.toBeInstanceOf(ApiError)
  })

  it('refuses a narrative source the real backend would refuse', async () => {
    const request = {
      devSigner: '0x00000000000000000000000000000000000000a1',
      devPayout: '0x00000000000000000000000000000000000000a2',
      token: '0x00000000000000000000000000000000000000a3',
      budgetBpsMax: 4_000,
    }
    await expect(
      client().quoteConsent({ ...request, narrativeSources: ['http://hydrant.example/launch'] }),
    ).rejects.toBeInstanceOf(ApiError)
    await expect(
      client().quoteConsent({ ...request, socials: { x: 'has space' } }),
    ).rejects.toBeInstanceOf(ApiError)
    const quote = await client().quoteConsent({
      ...request,
      narrativeSources: ['https://hydrant.example/launch'],
      socials: { x: 'hydrant_ops' },
    })
    expect(quote.predictedVault).toMatch(/^0x[0-9a-f]{40}$/)
  })

  it('returns claim transactions before the recipiency transfer', async () => {
    const api = client()
    const entry = api.demoDevAddresses[0]
    const coin = await api.getCoin(entry?.vault ?? '')
    const plan = await api.getRetrofitPlan(coin.identity.token, coin.identity.vault)

    expect(plan.claimTxs.length).toBeGreaterThan(0)
    for (const tx of plan.claimTxs) {
      expect(tx.summary).toContain('msg.sender-only')
    }
    expect(plan.transferTx.summary).toContain('LAST')
  })
})
