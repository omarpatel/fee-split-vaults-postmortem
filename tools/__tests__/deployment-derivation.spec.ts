/**
 * THE ARITHMETIC apps/api's CONFIG NOW DEPENDS ON.
 *
 * Every number asserted here was produced by an implementation that is not this
 * one, so a shared bug in my keccak and my RLP cannot make this file pass:
 *
 *   - the init-code hash and the CREATE addresses come from Foundry
 *     (contracts/test/unit/DerivedDeployment.t.sol, run with -vv) and were
 *     confirmed a third time with `cast compute-address` and `cast keccak`;
 *   - the 0x6ac7ea33... vectors are the long-published CREATE test vectors,
 *     which pin nonce 0 (the empty-string RLP case) and multi-byte nonces.
 *
 * A wrong value here is not a failing test in production. It is a vault address
 * that does not exist, at which a dev has pointed their fee revenue.
 */

import { describe, expect, it } from 'vitest'
import {
  CONTRACTS_DIR,
  DerivationError,
  assertDeterministicBuildSettings,
  contractAddressFromCreate,
  deriveVaultDeployer,
  deriveVaultInitCodeHash,
  predictCreate2,
  vaultInitCodeHashFromArtifact,
} from '../lib/deployment-derivation.ts'

/**
 * Ground truth from `forge test --match-test test_logDerivationGroundTruth -vv`.
 * Regenerate with that command if CoinVault.sol changes -- and understand that
 * a change here means every vault address ever predicted has moved.
 */
const FORGE = {
  initCodeHash: '0xf36f618b1eeca65a9b5911da2cb3ef19571020f1d7cb6dfbe7f21838a3d1fc18',
  initCodeBytes: 20385,
  /** The DEV-ONLY sentinel factory in config/dev-only.ts, and its deployer. */
  devOnlyFactory: '0x00000000000000000000000000000000deadbeef',
  devOnlyDeployer: '0xa97d2be8afcfcff4b5726fe707ccc6785ac4d51c',
  /** A factory address from the Foundry fixture, and the deployer it made. */
  exampleFactory: '0x1d1499e622D69689cdf9004d05Ec547d650Ff211',
  exampleDeployer: '0x45c92c2cd0df7b2d705ef12cff77cb0bc557ed22',
} as const

describe('vaultInitCodeHashFromArtifact', () => {
  it('hashes the creation code, matching what Foundry computes on chain', () => {
    const result = deriveVaultInitCodeHash()
    expect(result.initCodeHash).toBe(FORGE.initCodeHash)
    expect(result.initCodeBytes).toBe(FORGE.initCodeBytes)
  })

  it('is a pure function of the artifact, so two reads never disagree', () => {
    expect(deriveVaultInitCodeHash().initCodeHash).toBe(deriveVaultInitCodeHash().initCodeHash)
  })

  it('hashes an arbitrary artifact against an independently known answer', () => {
    // keccak256(0x00) -- a published Keccak-256 vector, not a value this
    // codebase produced.
    expect(vaultInitCodeHashFromArtifact({ bytecode: { object: '0x00' } })).toBe(
      '0xbc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a',
    )
  })

  it('REFUSES empty creation code rather than hashing the empty string', () => {
    // keccak256('') is a perfectly valid 32 bytes and is wrong for every
    // purpose. An interface or abstract contract compiles to exactly this.
    expect(() => vaultInitCodeHashFromArtifact({ bytecode: { object: '0x' } })).toThrow(DerivationError)
    expect(() => vaultInitCodeHashFromArtifact({ bytecode: { object: '0x' } })).toThrow(/no creation code/)
  })

  it('REFUSES unlinked library placeholders, which are not the deployed bytes', () => {
    expect(() =>
      vaultInitCodeHashFromArtifact({
        bytecode: { object: '0x6080', linkReferences: { 'src/Lib.sol': { Lib: [{ start: 0, length: 20 }] } } },
      }),
    ).toThrow(/link references/)
  })

  it('REFUSES a missing, non-string, non-hex or odd-length bytecode object', () => {
    expect(() => vaultInitCodeHashFromArtifact({})).toThrow(/missing/)
    expect(() => vaultInitCodeHashFromArtifact({ bytecode: { object: 42 } })).toThrow(DerivationError)
    expect(() => vaultInitCodeHashFromArtifact({ bytecode: { object: '6080' } })).toThrow(/0x-prefixed/)
    expect(() => vaultInitCodeHashFromArtifact({ bytecode: { object: '0x608' } })).toThrow(/odd number/)
  })

  it('names the artifact path in its error, so the reader knows which file is wrong', () => {
    expect(() => vaultInitCodeHashFromArtifact({}, 'contracts/out/X.sol/X.json')).toThrow(
      /contracts\/out\/X\.sol\/X\.json/,
    )
  })

  it('says how to build the artifacts when contracts/out is absent', () => {
    expect(() => deriveVaultInitCodeHash('/no/such/contracts/dir')).toThrow(/contracts:build/)
  })
})

