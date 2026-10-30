// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {CoinVault} from "../../src/CoinVault.sol";
import {VaultFactory} from "../../src/VaultFactory.sol";
import {VaultState, Legs} from "../../src/interfaces/ICoinVault.sol";
import {Consent} from "../../src/lib/ConsentLib.sol";
import {SafeTransferLib} from "../../src/lib/SafeTransferLib.sol";
import {HostileAdapter, ReentrantDev, MockERC20} from "../mocks/Mocks.sol";

contract CoinVaultAccountingTest is BaseTest {
    uint256 constant FEE = 1_000_000; // 1.0 USDG at 6dp

    // -----------------------------------------------------------------------
    // The split
    // -----------------------------------------------------------------------

    function test_activeSplitMatchesConsentedRates() public {
        _activate();
        _setDial(2_000);
        _accrue(address(usdg), FEE);

        Legs memory L = _legs(address(usdg));
        assertEq(L.dev, 700_000, "dev keeps 70% at a 20% dial");
        assertEq(L.budget, 200_000, "budget takes the dial");
        assertEq(L.operator_, 80_000, "operator keeps 10% less the referral");
        assertEq(L.referrer, 20_000, "referrer takes 20% OF the operator's 10%");
        assertEq(L.dev + L.budget + L.operator_ + L.referrer, FEE, "the four legs are exhaustive");
    }

    /// The referral is carved out of the operator, never out of the client.
    function test_referralNeverDilutesTheDev() public {
        _activate();
        _setDial(2_000);
        _accrue(address(usdg), FEE);
        uint256 devWithReferral = vault.devClaimable(address(usdg));

        Consent memory c = _baseConsent();
        c.referrer = address(0);
        c.referrerBps = 0;
        c.nonce = keccak256("no-ref");
        CoinVault v2 = CoinVault(payable(_deploySigned(c)));

        vm.prank(operator);
        v2.bind(address(launch));
        vm.prank(devPayout);
        v2.acceptService();
        vm.prank(operator);
        v2.activate();
        vm.prank(devPayout);
        v2.setDial(2_000);

        usdg.mint(address(escrow), FEE);
        escrow.creditToken(address(v2), address(usdg), FEE);
        v2.claimToken(address(usdg), type(uint256).max);

        assertEq(v2.devClaimable(address(usdg)), devWithReferral, "dev share is referral-invariant");
    }

    /// INVARIANT I6, in the ordinary case and in the anti-snipe windfall case.
    function test_launchTokenAlwaysCreditsOneHundredPercentToDev() public {
        _activate();
        _setDial(4_000);

        // The 99% anti-snipe tax at t=0 arrives as launch token along fee rails
        // and will look exactly like a windfall. It must not be charged.
        _drop(address(launch), 999_000e18);

        Legs memory L = _legs(address(launch));
        assertEq(L.dev, 999_000e18);
        assertEq(L.budget, 0);
        assertEq(L.operator_, 0);
        assertEq(L.referrer, 0);
    }

    function test_noChargeOutsideActive() public {
        // UNBOUND
        _drop(address(usdg), FEE);
        assertEq(vault.devClaimable(address(usdg)), FEE);

        // PENDING
        _bind();
        vm.prank(devPayout);
        vault.acceptService();
        _drop(address(usdg), FEE);
        assertEq(vault.devClaimable(address(usdg)), 2 * FEE);

        // ACTIVE charges...
        vm.prank(operator);
        vault.activate();
        _drop(address(usdg), FEE);
        assertGt(vault.operatorClaimable(address(usdg)), 0);

        // ...SUSPENDED does not.
        uint256 opBefore = vault.operatorClaimable(address(usdg));
        vm.prank(operator);
        vault.suspend();
        _drop(address(usdg), FEE);
        assertEq(vault.operatorClaimable(address(usdg)), opBefore, "no charge while suspended");
    }

    function test_passthroughAfterTerminateCreditsEverythingToDev() public {
        _activate();
        _setDial(2_000);
        vm.prank(devPayout);
        vault.terminate();

        _drop(address(usdg), FEE);
        Legs memory L = _legs(address(usdg));
        assertEq(L.dev, FEE);
        assertEq(L.budget, 0);
        assertEq(L.operator_, 0);
        assertEq(L.referrer, 0);
    }

    /**
     * The exact split, pinned. A lower bound is not enough here: giving the
     * dev `floor(amount * devBps / 10000)` and handing the remainder to the
     * operator also clears any "at least the ideal share" test, which is
     * precisely the silent-skim bug worth catching. So assert equality.
     */
    function testFuzz_splitIsExactAndDevAbsorbsTheRemainder(uint96 amount, uint16 dial) public {
        _activate();
        dial = uint16(bound(dial, 0, BUDGET_BPS_MAX));
        _setDial(dial);
        vm.assume(amount > 0);

        _drop(address(usdg), amount);
        Legs memory L = _legs(address(usdg));

        uint256 opGross = (uint256(amount) * OPERATOR_BPS) / 10_000;
        uint256 expectedBudget = (uint256(amount) * dial) / 10_000;
        uint256 expectedDev = uint256(amount) - opGross - expectedBudget;
        uint256 expectedReferrer = (opGross * REFERRER_BPS) / 10_000;

        assertEq(L.dev, expectedDev, "the dev leg takes the remainder, exactly");
        assertEq(L.budget, expectedBudget);
        assertEq(L.referrer, expectedReferrer);
        assertEq(L.operator_, opGross - expectedReferrer);

        assertEq(L.dev + L.budget + L.operator_ + L.referrer, amount, "no dust escapes");
        uint256 idealDev = (uint256(amount) * (10_000 - OPERATOR_BPS - uint256(dial))) / 10_000;
        assertGe(L.dev, idealDev, "rounding never favours the operator");
    }

    // -----------------------------------------------------------------------
    // Payout destinations. INVARIANTS I3 and I4.
    // -----------------------------------------------------------------------

    function test_withdrawDevOnlyByDevPayoutAndOnlyToDevPayout() public {
        _activate();
        _accrue(address(usdg), FEE);
        uint256 owed = vault.devClaimable(address(usdg));

        vm.prank(operator);
        vm.expectRevert(CoinVault.OnlyDevPayout.selector);
        vault.withdrawDev(address(usdg), owed);

        vm.prank(devPayout);
        vault.withdrawDev(address(usdg), owed);
        assertEq(usdg.balanceOf(devPayout), owed);
        assertEq(usdg.balanceOf(thirdParty), 0, "no third party is ever paid");
    }

    /// pushDev exists so a devPayout that cannot originate transactions can
    /// still be paid. The destination is the same immutable either way.
    function test_pushDevIsPermissionlessButDestinationIsFixed() public {
        _activate();
        _accrue(address(usdg), FEE);
        uint256 owed = vault.devClaimable(address(usdg));

        vm.prank(makeAddr("goodSamaritan"));
        vault.pushDev(address(usdg));

        assertEq(usdg.balanceOf(devPayout), owed);
        assertEq(vault.devClaimable(address(usdg)), 0);
    }

    function test_pullBudgetReimbursesOnlyTheOperatorTreasury() public {
        _activate();
        _setDial(2_000);
        _accrue(address(usdg), FEE);
        uint256 budget = vault.budgetAvailable(address(usdg));
        assertEq(budget, 200_000);

        vm.prank(operator);
        vault.pullBudget(address(usdg), budget, keccak256("invoice-1"), hex"c0ffee");

        assertEq(usdg.balanceOf(operator), budget, "reimbursement lands at the treasury");
        assertEq(usdg.balanceOf(thirdParty), 0, "there is no vendor path");
        assertEq(vault.budgetAvailable(address(usdg)), 0);
    }

    function test_pullBudgetRejectsInvoiceReplay() public {
        _activate();
        _setDial(2_000);
        _accrue(address(usdg), FEE);

        vm.prank(operator);
        vault.pullBudget(address(usdg), 100_000, keccak256("invoice-1"), hex"01");

        vm.prank(operator);
        vm.expectRevert(CoinVault.InvoiceAlreadyUsed.selector);
        vault.pullBudget(address(usdg), 100_000, keccak256("invoice-1"), hex"01");
    }

    function test_pullBudgetRequiresInvoiceAndCountersignature() public {
        _activate();
        _setDial(2_000);
        _accrue(address(usdg), FEE);

        vm.prank(operator);
        vm.expectRevert(CoinVault.InvoiceRequired.selector);
        vault.pullBudget(address(usdg), 1, bytes32(0), hex"01");

        vm.prank(operator);
        vm.expectRevert(CoinVault.CountersigRequired.selector);
        vault.pullBudget(address(usdg), 1, keccak256("inv"), hex"");
    }

    /// THE COMMITMENT RULE. The banked budget is the whole credit limit.
    function test_pullBudgetCannotExceedBankedBudget() public {
        _activate();
        _setDial(2_000);
        _accrue(address(usdg), FEE);
        uint256 budget = vault.budgetAvailable(address(usdg));

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(CoinVault.AmountExceedsLeg.selector, budget + 1, budget));
        vault.pullBudget(address(usdg), budget + 1, keccak256("inv"), hex"01");
    }

    function test_operatorCannotReachTheDevLeg() public {
        _activate();
        _accrue(address(usdg), FEE);
        uint256 opLeg = vault.operatorClaimable(address(usdg));

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(CoinVault.AmountExceedsLeg.selector, opLeg + 1, opLeg));
        vault.withdrawOperator(address(usdg), opLeg + 1);
    }

    // -----------------------------------------------------------------------
    // Budget refund
    // -----------------------------------------------------------------------

    function test_refundUnprovenWaitsForTheProofWindow() public {
        _activate();
        _setDial(2_000);
        _accrue(address(usdg), FEE);
        uint256 devBefore = vault.devClaimable(address(usdg));
        uint256 budget = vault.budgetAvailable(address(usdg));

        uint64 opensAt = uint64(block.timestamp + 7 days);
        vm.expectRevert(abi.encodeWithSelector(CoinVault.ProofWindowOpen.selector, opensAt));
        vault.refundUnproven(address(usdg));

        vm.warp(opensAt);
        vm.prank(makeAddr("anyone"));
        vault.refundUnproven(address(usdg));

        assertEq(vault.budgetAvailable(address(usdg)), 0);
        assertEq(vault.devClaimable(address(usdg)), devBefore + budget);
        assertEq(usdg.balanceOf(address(vault)), FEE, "a refund moves legs, not tokens");
    }

    function test_refundIsImmediateAfterAnyExit() public {
        _activate();
        _setDial(2_000);
        _accrue(address(usdg), FEE);

        vm.prank(devPayout);
        vault.terminate();

        vault.refundUnproven(address(usdg));
        assertEq(vault.budgetAvailable(address(usdg)), 0);
        assertEq(vault.devClaimable(address(usdg)), 900_000, "budget reverts to the dev leg");
    }

    // -----------------------------------------------------------------------
    // Salvage
    // -----------------------------------------------------------------------

    function test_salvageOnlyInPoisonedAndOnlyToDev() public {
        _activate();
        _setDial(2_000);

        vm.expectRevert(abi.encodeWithSelector(CoinVault.BadState.selector, VaultState.ACTIVE));
        vault.salvage(address(usdg));

        vm.prank(operator);
        vault.poison(1);

        usdg.mint(address(vault), FEE);
        vault.salvage(address(usdg));

        Legs memory L = _legs(address(usdg));
        assertEq(L.dev, FEE);
        assertEq(L.operator_, 0);
        assertEq(L.budget, 0);
    }

    // -----------------------------------------------------------------------
    // Pausable, capped, non-standard assets
    // -----------------------------------------------------------------------

    /// "Claim in BOUNDED amounts": an unbounded claim on a capped asset fails,
    /// and repeated bounded claims succeed.
    function test_boundedClaimsClearACappedAsset() public {
        _activate();
        usdg.mint(address(escrow), FEE);
        escrow.creditToken(address(vault), address(usdg), FEE);
        usdg.setMaxTransfer(400_000);

        vm.expectRevert(bytes("escrow: transfer failed"));
        vault.claimToken(address(usdg), type(uint256).max);

        vault.claimToken(address(usdg), 400_000);
        vault.claimToken(address(usdg), 400_000);
        vault.claimToken(address(usdg), 400_000);

        assertEq(usdg.balanceOf(address(vault)), FEE);
        assertEq(escrow.creditOf(address(vault), address(usdg)), 0);
    }

    /// A paused issuer proxy must fail ONE asset, never the whole sweep.
    function test_sweepIsolatesAPausedAsset() public {
        _activate();
        usdg.mint(address(escrow), FEE);
        escrow.creditToken(address(vault), address(usdg), FEE);
        weth.mint(address(escrow), 5 ether);
        escrow.creditToken(address(vault), address(weth), 5 ether);

        usdg.setPaused(true);

        address[] memory assets = new address[](2);
        assets[0] = address(usdg);
        assets[1] = address(weth);
        vault.sweep(assets);

        assertEq(usdg.balanceOf(address(vault)), 0, "paused asset stays in escrow");
        assertEq(weth.balanceOf(address(vault)), 5 ether, "the healthy asset still cleared");
    }

    function test_nonStandardReturnlessTokenIsAccepted() public {
        _activate();
        usdg.setReturnsNothing(true);
        _accrue(address(usdg), FEE);
        assertEq(usdg.balanceOf(address(vault)), FEE);

        // Read before the prank: an external view in argument position would
        // consume it and the withdrawal would arrive from the test contract.
        uint256 owed = vault.devClaimable(address(usdg));
        vm.prank(devPayout);
        vault.withdrawDev(address(usdg), owed);
        assertEq(usdg.balanceOf(devPayout), owed);
    }

    // -----------------------------------------------------------------------
    // Native asset
    // -----------------------------------------------------------------------

    function test_nativeClaimSplitsAndWithdraws() public {
        _activate();
        _setDial(2_000);

        vm.deal(address(this), 10 ether);
        escrow.creditNative{value: 10 ether}(address(vault));
        vault.claim(type(uint256).max);

        Legs memory L = _legs(SafeTransferLib.NATIVE);
        assertEq(L.dev, 7 ether);
        assertEq(L.budget, 2 ether);
        assertEq(L.operator_ + L.referrer, 1 ether);

        vm.prank(devPayout);
        vault.withdrawDev(SafeTransferLib.NATIVE, 7 ether);
        assertEq(devPayout.balance, 7 ether);
    }

    /// address(0) is the native sentinel and must never be mistaken for an
    /// unset launch token, which would silently exempt native from charging.
    function test_nativeIsNotConfusedWithAnUnboundLaunchToken() public {
        Consent memory c = _baseConsent();
        c.token = address(0); // greenfield path: token unknown at deploy
        c.nonce = keccak256("greenfield");
        CoinVault v = CoinVault(payable(_deploySigned(c)));

        vm.prank(operator);
        v.bind(address(launch));
        vm.prank(devPayout);
        v.acceptService();
        vm.prank(operator);
        v.activate();

        vm.deal(address(this), 1 ether);
        (bool ok,) = address(v).call{value: 1 ether}("");
        assertTrue(ok);
        v.settle(SafeTransferLib.NATIVE);

        assertGt(v.operatorClaimable(SafeTransferLib.NATIVE), 0, "native must be chargeable");
    }

    // -----------------------------------------------------------------------
    // Adapter guards
    // -----------------------------------------------------------------------

    function _installHostile(HostileAdapter h) internal {
        vm.prank(devPayout);
        vault.proposeAdapter(address(h));
        vm.warp(block.timestamp + 14 days);
        vm.prank(devPayout);
        vault.setAdapter(address(h));
    }

    function test_hostileAdapterCannotApproveOrTransferVaultAssets() public {
        _activate();
        _accrue(address(usdg), FEE);

        HostileAdapter h = new HostileAdapter(address(escrow), address(feeRegistry), address(usdg), thirdParty);
        _installHostile(h);

        h.setMode(HostileAdapter.Mode.APPROVE_ASSET);
        vm.expectRevert();
        vault.claimToken(address(usdg), 1);
        assertEq(usdg.allowance(address(vault), thirdParty), 0, "no allowance may be created");

        h.setMode(HostileAdapter.Mode.TRANSFER_ASSET);
        vm.expectRevert();
        vault.claimToken(address(usdg), 1);
        assertEq(usdg.balanceOf(thirdParty), 0, "no asset may leave");
    }

    function test_hostileAdapterCannotTargetTheVaultOrAnEoa() public {
        _activate();
        HostileAdapter h = new HostileAdapter(address(escrow), address(feeRegistry), address(usdg), thirdParty);
        _installHostile(h);

        h.setMode(HostileAdapter.Mode.CALL_SELF);
        vm.expectRevert();
        vault.claimToken(address(usdg), 1);

        h.setMode(HostileAdapter.Mode.CALL_EOA);
        vm.expectRevert();
        vault.claimToken(address(usdg), 1);
    }

    // -----------------------------------------------------------------------
    // Reentrancy
    // -----------------------------------------------------------------------

    /**
     * settle() recognises income as `balance - accounted`. Without a lock, a
     * native payout that re-entered mid-transfer would observe the pre-transfer
     * balance against post-decrement legs and credit the same money twice.
     */
    function test_reentrantDevPayoutCannotDoubleCredit() public {
        ReentrantDev dev = new ReentrantDev();

        Consent memory c = _baseConsent();
        c.devPayout = address(dev);
        c.nonce = keccak256("reentrant");
        CoinVault v = CoinVault(payable(_deploySigned(c)));
        dev.setVault(address(v));

        vm.prank(operator);
        v.bind(address(launch));
        vm.prank(address(dev));
        v.acceptService();
        vm.prank(operator);
        v.activate();

        vm.deal(address(this), 5 ether);
        (bool ok,) = address(v).call{value: 5 ether}("");
        assertTrue(ok);
        v.settle(SafeTransferLib.NATIVE);

        uint256 owed = v.devClaimable(SafeTransferLib.NATIVE);
        dev.arm(true);

        (bool sent,) =
            dev.call(address(v), abi.encodeWithSignature("withdrawDev(address,uint256)", SafeTransferLib.NATIVE, owed));
        assertFalse(sent, "reentrant settle must abort the withdrawal");
        assertEq(v.devClaimable(SafeTransferLib.NATIVE), owed, "no double credit occurred");
    }

    // -----------------------------------------------------------------------
    // Solvency
    // -----------------------------------------------------------------------

    function test_checkSolvencyTracksEveryLeg() public {
        _activate();
        _setDial(2_000);
        _accrue(address(usdg), FEE);

        (bool solvent, uint256 bal, uint256 accounted) = vault.checkSolvency(address(usdg));
        assertTrue(solvent);
        assertEq(bal, FEE);
        assertEq(accounted, FEE);
    }

    function test_settleIsIdempotent() public {
        _activate();
        _accrue(address(usdg), FEE);
        uint256 dev1 = vault.devClaimable(address(usdg));
        vault.settle(address(usdg));
        vault.settle(address(usdg));
        assertEq(vault.devClaimable(address(usdg)), dev1, "settle recognises income once");
    }
}
