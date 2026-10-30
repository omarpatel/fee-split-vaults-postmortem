/**
 * The outbound scrubber.
 *
 * Every string this service sends that did not originate in this service goes
 * through here first. Two sources qualify: text a client posted during
 * onboarding (a coin name, a symbol), and text a model wrote after reading
 * attacker-authored input (a gist, a rationale, an escalation note).
 *
 * `scrubGist` removes anything that could name a destination or encode an
 * amount; `assertNoDestination` then re-checks the result and throws if one
 * survived. The second call is not redundant - it converts a hole in the
 * scrubber from a silent data leak into a loud 500.
 *
 * It lives in its own module because two route families need it and a duplicate
 * copy is how one of them ends up a version behind the other.
 */

import { assertNoDestination, scrubGist } from '@fee-split-vaults/core'

export function safeEcho(value: string, field: string): string {
  const scrubbed = scrubGist(value)
  assertNoDestination(scrubbed, field)
  return scrubbed
}
