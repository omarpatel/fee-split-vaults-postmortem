/**
 * Client-side mirror of contracts/src/lib/ConsentLib.sol and the prediction
 * arithmetic in contracts/src/VaultFactory.sol.
 *
 * WHY THIS IS IN THE BROWSER. The onboarding flow shows the dev the vault
 * address before they sign, and the whole security story of that address is
 * that the salt preimage contains every economic term - so a different rate is
 * a different address and an existing customer is unrepricable. That argument
 * is worth nothing if the address on screen is simply whatever the operator's
 * API returned. This module recomputes it from the consent the dev is about to
 * sign, and the UI refuses to present a signing prompt when the local and
 * server predictions disagree.
 *
 * FIELD ORDER IS LOAD-BEARING. It matches `struct Consent` in ConsentLib.sol
 * and `Consent` in packages/core/src/types.ts. Reordering silently changes
 * every address ever predicted, so the order is asserted in the test suite
 * against the literal type string below.
 */

import { encodeStaticWords, wordFromAddress, wordFromBytes32, wordFromUint } from './abi.js'
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes, type Hex } from './hex.js'
import { keccak256 } from './keccak.js'

/** Wire-shaped consent. Numbers that are `uintN` on chain are bigint here. */
export interface ConsentStruct {
  devSigner: string
  devPayout: string
  /** Zero on the greenfield path, where bind() supplies the token later. */
  token: string
  termsHash: string
  operatorBps: number
  budgetBpsMax: number
  adapter: string
  referrer: string
  referrerBps: number
  expiryUnix: number
  nonce: string
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const

/**
 * The EIP-712 type string, byte for byte as ConsentLib.sol builds it. The
 * contract writes it as three adjacent string literals; concatenated they are
 * this. A test asserts the two agree by hashing.
 */
export const CONSENT_TYPE_STRING =
  'Consent(address devSigner,address devPayout,address token,bytes32 termsHash,' +
  'uint16 operatorBps,uint16 budgetBpsMax,address adapter,address referrer,' +
  'uint16 referrerBps,uint64 expiryUnix,bytes32 nonce)'

export const EIP712_DOMAIN_TYPE_STRING =
  'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'

/** Must match VaultFactory._buildDomainSeparator(). */
export const DOMAIN_NAME = 'VenueVaultFactory'
export const DOMAIN_VERSION = '1'

function hashUtf8(value: string): Uint8Array {
  return keccak256(utf8ToBytes(value))
}

/** The eleven consent words, in contract field order. Used by both hashes. */
function consentWords(c: ConsentStruct): Uint8Array[] {
  return [
    wordFromAddress(c.devSigner),
    wordFromAddress(c.devPayout),
    wordFromAddress(c.token),
    wordFromBytes32(c.termsHash),
    wordFromUint(BigInt(c.operatorBps), 16),
    wordFromUint(BigInt(c.budgetBpsMax), 16),
    wordFromAddress(c.adapter),
    wordFromAddress(c.referrer),
    wordFromUint(BigInt(c.referrerBps), 16),
    wordFromUint(BigInt(c.expiryUnix), 64),
    wordFromBytes32(c.nonce),
  ]
}

/**
 * ConsentLib.salt(): keccak256(abi.encode(consent)).
 *
 * abi.encode, NOT abi.encodePacked. Packed encoding of two adjacent uint16
 * fields is ambiguous, and ambiguity in a salt preimage is a collision.
 */
export function consentSalt(c: ConsentStruct): Hex {
  return bytesToHex(keccak256(encodeStaticWords(consentWords(c))))
}

/** ConsentLib.hashStruct(): the salt words prefixed with the typehash. */
export function consentStructHash(c: ConsentStruct): Hex {
  const typeHash = hashUtf8(CONSENT_TYPE_STRING)
  return bytesToHex(keccak256(encodeStaticWords([typeHash, ...consentWords(c)])))
}

export function domainSeparator(chainId: number, verifyingContract: string): Hex {
  return bytesToHex(
    keccak256(
      encodeStaticWords([
        hashUtf8(EIP712_DOMAIN_TYPE_STRING),
        hashUtf8(DOMAIN_NAME),
        hashUtf8(DOMAIN_VERSION),
        wordFromUint(BigInt(chainId), 256),
        wordFromAddress(verifyingContract),
      ]),
    ),
  )
}

/** The exact digest the dev's wallet signs. VaultFactory.consentDigest(). */
export function consentDigest(
  c: ConsentStruct,
  chainId: number,
  factory: string,
): Hex {
  const prefix = new Uint8Array([0x19, 0x01])
  return bytesToHex(
    keccak256(
      concatBytes(
        prefix,
        hexToBytes(domainSeparator(chainId, factory)),
        hexToBytes(consentStructHash(c)),
      ),
    ),
  )
}

/**
 * CREATE2 prediction.
 *
 * The deploying contract is the VaultDeployer, NOT the factory: the factory
 * holds the deployer as an immutable and CoinVault's init code lives there.
 * Predicting against the factory address produces a plausible-looking but
 * entirely wrong address, so the caller must pass `deployer`.
 */
export function predictCreate2(deployer: string, salt: string, initCodeHash: string): Hex {
  const digest = keccak256(
    concatBytes(
      new Uint8Array([0xff]),
      hexToBytes(deployer),
      hexToBytes(salt),
      hexToBytes(initCodeHash),
    ),
  )
  return bytesToHex(digest.subarray(12)).toLowerCase() as Hex
}

export interface VaultDeploymentAddresses {
  chainId: number
  factory: string
  /** The CREATE2 deployer. Vault addresses derive from this, not the factory. */
  vaultDeployer: string
  vaultInitCodeHash: string
}

export function predictVaultAddress(c: ConsentStruct, d: VaultDeploymentAddresses): Hex {
  return predictCreate2(d.vaultDeployer, consentSalt(c), d.vaultInitCodeHash)
}

/**
 * `deployUnsigned` forces operatorBps and budgetBpsMax to zero BEFORE computing
 * the salt, so the self-serve path lands at a different address than
 * predictVault of the same consent. Mirrored here so the UI cannot show the
 * signed-path address next to an unsigned-path button.
 */
export function normaliseUnsigned(c: ConsentStruct): ConsentStruct {
  return { ...c, operatorBps: 0, budgetBpsMax: 0 }
}

/**
 * The typed-data object handed to eth_signTypedData_v4. Field order in `types`
 * is what the wallet encodes, so it mirrors CONSENT_TYPE_STRING exactly.
 */
export interface Eip712TypedData {
  types: Record<string, Array<{ name: string; type: string }>>
  primaryType: 'Consent'
  domain: { name: string; version: string; chainId: number; verifyingContract: string }
  message: Record<string, string | number>
}

export function consentTypedData(
  c: ConsentStruct,
  d: VaultDeploymentAddresses,
): Eip712TypedData {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      Consent: [
        { name: 'devSigner', type: 'address' },
        { name: 'devPayout', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'termsHash', type: 'bytes32' },
        { name: 'operatorBps', type: 'uint16' },
        { name: 'budgetBpsMax', type: 'uint16' },
        { name: 'adapter', type: 'address' },
        { name: 'referrer', type: 'address' },
        { name: 'referrerBps', type: 'uint16' },
        { name: 'expiryUnix', type: 'uint64' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'Consent',
    domain: {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId: d.chainId,
      verifyingContract: d.factory,
    },
    message: {
      devSigner: c.devSigner,
      devPayout: c.devPayout,
      token: c.token,
      termsHash: c.termsHash,
      operatorBps: c.operatorBps,
      budgetBpsMax: c.budgetBpsMax,
      adapter: c.adapter,
      referrer: c.referrer,
      referrerBps: c.referrerBps,
      expiryUnix: c.expiryUnix,
      nonce: c.nonce,
    },
  }
}