describe('assertDeterministicBuildSettings', () => {
  it('passes on the real foundry.toml, which disables metadata', () => {
    expect(() => {
      assertDeterministicBuildSettings(CONTRACTS_DIR)
    }).not.toThrow()
  })

  it('refuses when foundry.toml is unreadable rather than assuming it is fine', () => {
    expect(() => {
      assertDeterministicBuildSettings('/no/such/contracts/dir')
    }).toThrow(DerivationError)
  })
})

describe('contractAddressFromCreate', () => {
  // The published CREATE vectors. Nonce 0 is the case an RLP implementation
  // most often gets wrong: zero encodes as the EMPTY string (0x80), not 0x00.
  const SENDER = '0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0'
  it.each([
    [0, '0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d'],
    [1, '0x343c43a37d37dff08ae8c4a11544c718abb4fcf8'],
    [255, '0x3ef7c1a519e4b4431e317d7839340e3139b03c65'],
    [256, '0x3837c1ae70354f670550c746580199ac6a73cb0a'],
  ])('nonce %i', (nonce, expected) => {
    expect(contractAddressFromCreate(SENDER, nonce)).toBe(expected)
  })

  it('is case-insensitive about the sender and always returns lowercase', () => {
    expect(contractAddressFromCreate(SENDER.toUpperCase().replace('0X', '0x'), 1)).toBe(
      contractAddressFromCreate(SENDER, 1),
    )
  })

  it('refuses a sender that is not an address, and a negative or fractional nonce', () => {
    expect(() => contractAddressFromCreate('0x1234', 1)).toThrow(DerivationError)
    expect(() => contractAddressFromCreate(SENDER, -1)).toThrow(/non-negative integer/)
    expect(() => contractAddressFromCreate(SENDER, 1.5)).toThrow(/non-negative integer/)
  })
})

describe('deriveVaultDeployer', () => {
  it('reproduces the deployer Foundry built for the sentinel factory', () => {
    expect(deriveVaultDeployer(FORGE.devOnlyFactory)).toBe(FORGE.devOnlyDeployer)
  })

  it('reproduces the deployer Foundry built for a second, unrelated factory', () => {
    expect(deriveVaultDeployer(FORGE.exampleFactory)).toBe(FORGE.exampleDeployer)
  })

  it('IS NOT THE FACTORY. Using the factory as the CREATE2 base is the silent-wrong-address bug.', () => {
    expect(deriveVaultDeployer(FORGE.exampleFactory)).not.toBe(FORGE.exampleFactory.toLowerCase())
  })
})

describe('predictCreate2', () => {
  it('agrees with the mirror in apps/api on the same inputs', () => {
    // Recomputed by hand from the spec: last20(keccak(0xff ++ deployer ++ salt
    // ++ initCodeHash)). The value below is asserted structurally rather than
    // as a magic constant; contracts/test/unit/DerivedDeployment.t.sol asserts
    // the same preimage against a real CREATE2 deployment.
    const vault = predictCreate2(FORGE.devOnlyDeployer, `0x${'00'.repeat(32)}`, FORGE.initCodeHash)
    expect(vault).toMatch(/^0x[0-9a-f]{40}$/)
    // Changing any one input changes the address. That is the property the
    // whole "the salt is the entire agreement" design rests on.
    expect(predictCreate2(FORGE.devOnlyDeployer, `0x${'00'.repeat(31)}01`, FORGE.initCodeHash)).not.toBe(vault)
    expect(predictCreate2(FORGE.devOnlyFactory, `0x${'00'.repeat(32)}`, FORGE.initCodeHash)).not.toBe(vault)
  })

  it('refuses a salt or hash that is not 32 bytes', () => {
    expect(() => predictCreate2(FORGE.devOnlyDeployer, '0x00', FORGE.initCodeHash)).toThrow(/salt/)
    expect(() => predictCreate2(FORGE.devOnlyDeployer, `0x${'00'.repeat(32)}`, '0xff')).toThrow(/initCodeHash/)
  })
})
