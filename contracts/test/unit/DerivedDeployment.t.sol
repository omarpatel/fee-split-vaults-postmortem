// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {VaultFactory} from "../../src/VaultFactory.sol";
import {VaultDeployer} from "../../src/VaultDeployer.sol";
import {CoinVault} from "../../src/CoinVault.sol";

/**
 * THE TWO FACTS `tools/bootstrap-env.ts` DERIVES ITS CONFIG FROM.
 *
 * apps/api refuses to boot without VENUE_VAULT_INIT_CODE_HASH and
 * VENUE_VAULT_DEPLOYER, and until the bootstrap existed there was no documented
 * way to obtain either -- so the service could not be started by anyone from a
 * clean checkout. The bootstrap computes both off-chain instead of copying a
 * constant, and it may only do that if these two relationships hold:
 *
 *   1. VAULT_INIT_CODE_HASH is keccak256 of CoinVault's creation code and
 *      NOTHING ELSE. CoinVault takes no constructor arguments (it reads its
 *      terms back from `pendingConsent()` during construction), so there is no
 *      per-consent ABI encoding appended to the init code. That makes the hash
 *      a pure function of the compiled artifact in contracts/out/, which is
 *      what the bootstrap reads.
 *
 *   2. The CREATE2 base -- factory.deployer() -- is the FIRST contract the
 *      factory creates, at nonce 1. So it is derivable from the factory address
 *      alone by CREATE arithmetic, with no deployment and no RPC call.
 *
 * Both are structural claims about this repository's Solidity that TypeScript
 * cannot see. If either changes, the bootstrap silently starts producing wrong
 * vault addresses, and a wrong vault address means a dev points their fee
 * revenue at a contract that does not exist. That is what these tests are for.
 *
 * The mirrors are `vaultInitCodeHashFromArtifact()` and
 * `contractAddressFromCreate()` in tools/lib/deployment-derivation.ts, whose own
 * tests pin the numeric answers this file's log lines print.
 */
contract DerivedDeploymentTest is BaseTest {
    /// Fact 1. The published constant is the artifact hash, with no salt, no
    /// constructor tail, and no metadata (foundry.toml sets bytecode_hash=none
    /// and cbor_metadata=false so the init code does not depend on file paths).
    function test_initCodeHashIsPureArtifactHash() public {
        assertEq(
            factory.VAULT_INIT_CODE_HASH(),
            keccak256(type(CoinVault).creationCode),
            "VAULT_INIT_CODE_HASH must be keccak256(CoinVault creation code)"
        );
    }

    /// The deployer agrees with the factory about the same constant, so reading
    /// it from either contract gives the same answer as hashing the artifact.
    function test_deployerAgreesWithFactoryOnInitCodeHash() public {
        assertEq(factory.VAULT_INIT_CODE_HASH(), factory.deployer().vaultInitCodeHash());
    }

    /// Fact 2. deployer() is CREATE(factory, 1) -- the factory's constructor
    /// makes it, and a contract's first CREATE uses nonce 1 (EIP-161).
    function test_deployerIsCreateNonceOneOfTheFactory() public {
        assertEq(
            address(factory.deployer()),
            vm.computeCreateAddress(address(factory), 1),
            "deployer must be the factory's nonce-1 CREATE"
        );
    }

    /// The same, for a factory at an address nobody has seen before, so the
    /// result cannot be an accident of this fixture's deployment order.
    function test_deployerIsCreateNonceOneAtAnArbitraryFactoryAddress() public {
        VaultFactory fresh = new VaultFactory(operator);
        assertEq(address(fresh.deployer()), vm.computeCreateAddress(address(fresh), 1));
        assertEq(fresh.VAULT_INIT_CODE_HASH(), factory.VAULT_INIT_CODE_HASH());
    }

    /// The whole off-chain prediction, assembled from the two derived values
    /// plus a factory address, against what the chain actually does.
    function test_offChainPredictionFromDerivedValuesMatchesDeployment() public {
        consent.nonce = keccak256("derived-deployment");
        bytes32 salt = keccak256(abi.encode(consent));
        address deployer = vm.computeCreateAddress(address(factory), 1);
        bytes32 initCodeHash = keccak256(type(CoinVault).creationCode);
        address predicted =
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
        assertEq(_deploySigned(consent), predicted, "derived values must predict the real address");
    }

    /// Not an assertion: the ground truth the TypeScript test vectors were taken
    /// from. Run with -vv to print it.
    ///
    ///   forge test --root contracts --match-test test_logDerivationGroundTruth -vv
    function test_logDerivationGroundTruth() public {
        emit log_named_bytes32("initCodeHash", keccak256(type(CoinVault).creationCode));
        emit log_named_uint("initCodeLength", type(CoinVault).creationCode.length);
        emit log_named_address("exampleFactory", address(factory));
        emit log_named_address("exampleDeployer", address(factory.deployer()));
        // The DEV-ONLY factory address config/dev-only.ts publishes, and the
        // deployer the bootstrap derives from it. 32 leading zero nibbles is
        // not an address any CREATE or CREATE2 reaches, which is what lets the
        // production guard recognise it without a lookup table.
        emit log_named_address(
            "create_devOnlyFactory_nonce1",
            vm.computeCreateAddress(0x00000000000000000000000000000000DeaDBeef, 1)
        );
    }
}
