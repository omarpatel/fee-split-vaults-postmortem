import { describe, expect, it } from 'vitest'
import { assertPinnedTopics, decodeLaunchedToken, VENUE_EVENTS, type VenueEventName } from '../abi.js'
import { DecodeError, EventShapeMismatchError } from '../errors.js'
import { VENUE } from '../protocol.js'
import { addr, encodeLaunchedToken, launchedToken } from './helpers.js'

describe('pinned topics', () => {
  it('agree with the verified census for every event the indexer consumes', () => {
    expect(() => assertPinnedTopics(VENUE.topics)).not.toThrow()
    for (const name of Object.keys(VENUE_EVENTS) as VenueEventName[]) {
      expect(VENUE_EVENTS[name].topic0).toBe(VENUE.topics[name])
    }
  })

  it('refuse to boot on a drifted or missing pin', () => {
    expect(() =>
      assertPinnedTopics({ ...VENUE.topics, TOKEN_LAUNCHED: `0x${'ab'.repeat(32)}` }),
    ).toThrow(EventShapeMismatchError)

    const { CURVE_BUY: _dropped, ...partial } = VENUE.topics
    expect(() => assertPinnedTopics(partial as Record<VenueEventName, string>)).toThrow(
      EventShapeMismatchError,
    )
  })
})

describe('decodeLaunchedToken', () => {
  it('round-trips the 15-word struct, including the signed tick spacing', () => {
    const launched = launchedToken({
      token: addr(0xaa),
      curve: addr(0xac),
      creatorFeeRecipient: addr(0xa1),
      tickSpacing: -60,
      creatorTaxBps: 250,
      buybackEnabled: true,
      phase: 2,
    })
    expect(decodeLaunchedToken(encodeLaunchedToken(launched))).toEqual(launched)
  })

  it('refuses a return of the wrong width rather than reading word 3 out of it', () => {
    expect(() => decodeLaunchedToken(`0x${'00'.repeat(32)}`)).toThrow(DecodeError)
  })
})
