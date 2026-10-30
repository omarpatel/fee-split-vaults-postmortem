// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {VaultFactory} from "../../src/VaultFactory.sol";
import {CoinVault} from "../../src/CoinVault.sol";
import {VenueAdapter} from "../../src/VenueAdapter.sol";
import {Consent} from "../../src/lib/ConsentLib.sol";
import {SafeTransferLib} from "../../src/lib/SafeTransferLib.sol";
import {VaultState, Legs} from "../../src/interfaces/ICoinVault.sol";

import {MockERC20, MockWETH, MockVenueFeeEscrow, MockCreatorFeeRegistry} from "../mocks/Mocks.sol";
import {VaultHandler} from "./VaultHandler.sol";

/**
 * THE EIGHT INVARIANTS.
 *
 * This suite, not reentrancy hunting, is the primary objective of an audit of
 * these contracts. Each invariant below is a property the architecture claims
 * in prose somewhere -- in the README, in a comment, or in a regulatory
 * argument -- and each one is asserted here after every state-changing call the
 * handler makes, across every asset, in every reachable state including the
 * terminal ones.
 *
 * Assets under test deliberately include the native sentinel address(0), the
 * launch token, and a WETH mock whose wrap counters must never move.
 */
contract InvariantsTest is StdInvariant, Test {
    VaultFactory internal factory;
    VenueAdapter internal adapter;
    MockVenueFeeEscrow internal escrow;
    MockCreatorFeeRegistry internal feeRegistry;

    MockERC20 internal usdg;
    MockWETH internal weth;
    MockERC20 internal launch;

    CoinVault internal vault;
    CoinVault internal freeVault;
    VaultHandler internal handler;

    uint256 internal devKey = 0xA11CE;
    address internal devSigner;
    address internal devPayout = makeAddr("devPayout");
    address internal operator = makeAddr("operatorTreasury");
    address internal referrer = makeAddr("referrer");
    address internal thirdParty = makeAddr("thirdPartyVendor");
    address internal freeDevPayout = makeAddr("freeDevPayout");

    address[4] internal assets;

    function setUp() public {
        devSigner = vm.addr(devKey);

        escrow = new MockVenueFeeEscrow();
        feeRegistry = new MockCreatorFeeRegistry();
        adapter = new VenueAdapter("venue-v2/inv", address(escrow), address(feeRegistry));

        usdg = new MockERC20("Quote USD", "USDG", 6);
        weth = new MockWETH();
        launch = new MockERC20("Launch Coin", "MEME", 18);

        factory = new VaultFactory(operator);

        // The paying vault.
        Consent memory c = _consent(devPayout, keccak256("inv-paid"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(devKey, factory.consentDigest(c));
        vault = CoinVault(payable(factory.deploy(c, abi.encodePacked(r, s, v))));
        feeRegistry.setRecipient(address(launch), address(vault));

        vm.prank(operator);
        vault.bind(address(launch));
        vm.prank(devPayout);
        vault.acceptService();
        vm.prank(operator);
        vault.activate();
        vm.prank(devPayout);
        vault.setDial(2_000);

        // The free splitter: operatorBps forced to zero by deployUnsigned.
        Consent memory f = _consent(freeDevPayout, keccak256("inv-free"));
        vm.prank(devSigner);
        freeVault = CoinVault(payable(factory.deployUnsigned(f)));
        vm.prank(operator);
        freeVault.bind(address(launch));
        vm.prank(freeDevPayout);
        freeVault.acceptService();
        vm.prank(operator);
        freeVault.activate();

        assets = [address(usdg), address(weth), SafeTransferLib.NATIVE, address(launch)];

        handler = new VaultHandler(
            vault, freeVault, escrow, assets, [devPayout, operator, referrer, thirdParty, freeDevPayout]
        );

        targetContract(address(handler));
        // Only the handler may originate calls: the fuzzer must not reach the
        // vault directly and accidentally satisfy an invariant by inaction.
        excludeContract(address(vault));
        excludeContract(address(freeVault));
        excludeContract(address(factory));
        excludeContract(address(escrow));
    }

    function _consent(address payout, bytes32 nonce) internal view returns (Consent memory) {
        return Consent({
            devSigner: devSigner,
            devPayout: payout,
            token: address(launch),
            termsHash: keccak256("MSA v1"),
            operatorBps: 1_000,
            budgetBpsMax: 4_000,
            adapter: address(adapter),
            referrer: referrer,
            referrerBps: 2_000,
            expiryUnix: type(uint64).max,
            nonce: nonce
        });
    }

    function _balanceOf(address asset, address who) internal view returns (uint256) {
        if (asset == SafeTransferLib.NATIVE) return who.balance;
        return MockERC20(asset).balanceOf(who);
    }

    // =======================================================================
    // I1. The vault is always solvent against the sum of its four legs.
    // =======================================================================

    function invariant_I1_solvencyPerAsset() public view {
        for (uint256 i; i < 4; ++i) {
            address a = assets[i];
            (bool solvent, uint256 balance, uint256 accounted) = vault.checkSolvency(a);
            assertTrue(solvent, "I1: vault balance must cover dev + budget + operator + referrer");
            assertGe(balance, accounted, "I1");
        }
    }

    /// The partition is exhaustive too: nothing is double-counted between legs.
    function invariant_I1_legsAreConsistentWithProjection() public view {
        for (uint256 i; i < 4; ++i) {
            address a = assets[i];
            Legs memory L = vault.legOf(a);
            uint256 sum = L.dev + L.budget + L.operator_ + L.referrer;
            assertGe(vault.devOwed(a), L.dev, "devOwed includes the settled leg");
            assertGe(_balanceOf(a, address(vault)), sum, "I1");
        }
    }

    // =======================================================================
    // I2. Settlement performs no swap, wrap or conversion.
    //     Asset in equals asset out on the dev leg.
    // =======================================================================

    function invariant_I2_nothingIsEverWrappedOrUnwrapped() public view {
        assertEq(weth.depositCalls(), 0, "I2: the vault must never wrap");
        assertEq(weth.withdrawCalls(), 0, "I2: the vault must never unwrap");
    }

    /// The handler asserts per-call that a dev payout in asset A moves only
    /// asset A. Any cross-asset movement is counted here.
    function invariant_I2_noCrossAssetMovement() public view {
        assertEq(handler.ghostCrossAssetLeaks(), 0, "I2: a payout touched a second asset");
    }

    /// Every wei that reached devPayout came out of the dev leg of that same
    /// asset, so what was credited is what was paid, denominated identically.
    function invariant_I2_devPayoutHoldsExactlyWhatWasDebited() public view {
        for (uint256 i; i < 4; ++i) {
            address a = assets[i];
            assertEq(
                _balanceOf(a, devPayout),
                handler.ghostDevPaid(a),
                "I2/I3: devPayout balance is exactly the sum of dev-leg debits"
            );
        }
    }

    // =======================================================================
    // I3. No code path moves devClaimable to any address other than devPayout.
    // =======================================================================

    /// Measured across each call by the handler: every debit of the dev leg
    /// arrived at devPayout, in full, and nowhere else.
    function invariant_I3_everyDevDebitLandedAtDevPayout() public view {
        assertEq(handler.ghostDevMisdirected(), 0, "I3: a dev-leg debit did not reach devPayout");
    }

    function invariant_I3_devLegReachesOnlyDevPayout() public view {
        for (uint256 i; i < 4; ++i) {
            address a = assets[i];

            // The caller must never be a destination. Excluding the handler
            // from the set below is what makes a "pay msg.sender" bug visible
            // rather than absorbed.
            assertEq(_balanceOf(a, address(handler)), 0, "I3: the caller received funds");

            // Conservation: every token ever created for this system is either
            // still in a vault or in the escrow, or sits at one of the consented
            // destinations. There is nowhere else for it to be.
            uint256 accountedFor = _balanceOf(a, address(vault)) + _balanceOf(a, address(escrow))
                + _balanceOf(a, devPayout) + _balanceOf(a, operator) + _balanceOf(a, referrer)
                + _balanceOf(a, address(freeVault)) + _balanceOf(a, freeDevPayout);

            assertEq(accountedFor, handler.ghostMinted(a), "I3: funds left the consented set");
        }
    }

    // =======================================================================
    // I4. pullBudget can send ONLY to the operator treasury. There is no
    //     third-party payee in any function.
    // =======================================================================

    function invariant_I4_noThirdPartyIsEverPaid() public view {
        for (uint256 i; i < 4; ++i) {
            assertEq(_balanceOf(assets[i], thirdParty), 0, "I4: a third party received funds");
        }
    }

    /// The operator treasury's balance is fully explained by budget
    /// reimbursements plus operator-leg withdrawals -- never by the dev leg.
    function invariant_I4_operatorBalanceIsFullyAttributed() public view {
        for (uint256 i; i < 4; ++i) {
            address a = assets[i];
            assertEq(
                _balanceOf(a, operator),
                handler.ghostBudgetPulled(a) + handler.ghostOperatorPaid(a),
                "I4: operator holds funds no legitimate pull accounts for"
            );
        }
    }

    /// Measured across each call: a reimbursement landed at the treasury, in
    /// full, without touching the third party and without dipping into the
    /// client's leg to fund itself.
    function invariant_I4_everyBudgetPullWasAReimbursement() public view {
        assertEq(handler.ghostBudgetMisdirected(), 0, "I4: a budget pull was misdirected");
        assertEq(handler.ghostOperatorMisdirected(), 0, "I4: an operator payout was misdirected");
        assertEq(handler.ghostRefundMovedTokens(), 0, "I4: a budget refund moved tokens");
    }

    /// Structural restatement: pullBudget has no address parameter at all.
    function invariant_I4_pullBudgetHasNoPayeeParameter() public pure {
        assertEq(
            CoinVault.pullBudget.selector,
            bytes4(keccak256("pullBudget(address,uint256,bytes32,bytes)")),
            "I4: pullBudget must never grow a payee argument"
        );
    }

    // =======================================================================
    // I5. operatorBps is immutable and monotone toward zero via
    //     disclaim / terminate / withdraw.
    // =======================================================================

    function invariant_I5_ceilingNeverRises() public view {
        assertEq(handler.ghostCeilingIncreases(), 0, "I5: the operator ceiling rose");
        assertLe(vault.operatorCeilingBps(), vault.OPERATOR_BPS(), "I5");
        assertEq(uint256(vault.OPERATOR_BPS()), 1_000, "I5: the consented rate is immutable");
    }

    /// ACTIVE is the only state that charges anything, in any asset.
    function invariant_I5_onlyActiveStateEverCharges() public view {
        assertEq(handler.ghostChargedWhileInactive(), 0, "I5: the operator side grew outside ACTIVE");
    }

    /// Any terminal state must have ratcheted the ceiling to zero permanently.
    function invariant_I5_terminalStatesChargeNothing() public view {
        VaultState s = vault.state();
        if (s == VaultState.PASSTHROUGH || s == VaultState.TERMINATED || s == VaultState.POISONED) {
            assertEq(uint256(vault.operatorCeilingBps()), 0, "I5: a terminal vault still charges");
            assertEq(uint256(vault.budgetBps()), 0, "I5: a terminal vault still accrues budget");
        }
    }

    // =======================================================================
    // I6. Any launch-token balance credits 100% to devClaimable.
    // =======================================================================

    function invariant_I6_launchTokenIsNeverCharged() public view {
        Legs memory L = vault.legOf(address(launch));
        assertEq(L.budget, 0, "I6: launch token accrued budget");
        assertEq(L.operator_, 0, "I6: launch token accrued operator revenue");
        assertEq(L.referrer, 0, "I6: launch token accrued referral revenue");

        // Everything the vault holds of its own coin is the dev's, settled or not.
        assertEq(
            vault.devOwed(address(launch)),
            _balanceOf(address(launch), address(vault)),
            "I6: launch token must be 100% dev-owed"
        );
    }

    // =======================================================================
    // I7. bind() reverts if already bound.
    // =======================================================================

    function invariant_I7_bindIsOneShot() public view {
        assertLe(handler.ghostBindSuccesses(), 1, "I7: bind succeeded more than once");
        assertEq(vault.token(), address(launch), "I7: the bound token never changes");
    }

    // =======================================================================
    // I8. A vault with operatorBps == 0 remains a fully functional
    //     dev-withdrawable splitter.
    // =======================================================================

    function invariant_I8_freeSplitterStaysFreeAndFunctional() public view {
        assertEq(uint256(freeVault.OPERATOR_BPS()), 0, "I8");
        assertEq(uint256(freeVault.operatorCeilingBps()), 0, "I8");
        assertEq(uint256(freeVault.BUDGET_BPS_MAX()), 0, "I8");

        for (uint256 i; i < 4; ++i) {
            address a = assets[i];
            Legs memory L = freeVault.legOf(a);
            assertEq(L.operator_, 0, "I8: a free splitter accrued operator revenue");
            assertEq(L.budget, 0, "I8: a free splitter accrued budget");
            assertEq(L.referrer, 0, "I8: a free splitter accrued referral revenue");

            // Everything it holds is withdrawable by the dev, right now.
            assertEq(freeVault.devOwed(a), _balanceOf(a, address(freeVault)), "I8: the whole balance must be dev-owed");
        }

        assertEq(
            _balanceOf(address(usdg), freeDevPayout),
            handler.ghostFreeDevPaid(address(usdg)),
            "I8: withdrawals landed at the free vault's devPayout"
        );
        assertEq(handler.ghostFreeSplitterShortfall(), 0, "I8: a free splitter refused or short-paid a dev withdrawal");
    }
}
