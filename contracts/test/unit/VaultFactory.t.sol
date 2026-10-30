// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {VaultFactory} from "../../src/VaultFactory.sol";
import {CoinVault} from "../../src/CoinVault.sol";
import {Consent, ConsentLib} from "../../src/lib/ConsentLib.sol";
import {SignatureLib} from "../../src/lib/SignatureLib.sol";
import {VaultState} from "../../src/interfaces/ICoinVault.sol";
import {Wallet1271} from "../mocks/Mocks.sol";

contract VaultFactoryTest is BaseTest {
    function test_predictionMatchesDeployment() public {
        Consent memory c = _baseConsent();
        c.nonce = keccak256("predict");
        address predicted = factory.predictVault(c);
        address actual = _deploySigned(c);
        assertEq(actual, predicted, "CREATE2 prediction must be exact");
    }

    /// The prediction must be reproducible off-chain from published constants
    /// alone, which is what packages/chain will do. No contract call required.
    function test_predictionIsPureCreate2() public view {
        Consent memory c = _baseConsent();
        bytes32 salt = keccak256(abi.encode(c));
        address expected = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff), address(factory.deployer()), salt, factory.VAULT_INIT_CODE_HASH()
                        )
                    )
                )
            )
        );
        assertEq(factory.predictVault(c), expected);
        assertEq(factory.saltOf(c), salt);
    }

    // -----------------------------------------------------------------------
    // The salt is the whole agreement: a different term is a different address.
    // -----------------------------------------------------------------------

    function test_everyEconomicTermChangesTheAddress() public view {
        Consent memory base = _baseConsent();
        address a0 = factory.predictVault(base);

        Consent memory c;

        c = _baseConsent();
        c.operatorBps = OPERATOR_BPS + 1;
        assertTrue(factory.predictVault(c) != a0, "operatorBps must be in the salt");

        c = _baseConsent();
        c.budgetBpsMax = BUDGET_BPS_MAX - 1;
        assertTrue(factory.predictVault(c) != a0, "budgetBpsMax must be in the salt");

        c = _baseConsent();
        c.adapter = address(this);
        assertTrue(factory.predictVault(c) != a0, "adapter must be in the salt");

        c = _baseConsent();
        c.referrer = address(0xBEEF);
        assertTrue(factory.predictVault(c) != a0, "referrer must be in the salt");

        c = _baseConsent();
        c.referrerBps = REFERRER_BPS + 1;
        assertTrue(factory.predictVault(c) != a0, "referrerBps must be in the salt");

        c = _baseConsent();
        c.devPayout = address(0xCAFE);
        assertTrue(factory.predictVault(c) != a0, "devPayout must be in the salt");

        c = _baseConsent();
        c.termsHash = keccak256("MSA v2");
        assertTrue(factory.predictVault(c) != a0, "termsHash must be in the salt");

        c = _baseConsent();
        c.token = address(0xD00D);
        assertTrue(factory.predictVault(c) != a0, "token must be in the salt");
    }

    /**
     * The anti-repricing property, stated as a test. An operator who wants a
     * higher rate from an existing customer cannot get one: the old address is
     * occupied and cannot be redeployed, and the new rate lives somewhere else
     * entirely, at an address the dev has never pointed fee recipiency at.
     */
    function test_existingCustomerCannotBeRepriced() public {
        Consent memory c = _baseConsent();
        c.nonce = keccak256("reprice");
        address v = _deploySigned(c);

        // Rebuilt, not copied: `Consent memory x = c` aliases in Solidity and
        // would mutate `c` underneath us.
        Consent memory hiked = _baseConsent();
        hiked.nonce = keccak256("reprice");
        hiked.operatorBps = 1_500;
        address hikedAddr = factory.predictVault(hiked);
        assertTrue(hikedAddr != v, "a repriced consent is a different address");

        // And the original address cannot be redeployed at any price.
        bytes memory sig = _sign(c);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.AlreadyDeployed.selector, v));
        factory.deploy(c, sig);

        assertEq(uint256(CoinVault(payable(v)).OPERATOR_BPS()), OPERATOR_BPS);
    }

    // -----------------------------------------------------------------------
    // Signature handling
    // -----------------------------------------------------------------------

    function test_deployRejectsForeignSignature() public {
        Consent memory c = _baseConsent();
        c.nonce = keccak256("foreign");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, factory.consentDigest(c));
        vm.expectRevert(SignatureLib.InvalidSigner.selector);
        factory.deploy(c, abi.encodePacked(r, s, v));
    }

    function test_deployRejectsMalleableSignature() public {
        Consent memory c = _baseConsent();
        c.nonce = keccak256("malleable");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(devKey, factory.consentDigest(c));

        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 flipped = bytes32(n - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;

        vm.expectRevert(SignatureLib.MalleableSignature.selector);
        factory.deploy(c, abi.encodePacked(r, flipped, flippedV));
    }

    function test_deployRejectsExpiredConsent() public {
        Consent memory c = _baseConsent();
        c.nonce = keccak256("expired");
        bytes memory sig = _sign(c);
        vm.warp(uint256(c.expiryUnix) + 1);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.ConsentExpired.selector, c.expiryUnix));
        factory.deploy(c, sig);
    }

    /// A smart-account dev must be able to consent, or the only alternative is
    /// an operator-deploys-for-you path that touches the dev leg.
    function test_deployAcceptsErc1271Signer() public {
        Wallet1271 w = new Wallet1271();
        Consent memory c = _baseConsent();
        c.devSigner = address(w);
        c.nonce = keccak256("1271");
        w.approve(factory.consentDigest(c));

        address v = factory.deploy(c, hex"00");
        assertEq(CoinVault(payable(v)).DEV_SIGNER(), address(w));
    }

    // -----------------------------------------------------------------------
    // Validation ceilings
    // -----------------------------------------------------------------------

    function test_rejectsOperatorBpsAboveStructuralCeiling() public {
        Consent memory c = _baseConsent();
        c.operatorBps = factory.MAX_OPERATOR_BPS() + 1;
        c.nonce = keccak256("too-high");
        bytes memory sig = _sign(c);
        vm.expectRevert(
            abi.encodeWithSelector(VaultFactory.OperatorBpsTooHigh.selector, c.operatorBps, factory.MAX_OPERATOR_BPS())
        );
        factory.deploy(c, sig);
    }

    function test_rejectsBudgetCeilingAboveStructuralCeiling() public {
        Consent memory c = _baseConsent();
        c.budgetBpsMax = factory.MAX_BUDGET_BPS_MAX() + 1;
        c.nonce = keccak256("dial-too-high");
        bytes memory sig = _sign(c);
        vm.expectRevert(
            abi.encodeWithSelector(
                VaultFactory.BudgetCeilingTooHigh.selector, c.budgetBpsMax, factory.MAX_BUDGET_BPS_MAX()
            )
        );
        factory.deploy(c, sig);
    }

    /**
     * The structural ceilings make DevShareWouldBeZero unreachable today
     * (2000 + 5000 < 10000); it is a backstop that only matters if a future
     * factory raises them. What is actually guaranteed is the floor below,
     * and that is the property worth pinning.
     */
    function testFuzz_devShareHasAHardFloor(uint16 opBps, uint16 dialMax) public {
        opBps = uint16(bound(opBps, 0, factory.MAX_OPERATOR_BPS()));
        dialMax = uint16(bound(dialMax, 0, factory.MAX_BUDGET_BPS_MAX()));

        Consent memory c = _baseConsent();
        c.operatorBps = opBps;
        c.budgetBpsMax = dialMax;
        c.nonce = keccak256(abi.encode("floor", opBps, dialMax));

        address v = factory.deploy(c, _sign(c));
        uint256 worstCaseDevBps = 10_000 - uint256(opBps) - uint256(dialMax);
        assertGe(worstCaseDevBps, 3_000, "dev keeps at least 30% at any legal dial");
        assertEq(uint256(CoinVault(payable(v)).OPERATOR_BPS()), opBps);
    }

    function test_rejectsNonContractAdapter() public {
        Consent memory c = _baseConsent();
        c.adapter = makeAddr("notAContract");
        c.nonce = keccak256("bad-adapter");
        bytes memory sig = _sign(c);
        vm.expectRevert(VaultFactory.AdapterNotContract.selector);
        factory.deploy(c, sig);
    }

    function test_rejectsReferrerBpsWithoutReferrer() public {
        Consent memory c = _baseConsent();
        c.referrer = address(0);
        c.nonce = keccak256("no-referrer");
        bytes memory sig = _sign(c);
        vm.expectRevert(VaultFactory.ReferrerBpsWithoutReferrer.selector);
        factory.deploy(c, sig);
    }

    function test_signedPathRequiresTermsHash() public {
        Consent memory c = _baseConsent();
        c.termsHash = bytes32(0);
        c.nonce = keccak256("no-terms");
        bytes memory sig = _sign(c);
        vm.expectRevert(VaultFactory.TermsHashRequired.selector);
        factory.deploy(c, sig);
    }

    // -----------------------------------------------------------------------
    // deployUnsigned
    // -----------------------------------------------------------------------

    function test_deployUnsignedForcesZeroEconomics() public {
        Consent memory c = _baseConsent();
        c.operatorBps = OPERATOR_BPS;
        c.budgetBpsMax = BUDGET_BPS_MAX;
        c.nonce = keccak256("unsigned");

        vm.prank(devSigner);
        address v = factory.deployUnsigned(c);

        CoinVault fv = CoinVault(payable(v));
        assertEq(uint256(fv.OPERATOR_BPS()), 0, "operatorBps must be forced to zero");
        assertEq(uint256(fv.BUDGET_BPS_MAX()), 0, "budgetBpsMax must be forced to zero");
        assertEq(uint256(fv.operatorCeilingBps()), 0);
        assertEq(v, factory.predictVaultUnsigned(c), "normalised prediction must match");
    }

    function test_deployUnsignedOnlyByDevSigner() public {
        Consent memory c = _baseConsent();
        c.nonce = keccak256("unsigned-auth");
        vm.prank(makeAddr("someoneElse"));
        vm.expectRevert(VaultFactory.OnlyDevSigner.selector);
        factory.deployUnsigned(c);
    }

    /// Normalisation happens BEFORE the salt, so the paid and free vaults for
    /// otherwise-identical terms are different contracts at different addresses.
    function test_unsignedAddressDiffersFromSignedAddress() public view {
        Consent memory c = _baseConsent();
        assertTrue(factory.predictVault(c) != factory.predictVaultUnsigned(c));
    }

    // -----------------------------------------------------------------------
    // No admin surface
    // -----------------------------------------------------------------------

    function test_factoryHasNoOwnerOrAdminFunctions() public view {
        // If any of these ever resolve, the "no admin key" claim is false.
        bytes4[6] memory forbidden = [
            bytes4(keccak256("owner()")),
            bytes4(keccak256("transferOwnership(address)")),
            bytes4(keccak256("upgradeTo(address)")),
            bytes4(keccak256("pause()")),
            bytes4(keccak256("setOperatorTreasury(address)")),
            bytes4(keccak256("setFee(uint16)"))
        ];
        for (uint256 i; i < forbidden.length; ++i) {
            (bool ok,) = address(factory).staticcall(abi.encodeWithSelector(forbidden[i]));
            assertFalse(ok, "factory must expose no admin entry point");
        }
    }

    function test_vaultCarriesConsentHashAndOperatorTreasury() public view {
        assertEq(vault.CONSENT_HASH(), factory.saltOf(consent));
        assertEq(vault.OPERATOR_TREASURY(), operator);
        assertEq(vault.FACTORY(), address(factory));
        assertEq(vault.DEPLOYER(), address(factory.deployer()));
        assertEq(uint256(vault.state()), uint256(VaultState.UNBOUND));
    }
}
