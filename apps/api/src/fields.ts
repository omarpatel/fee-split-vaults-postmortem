/**
 * Field readers shared by the operator route map and the /v1 web routes.
 * Every one refuses rather than coerces, like the primitives in http/json.ts.
 */

import type { Address } from '@fee-split-vaults/core'
import { narrativeSourceUrlProblem } from '@fee-split-vaults/adapters'

import { isAddress, isBytes32, normalizeAddress } from './crypto/address.js'
import { assertExactKeys, requireObject, requireString, requireStringArray } from './http/json.js'
import { badRequest } from './http/router.js'
import type { OnboardingSocials } from './onboarding.js'

export const MAX_NARRATIVE_SOURCES = 4
/** An X handle as the dev typed it, optional leading '@'. */
const X_HANDLE = /^@?[A-Za-z0-9_]{1,15}$/

export function requireAddressField(source: Record<string, unknown>, field: string): Address {
  const value = source[field]
  if (!isAddress(value)) throw badRequest('bad_address', `${field} must be a 0x address`)
  return normalizeAddress(value)
}

export function requireBytes32Field(source: Record<string, unknown>, field: string): string {
  const value = source[field]
  if (!isBytes32(value)) throw badRequest('bad_bytes32', `${field} must be a 32-byte hex string`)
  return value
}

/** Dev-named documents to derive the narrative from. Same host rules as a published link. */
export function requireNarrativeSources(body: Record<string, unknown>): string[] | undefined {
  if (body.narrativeSources === undefined) return undefined
  const urls = requireStringArray(body, 'narrativeSources', MAX_NARRATIVE_SOURCES, 2_048)
  for (const url of urls) {
    const problem = narrativeSourceUrlProblem(url)
    if (problem !== null) {
      throw badRequest('bad_narrative_source', `narrativeSources must be plain https URLs on public hosts (${problem})`)
    }
  }
  return [...new Set(urls)]
}

/** The dev's claimed handles. Stored for the operator; never public, never model-visible. */
export function requireSocials(body: Record<string, unknown>): OnboardingSocials | undefined {
  if (body.socials === undefined) return undefined
  const socials = requireObject(body.socials, 'socials')
  assertExactKeys(socials, ['x'], 'socials')
  const result: OnboardingSocials = {}
  if (socials.x !== undefined) {
    const handle = requireString(socials, 'x', 16)
    if (!X_HANDLE.test(handle)) throw badRequest('bad_x_handle', 'socials.x must be an X handle')
    result.x = handle.replace(/^@/, '')
  }
  return result
}
