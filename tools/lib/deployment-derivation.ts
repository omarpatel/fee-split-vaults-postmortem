/**
 * The two deployment constants apps/api needs, DERIVED rather than copied.
 *
 * THE DEFECT THIS CLOSES. `apps/api` refuses to boot without
 * VENUE_VAULT_INIT_CODE_HASH, and no file in the repository said where to get
 * one. The value is not a secret and not a deployment output: it is
 * keccak256 of CoinVault's compiled creation code, and that artifact is already
 * sitting in contracts/out/. Copying the hash into a constant would have worked
 * once and then rotted silently the first time CoinVault.sol changed -- and a
 * stale init-code hash does not fail loudly, it predicts a wrong vault address,
 * which is a dev pointing their fee revenue at a contract that does not exist.
 * So it is computed from the artifact on every run.
 *
 * TWO SOLIDITY FACTS ARE LOAD-BEARING HERE, and both are pinned by
 * contracts/test/unit/DerivedDeployment.t.sol rather than assumed:
 *
 *   1. CoinVault takes NO constructor arguments -- it reads its terms back from
 *      VaultDeployer.pendingConsent() during construction -- so the init code is
 *      the artifact bytecode with nothing appended. VaultFactory documents this
 *      as the reason VAULT_INIT_CODE_HASH can be `immutable` rather than
 *      per-consent.
 *
 *   2. factory.deployer() is the factory's nonce-1 CREATE, so it is derivable
 *      from a factory address by RLP arithmetic with no chain access at all.
 *
 * REPRODUCIBILITY. contracts/foundry.toml sets `bytecode_hash = "none"` and
 * `cbor_metadata = false`, so the init code carries no metadata trailer and does
 * not depend on the compiler's view of file paths. Two people on two machines
 * hashing the same source get the same 32 bytes. If that ever changes, the hash
 * becomes machine-dependent and this whole approach has to be revisited --
 * `assertDeterministicBuildSettings()` below is the tripwire.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bytesToHex, hexToBytes, keccak256Bytes } from './keccak.ts'

/**
 * contracts/, resolved against this file rather than the working directory, so
 * a run from any cwd reads the same artifacts. Same rule as TOOLS_DIR in
 * ./env.ts; not imported from there because this module must stay free of the
 * protocol config, which env.ts loads at import time.
 */
export const CONTRACTS_DIR = join(import.meta.dirname, '..', '..', 'contracts')

export class DerivationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DerivationError'
  }
}

/** The slice of a Foundry artifact this module reads. */
export interface ForgeArtifact {
  bytecode?: {
    object?: unknown
    linkReferences?: unknown
  }
}

/**
 * keccak256 of a contract's creation code, from its Foundry artifact.
 *
 * Refuses rather than guesses on every shape it does not fully understand,
 * because each one produces a WRONG HASH rather than an error downstream:
 *
 *   - a missing or non-string bytecode object (wrong artifact, or a compile
 *     that produced an interface);
 *   - empty bytecode (an abstract contract or an interface, whose creation code
 *     is `0x` -- hashing that returns the well-known hash of the empty string,
 *     which is a perfectly valid 32 bytes that is wrong for every purpose);
 *   - unresolved library link references, whose `__$...$__` placeholders are
 *     part of the string being hashed and are NOT the bytes that get deployed.
 */
export function vaultInitCodeHashFromArtifact(artifact: ForgeArtifact, label = 'artifact'): string {
  const object = artifact.bytecode?.object
  if (typeof object !== 'string') {
    throw new DerivationError(
      `${label}: bytecode.object is ${object === undefined ? 'missing' : typeof object}, expected a hex string. ` +
        'Is this a Foundry artifact for a concrete contract?',
    )
  }
  if (!/^0x[0-9a-fA-F]*$/.test(object)) {
    throw new DerivationError(`${label}: bytecode.object is not 0x-prefixed hex`)
  }
  if (object.length % 2 !== 0) {
    throw new DerivationError(`${label}: bytecode.object has an odd number of hex digits`)
  }
  if (object.length <= 2) {
    throw new DerivationError(
      `${label}: bytecode.object is empty. An interface or abstract contract has no creation code, ` +
        'and hashing the empty string would yield a valid-looking hash that predicts nothing.',
    )
  }
  const links = artifact.bytecode?.linkReferences
  if (links !== undefined && links !== null && typeof links === 'object' && Object.keys(links).length > 0) {
    throw new DerivationError(
      `${label}: bytecode has unresolved library link references (${Object.keys(links).join(', ')}). ` +
        'The placeholders are not the deployed bytes, so this hash would be wrong.',
    )
  }
  return bytesToHex(keccak256Bytes(hexToBytes(object)))
}

export interface InitCodeHashResult {
  initCodeHash: string
  /** Length of the creation code in bytes. Printed so a truncated read shows up. */
  initCodeBytes: number
  /** Absolute path the bytes came from. Provenance, not decoration. */
  artifactPath: string
}

/**
 * Reads contracts/out/CoinVault.sol/CoinVault.json and hashes it.
 *
 * ENOENT here means `forge build` has not been run, and the message says so:
 * contracts/out/ is gitignored, so a clean checkout genuinely does not have it,
 * and "no such file" on its own sends the reader looking for a missing tool.
 */
