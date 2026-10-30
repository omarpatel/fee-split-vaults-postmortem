/**
 * DEV-ONLY CONFIGURATION VALUES, AND THE GUARD THAT REFUSES THEM IN PRODUCTION.
 *
 * WHY THIS FILE EXISTS. `apps/api` fails closed on a missing variable, which is
 * correct and stays. But three of the variables it requires cannot be obtained
 * without a deployment that does not exist yet:
 *
 *   VENUE_VAULT_FACTORY    the VaultFactory address. There is no VaultFactory on
 *                         chain 4663. config/protocol.ts lists Venue' own V2
 *                         contracts and nothing of ours.
 *   VENUE_VAULT_DEPLOYER   factory.deployer(), a CREATE from that address.
 *   VENUE_OPERATOR_API_TOKEN  a secret, which by definition nothing can derive.
 *
 * So a clean checkout could not start the service at all. The fix is NOT to
 * give those variables real-looking defaults: a default factory address is a
 * default answer to "where does this dev's money go", and the whole point of
 * the fail-closed loader is that nobody ever gets a plausible wrong answer to
 * that. The fix is a set of values that are UNMISTAKABLY FAKE, published in
 * source so they are public and therefore worthless as a secret, and REFUSED
 * BY THE LOADER the moment the process claims to be production.
 *
 * WHY THE ADDRESSES LOOK LIKE THAT. `0x00000000000000000000000000000000deadbeef`
 * has 32 leading zero nibbles. No CREATE or CREATE2 lands there: reaching it
 * would take roughly 2^128 attempts. So "is this the dev sentinel" needs no
 * lookup table and cannot false-positive on a real deployment, and the address
 * is obviously wrong in any log line a human reads.
 *
 * VENUE_VAULT_INIT_CODE_HASH IS NOT IN THIS FILE, deliberately. It is a real,
 * correct, derived value -- keccak256 of CoinVault's compiled creation code,
 * computed from contracts/out/ by tools/lib/deployment-derivation.ts. It will
 * still be right on the day a factory is deployed. Nothing about it is dev-only,
 * so faking it here would have hidden the one variable that was always
 * obtainable.
 *
 * WHAT THIS FILE IS NOT. It is not a way to run a degraded service. A process
 * holding these values can draft and verify consents against a factory that
 * does not exist; it cannot deploy a vault, activate a client, or move money,
 * because every one of those paths is separately unwired and separately fails
 * closed. See the NOT WIRED banner apps/api prints at boot.
 */

/** Marks an environment as bootstrap-generated. Refused when NODE_ENV=production. */
export const DEV_ONLY_MARKER_ENV = 'VENUE_DEV_ONLY_CONFIG'

/**
 * The published fake deployment.
 *
 * `deployer` is not a second arbitrary constant: it is CREATE(factory, 1), the
 * address a real VaultFactory at `factory` would put its VaultDeployer at,
 * cross-checked in contracts/test/unit/DerivedDeployment.t.sol. Keeping the
 * relationship true means a vault address predicted in local development is the
 * address that deployment would actually produce, so an off-by-one in the
 * CREATE2 preimage shows up locally instead of on chain.
 */
export const DEV_ONLY = {
  factory: '0x00000000000000000000000000000000deadbeef',
  deployer: '0xa97d2be8afcfcff4b5726fe707ccc6785ac4d51c',
  /**
   * Public by construction. It is in git, so it protects nothing, and it says
   * so in its own text: anything that reads the value can see it is not a
   * credential. 45 characters, over the 32-character floor the loader enforces.
   */
  operatorApiToken: 'dev-only-token-published-in-git-not-a-secret',
  /**
   * https because VENUE_RECEIPTS_BASE_URL must be, and `.invalid` because
   * RFC 2606 reserves it to never resolve. A receipt link built from this is
   * visibly a local link rather than a promise nobody can keep.
   */
  receiptsBaseUrl: 'https://receipts.localhost.invalid',
  /**
   * Passes packages/core's placeholder predicate on purpose -- a name that the
   * predicate rejected could not boot anything -- while naming no real entity.
   * It is refused in production by the marker and by this exact-match list.
   */
  operatorName: 'DEV ONLY local bootstrap, not a legal entity',
} as const

/** Case-insensitive membership, for values the loader must refuse in production. */
const DEV_ONLY_STRINGS: readonly string[] = [
  DEV_ONLY.factory,
  DEV_ONLY.deployer,
  DEV_ONLY.operatorApiToken,
  DEV_ONLY.receiptsBaseUrl,
  DEV_ONLY.operatorName,
]

export function isDevOnlyValue(value: string | undefined | null): boolean {
  if (value === undefined || value === null) return false
  const trimmed = value.trim().toLowerCase()
  if (trimmed.length === 0) return false
  return DEV_ONLY_STRINGS.some((known) => known.toLowerCase() === trimmed)
}

/**
 * True for any address no CREATE or CREATE2 can reach.
 *
 * The structural half of the guard, and the half that survives someone copying
 * a value out of .env.local without the marker line above it. 24 leading zero
 * nibbles is a 96-bit search; the sentinels here carry 32.
 */
export const MIN_UNREACHABLE_LEADING_ZERO_NIBBLES = 24

export function isStructurallyUnreachableAddress(value: string | undefined | null): boolean {
  if (typeof value !== 'string') return false
  const trimmed = value.trim().toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(trimmed)) return false
  const digits = trimmed.slice(2)
  let zeros = 0
  while (zeros < digits.length && digits[zeros] === '0') zeros += 1
  return zeros >= MIN_UNREACHABLE_LEADING_ZERO_NIBBLES
}

/** True when the process claims to be production. Anything else is not. */
export function isProductionEnv(env: { NODE_ENV?: string | undefined }): boolean {
  return (env.NODE_ENV ?? '').trim().toLowerCase() === 'production'
}
