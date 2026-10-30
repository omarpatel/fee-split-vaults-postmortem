// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {CoinVault} from "../../src/CoinVault.sol";
import {VaultFactory} from "../../src/VaultFactory.sol";
import {VaultState} from "../../src/interfaces/ICoinVault.sol";
import {Consent} from "../../src/lib/ConsentLib.sol";
import {RevertingAdapter} from "../mocks/Mocks.sol";

contract CoinVaultStateTest is BaseTest {
    function _st() internal view returns (VaultState) {
        return vault.state();
    }

    // -----------------------------------------------------------------------
    // Binding. INVARIANT I7.
    // -----------------------------------------------------------------------

    function test_bindMovesUnboundToBound() public {
        assertEq(uint256(_st()), uint256(VaultState.UNBOUND));
        _bind();
        assertEq(uint256(_st()), uint256(VaultState.BOUND));
        assertEq(vault.token(), address(launch));
    }

    /// I7: bind() reverts if already bound.
    function test_bindIsOneShot() public {
        _bind();
        vm.prank(operator);
        vm.expectRevert(CoinVault.AlreadyBound.selector);
        vault.bind(address(launch));
    }

    function test_bindIsOneShotAcrossEveryLaterState() public {
        _activate();
        vm.prank(operator);
        vm.expectRevert(CoinVault.AlreadyBound.selector);
        vault.bind(address(launch));

        vm.prank(devPayout);
        vault.terminate();

        vm.prank(operator);
        vm.expectRevert(CoinVault.AlreadyBound.selector);
        vault.bind(address(launch));
    }

    function test_bindOnlyByOperator() public {
        vm.prank(devPayout);
        vm.expectRevert(CoinVault.OnlyOperator.selector);
        vault.bind(address(launch));
    }

    function test_bindRejectsTokenMismatchAgainstConsent() public {
        vm.prank(operator);
        vm.expectRevert(CoinVault.TokenMismatch.selector);
        vault.bind(address(usdg));
    }

    /// Relayed bind: the operator signs, anyone submits, so onboarding never
    /// requires the operator to hold gas on chain 4663.
    function test_bindWithSigAcceptsOperatorSignature() public {
        uint256 opKey = 0x0FEE;
        address opAddr = vm.addr(opKey);

        Consent memory c = _baseConsent();
        c.nonce = keccak256("relayed-bind");

        // A parallel fixture whose operator key we actually hold.
        CoinVault v = _deployWithOperator(opAddr, c);

        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                v.domainSeparator(),
                keccak256(
                    abi.encode(
                        keccak256("Bind(address vault,address token,uint64 deadline)"),
                        address(v),
                        address(launch),
                        deadline
                    )
                )
            )
        );
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(opKey, digest);

        vm.prank(makeAddr("randomRelayer"));
        v.bindWithSig(address(launch), deadline, abi.encodePacked(r, s, sv));

        assertEq(uint256(v.state()), uint256(VaultState.BOUND));
    }

    function _deployWithOperator(address op, Consent memory c) internal returns (CoinVault) {
        VaultFactory f = new VaultFactory(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(devKey, f.consentDigest(c));
        return CoinVault(payable(f.deploy(c, abi.encodePacked(r, s, v))));
    }

    // -----------------------------------------------------------------------
    // The happy path
    // -----------------------------------------------------------------------

    function test_boundPendingActiveSequence() public {
        _bind();
        vm.prank(devPayout);
        vault.acceptService();
        assertEq(uint256(_st()), uint256(VaultState.PENDING));

        vm.prank(operator);
        vault.activate();
        assertEq(uint256(_st()), uint256(VaultState.ACTIVE));
        assertEq(vault.activatedAtUnix(), uint64(block.timestamp));
    }

    function test_activationRequiresBothParties() public {
        _bind();
        // Operator cannot activate without the dev's acceptance.
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(CoinVault.BadState.selector, VaultState.BOUND));
        vault.activate();

        vm.prank(devPayout);
        vault.acceptService();

        // And the dev cannot activate itself.
        vm.prank(devPayout);
        vm.expectRevert(CoinVault.OnlyOperator.selector);
        vault.activate();
    }

    function test_suspendResumeRoundTrip() public {
        _activate();
        vm.prank(operator);
        vault.suspend();
        assertEq(uint256(_st()), uint256(VaultState.SUSPENDED));

        vm.prank(operator);
        vault.resume();
        assertEq(uint256(_st()), uint256(VaultState.ACTIVE));
    }

    // -----------------------------------------------------------------------
    // FIX (b): terminate() succeeds unconditionally.
    // -----------------------------------------------------------------------

    function test_terminateHandsBackRecipiencyWhenPermitted() public {
        _activate();
        vm.prank(devPayout);
        vault.terminate();

        assertEq(uint256(_st()), uint256(VaultState.TERMINATED));
        assertEq(feeRegistry.creatorFeeRecipient(address(launch)), devPayout);
        assertEq(uint256(vault.operatorCeilingBps()), 0);
    }

    /**
     * The property that matters: a Venue-side access-control change must not be
     * able to trap the dev inside the agreement. terminate() still succeeds,
     * charges still stop, and only the handback is skipped.
     */
    function test_terminateSucceedsEvenWhenHandbackReverts() public {
        _activate();
        feeRegistry.setLocked(true);

        vm.prank(devPayout);
        vault.terminate();

        assertEq(uint256(_st()), uint256(VaultState.TERMINATED));
        assertEq(uint256(vault.operatorCeilingBps()), 0, "charges must stop regardless");
        assertEq(
            feeRegistry.creatorFeeRecipient(address(launch)),
            address(vault),
            "handback did not happen, and that is fine"
        );
    }

    /// Same property against a broken adapter rather than a broken registry.
    function test_terminateSucceedsWhenAdapterIsBroken() public {
        _activate();
        _migrateToRevertingAdapter();

        vm.prank(devPayout);
        vault.terminate();
        assertEq(uint256(_st()), uint256(VaultState.TERMINATED));
        assertEq(uint256(vault.operatorCeilingBps()), 0);
    }

    function test_terminateIsDevOnly() public {
        _activate();
        vm.prank(operator);
        vm.expectRevert(CoinVault.OnlyDev.selector);
        vault.terminate();
    }

    function test_terminateIsIrreversible() public {
        _activate();
        vm.prank(devPayout);
        vault.terminate();

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(CoinVault.BadState.selector, VaultState.TERMINATED));
        vault.suspend();

        vm.prank(devPayout);
        vm.expectRevert(abi.encodeWithSelector(CoinVault.BadState.selector, VaultState.TERMINATED));
        vault.terminate();
    }

    // -----------------------------------------------------------------------
    // FIX (c): the operator can fire a client just as unconditionally.
    // -----------------------------------------------------------------------

    function test_operatorWithdrawRequiresNoticeThenSucceeds() public {
        _activate();
        vm.prank(operator);
        vault.giveOperatorWithdrawNotice();

        vm.expectRevert(abi.encodeWithSelector(CoinVault.TimelockPending.selector, uint64(block.timestamp + 14 days)));
        vault.operatorWithdraw();

        vm.warp(block.timestamp + 14 days);
        vault.operatorWithdraw();

        assertEq(uint256(_st()), uint256(VaultState.PASSTHROUGH));
        assertEq(uint256(vault.operatorCeilingBps()), 0);
    }

    /// Execution is permissionless so an operator cannot give notice, keep
    /// charging, and simply never execute the exit it announced.
    function test_anyoneMayExecuteAnElapsedOperatorNotice() public {
        _activate();
        vm.prank(operator);
        vault.giveOperatorWithdrawNotice();
        vm.warp(block.timestamp + 14 days);

        vm.prank(makeAddr("passerby"));
        vault.operatorWithdraw();
        assertEq(uint256(_st()), uint256(VaultState.PASSTHROUGH));
    }

    function test_operatorWithdrawWithoutNoticeReverts() public {
        _activate();
        vm.expectRevert(CoinVault.NoNotice.selector);
        vault.operatorWithdraw();
    }

    // -----------------------------------------------------------------------
    // Disclaim, poison, freeze
    // -----------------------------------------------------------------------

    function test_disclaimIsImmediateAndIrreversible() public {
        _activate();
        vm.prank(operator);
        vault.disclaim(7);

        assertEq(uint256(_st()), uint256(VaultState.PASSTHROUGH));
        assertEq(uint256(vault.operatorCeilingBps()), 0);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(CoinVault.BadState.selector, VaultState.PASSTHROUGH));
        vault.disclaim(7);
    }

    function test_poisonFreezesOperatorAndStopsCharging() public {
        _activate();
        vm.prank(operator);
        vault.poison(3);

        assertEq(uint256(_st()), uint256(VaultState.POISONED));
        assertTrue(vault.operatorFrozen());
        assertEq(uint256(vault.operatorCeilingBps()), 0);
    }

    /**
     * sanctionsFreeze touches the OPERATOR leg only. The dev's own money stays
     * withdrawable, because freezing a client's funds is the custody claim this
     * whole architecture exists to avoid.
     */
    function test_sanctionsFreezeLeavesTheDevLegFullyLiquid() public {
        _activate();
        _setDial(2_000);
        _accrue(address(usdg), 1_000_000);

        uint256 devBefore = vault.devClaimable(address(usdg));
        assertGt(devBefore, 0);

        vm.prank(operator);
        vault.sanctionsFreeze();

        assertTrue(vault.operatorFrozen());
        assertEq(uint256(_st()), uint256(VaultState.ACTIVE), "state is untouched");

        // Operator side is blocked.
        vm.prank(operator);
        vm.expectRevert(CoinVault.OperatorLegFrozen.selector);
        vault.withdrawOperator(address(usdg), 1);

        vm.prank(operator);
        vm.expectRevert(CoinVault.OperatorLegFrozen.selector);
        vault.pullBudget(address(usdg), 1, keccak256("inv"), hex"01");

        // Dev side is not.
        vm.prank(devPayout);
        vault.withdrawDev(address(usdg), devBefore);
        assertEq(usdg.balanceOf(devPayout), devBefore);
    }

    function test_sanctionsFreezeStopsFurtherOperatorAccrual() public {
        _activate();
        vm.prank(operator);
        vault.sanctionsFreeze();

        _accrue(address(usdg), 1_000_000);
        assertEq(vault.operatorClaimable(address(usdg)), 0);
        assertEq(vault.devClaimable(address(usdg)), 1_000_000);
    }

    // -----------------------------------------------------------------------
    // Dead man's switch
    // -----------------------------------------------------------------------

    function test_emergencyDevReleaseOnlyAfterDeadMan() public {
        _activate();
        uint64 deadline = vault.deadManDeadline();

        vm.expectRevert(abi.encodeWithSelector(CoinVault.TimelockPending.selector, deadline));
        vault.emergencyDevRelease();

        vm.warp(deadline);
        vm.prank(makeAddr("anyone"));
        vault.emergencyDevRelease();
        assertEq(uint256(_st()), uint256(VaultState.PASSTHROUGH));
    }

    function test_anyOperatorActionResetsTheDeadManClock() public {
        _activate();
        vm.warp(block.timestamp + 179 days);

        vm.prank(operator);
        vault.heartbeat();

        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(abi.encodeWithSelector(CoinVault.TimelockPending.selector, vault.deadManDeadline()));
        vault.emergencyDevRelease();
    }

    function test_deadManReleasesStrandedOperatorLegToDev() public {
        _activate();
        _accrue(address(usdg), 1_000_000);
        uint256 opLeg = vault.operatorClaimable(address(usdg));
        uint256 refLeg = vault.referrerClaimable(address(usdg));
        uint256 devLeg = vault.devClaimable(address(usdg));
        assertGt(opLeg, 0);

        vm.warp(vault.deadManDeadline());
        vault.emergencyDevRelease();
        vault.emergencyDevClaimOperatorLeg(address(usdg));

        assertEq(vault.operatorClaimable(address(usdg)), 0);
        assertEq(vault.referrerClaimable(address(usdg)), 0);
        assertEq(vault.devClaimable(address(usdg)), devLeg + opLeg + refLeg);
    }

    /// Frozen funds stay frozen even past the dead man. The dead man exists to
    /// prevent stranding, not to launder a sanctions freeze.
    function test_deadManDoesNotReleaseAFrozenOperatorLeg() public {
        _activate();
        _accrue(address(usdg), 1_000_000);
        vm.prank(operator);
        vault.sanctionsFreeze();

        vm.warp(vault.deadManDeadline());
        vm.expectRevert(CoinVault.OperatorLegFrozen.selector);
        vault.emergencyDevClaimOperatorLeg(address(usdg));
    }

    function _migrateToRevertingAdapter() internal {
        address bad = address(new RevertingAdapter(address(escrow), address(feeRegistry)));
        vm.prank(devPayout);
        vault.proposeAdapter(bad);
        vm.warp(block.timestamp + 14 days);
        vm.prank(devPayout);
        vault.setAdapter(bad);
    }
}