export function deriveVaultInitCodeHash(contractsDir: string = CONTRACTS_DIR): InitCodeHashResult {
  const artifactPath = join(contractsDir, 'out', 'CoinVault.sol', 'CoinVault.json')
  let raw: string
  try {
    raw = readFileSync(artifactPath, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      throw new DerivationError(
        `no CoinVault artifact at ${artifactPath}. contracts/out/ is gitignored, so a clean checkout ` +
          'has none. Build them first:  npm run contracts:build   (forge must be on PATH).',
      )
    }
    throw error
  }
  let artifact: ForgeArtifact
  try {
    artifact = JSON.parse(raw) as ForgeArtifact
  } catch {
    throw new DerivationError(`${artifactPath} is not valid JSON. Re-run: npm run contracts:build`)
  }
  const initCodeHash = vaultInitCodeHashFromArtifact(artifact, artifactPath)
  return {
    initCodeHash,
    initCodeBytes: (((artifact.bytecode?.object as string).length - 2) / 2) | 0,
    artifactPath,
  }
}

/**
 * Refuses if foundry.toml has stopped producing path-independent bytecode.
 *
 * With metadata in the init code the hash depends on the compiler's source
 * layout, so two machines derive two different hashes and only one of them
 * matches the deployed factory. That is a silent, machine-dependent wrong
 * answer, which is worse than no answer.
 */
export function assertDeterministicBuildSettings(contractsDir: string = CONTRACTS_DIR): void {
  const path = join(contractsDir, 'foundry.toml')
  let toml: string
  try {
    toml = readFileSync(path, 'utf8')
  } catch {
    throw new DerivationError(`cannot read ${path} to confirm the build is reproducible`)
  }
  const stripped = toml.replace(/^\s*#.*$/gm, '')
  if (!/bytecode_hash\s*=\s*"none"/.test(stripped) || !/cbor_metadata\s*=\s*false/.test(stripped)) {
    throw new DerivationError(
      `${path} no longer sets bytecode_hash="none" and cbor_metadata=false. With metadata in the init ` +
        'code the hash depends on the compiler\'s file paths, so it is no longer reproducible off-chain ' +
        'and must be read from a deployed factory instead.',
    )
  }
}

// ---------------------------------------------------------------------------
// CREATE address arithmetic
// ---------------------------------------------------------------------------

/** Minimal RLP for the two shapes CREATE needs: a byte string and a small list. */
function rlpBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 1 && (bytes[0] as number) < 0x80) return bytes
  if (bytes.length < 56) return Uint8Array.from([0x80 + bytes.length, ...bytes])
  throw new DerivationError('rlp: string longer than 55 bytes is not needed here')
}

function rlpList(items: readonly Uint8Array[]): Uint8Array {
  const payload = items.reduce<number[]>((acc, item) => [...acc, ...item], [])
  if (payload.length >= 56) throw new DerivationError('rlp: list longer than 55 bytes is not needed here')
  return Uint8Array.from([0xc0 + payload.length, ...payload])
}

/** Big-endian minimal-length encoding. Zero is the EMPTY string, not 0x00. */
function rlpUint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new DerivationError(`nonce must be a non-negative integer, got ${String(value)}`)
  }
  if (value === 0) return rlpBytes(new Uint8Array(0))
  const bytes: number[] = []
  let remaining = value
  while (remaining > 0) {
    bytes.unshift(remaining % 256)
    remaining = Math.floor(remaining / 256)
  }
  return rlpBytes(Uint8Array.from(bytes))
}

/**
 * last20(keccak256(rlp([sender, nonce]))) -- the plain CREATE address.
 *
 * Used for exactly one thing: `factory.deployer()`, which VaultFactory's
 * constructor creates and which is the CREATE2 base for every vault. Nonce 1,
 * not 0: a contract's account nonce starts at 1 (EIP-161), so the first
 * contract a constructor creates uses 1.
 *
 * Returns lowercase, matching normalizeAddress() in apps/api.
 */
export function contractAddressFromCreate(sender: string, nonce: number): string {
  const trimmed = sender.trim().toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(trimmed)) {
    throw new DerivationError(`sender must be a 0x address, got ${JSON.stringify(sender)}`)
  }
  const encoded = rlpList([rlpBytes(hexToBytes(trimmed)), rlpUint(nonce)])
  return bytesToHex(keccak256Bytes(encoded).subarray(12))
}

/** The nonce VaultFactory's constructor uses for `new VaultDeployer(...)`. */
export const VAULT_DEPLOYER_CREATE_NONCE = 1

/** factory.deployer(), from the factory address alone. */
export function deriveVaultDeployer(factory: string): string {
  return contractAddressFromCreate(factory, VAULT_DEPLOYER_CREATE_NONCE)
}

// ---------------------------------------------------------------------------
// CREATE2, so a bootstrapped environment can be checked end to end
// ---------------------------------------------------------------------------

/**
 * last20(keccak256(0xff ++ deployer ++ salt ++ initCodeHash)).
 *
 * The same arithmetic as apps/api's predictVault() and VaultFactory._predict().
 * It is here so the bootstrap can prove the triple it wrote is self-consistent
 * -- a factory, its derived deployer and the derived init-code hash predict a
 * well-formed address -- rather than writing three values nobody ever combines.
 */
export function predictCreate2(deployer: string, salt: string, initCodeHash: string): string {
  const deployerTrimmed = deployer.trim().toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(deployerTrimmed)) {
    throw new DerivationError(`deployer must be a 0x address, got ${JSON.stringify(deployer)}`)
  }
  for (const [name, value] of [
    ['salt', salt],
    ['initCodeHash', initCodeHash],
  ] as const) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(value.trim())) {
      throw new DerivationError(`${name} must be a 32-byte hex string, got ${JSON.stringify(value)}`)
    }
  }
  const preimage = Uint8Array.from([
    0xff,
    ...hexToBytes(deployerTrimmed),
    ...hexToBytes(salt.trim()),
    ...hexToBytes(initCodeHash.trim()),
  ])
  return bytesToHex(keccak256Bytes(preimage).subarray(12))
}
