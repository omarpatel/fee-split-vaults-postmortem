// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {CoinVault} from "../../src/CoinVault.sol";
import {VenueAdapter} from "../../src/VenueAdapter.sol";

contract TimelocksTest is BaseTest {
    /**
     * These mirror TERMS in config/protocol.ts. Solidity cannot import the TS
     * constants, so this test is the seam: if someone edits one side without
     * the other, this fails rather than the two silently disagreeing.
     */
    function test_timelockConstantsMirrorProtocolTerms() public view {
        assertEq(vault.DIAL_LOWER_NOTICE(), 7 days, "TERMS.dialLowerNoticeDays");
        assertEq(vault.OPERATOR_NOTICE(), 14 days, "TERMS.operatorWithdrawNoticeDays");
        assertEq(vault.ADAPTER_TIMELOCK(), 14 days, "TERMS.adapterMigrationTimelockDays");
        assertEq(vault.PROOF_WINDOW(), 7 days, "TERMS.procurementProofWindowDays");
        assertEq(vault.DEAD_MAN(), 180 days, "TERMS.deadManDays");
    }

    // -----------------------------------------------------------------------
    // The dial: raise now, lower on notice
    // -----------------------------------------------------------------------

    function test_raisingTheDialIsImmediate() public {
        _activate();
        _setDial(1_000);
        assertEq(uint256(vault.budgetBps()), 1_000);

        _setDial(3_000);
        assertEq(uint256(vault.budgetBps()), 3_000, "raises take effect at once");
        assertEq(vault.pendingDialUnix(), 0);
    }

    function test_loweringTheDialWaitsSevenDays() public {
        _activate();
        _setDial(4_000);

        _setDial(1_000);
        assertEq(uint256(vault.budgetBps()), 4_000, "the old dial still applies during notice");
        assertEq(uint256(vault.pendingBudgetBps()), 1_000);

        uint64 effective = uint64(block.timestamp + 7 days);
        assertEq(vault.pendingDialUnix(), effective);

        vm.expectRevert(abi.encodeWithSelector(CoinVault.TimelockPending.selector, effective));
        vault.applyDial();

        vm.warp(effective);
        vm.prank(makeAddr("anyone"));
        vault.applyDial();

        assertEq(uint256(vault.budgetBps()), 1_000);
        assertEq(vault.pendingDialUnix(), 0);
    }

    function test_raisingCancelsAPendingLowering() public {
        _activate();
        _setDial(4_000);
        _setDial(1_000);
        assertGt(vault.pendingDialUnix(), 0);

        _setDial(4_000);
        assertEq(vault.pendingDialUnix(), 0, "a raise supersedes the pending lower");
        assertEq(uint256(vault.pendingBudgetBps()), 0);
    }

    function test_dialCannotExceedTheConsentedCeiling() public {
        _activate();
        vm.prank(devPayout);
        vm.expectRevert(abi.encodeWithSelector(CoinVault.AboveDialCeiling.selector, BUDGET_BPS_MAX + 1, BUDGET_BPS_MAX));
        vault.setDial(BUDGET_BPS_MAX + 1);
    }

    function test_dialIsDevOnly() public {
        _activate();
        vm.prank(operator);
        vm.expectRevert(CoinVault.OnlyDev.selector);
        vault.setDial(1_000);
    }

    function test_applyDialWithNothingPendingReverts() public {
        _activate();
        vm.expectRevert(CoinVault.NoPendingDial.selector);
        vault.applyDial();
    }

    // -----------------------------------------------------------------------
    // FIX (a): adapter migration belongs to the DEV, on a timelock.
    // -----------------------------------------------------------------------

    function _newAdapter() internal returns (address) {
        return address(new VenueAdapter("venue-v2/next", address(escrow), address(feeRegistry)));
    }

    function test_adapterMigrationIsDevOnly() public {
        address next = _newAdapter();

        vm.prank(operator);
        vm.expectRevert(CoinVault.OnlyDev.selector);
        vault.proposeAdapter(next);

        vm.prank(operator);
        vm.expectRevert(CoinVault.OnlyDev.selector);
        vault.setAdapter(next);
    }

    function test_adapterMigrationRequiresFourteenDays() public {
        address next = _newAdapter();
        address current = vault.adapter();

        vm.prank(devPayout);
        vault.proposeAdapter(next);
        uint64 effective = uint64(block.timestamp + 14 days);
        assertEq(vault.adapterEffectiveUnix(), effective);

        vm.prank(devPayout);
        vm.expectRevert(abi.encodeWithSelector(CoinVault.TimelockPending.selector, effective));
        vault.setAdapter(next);
        assertEq(vault.adapter(), current, "no early migration");

        vm.warp(effective);
        vm.prank(devPayout);
        vault.setAdapter(next);
        assertEq(vault.adapter(), next);
        assertEq(vault.proposedAdapter(), address(0));
    }

    function test_setAdapterRequiresAMatchingProposal() public {
        address proposed = _newAdapter();
        address other = _newAdapter();

        vm.prank(devPayout);
        vault.proposeAdapter(proposed);
        vm.warp(block.timestamp + 14 days);

        vm.prank(devPayout);
        vm.expectRevert(CoinVault.AdapterNotProposed.selector);
        vault.setAdapter(other);
    }

    function test_adapterProposalCanBeCancelled() public {
        address next = _newAdapter();
        vm.prank(devPayout);
        vault.proposeAdapter(next);

        vm.prank(devPayout);
        vault.cancelAdapterProposal();
        assertEq(vault.proposedAdapter(), address(0));

        vm.warp(block.timestamp + 14 days);
        vm.prank(devPayout);
        vm.expectRevert(CoinVault.AdapterNotProposed.selector);
        vault.setAdapter(next);
    }

    function test_adapterMustBeAContract() public {
        vm.prank(devPayout);
        vm.expectRevert(CoinVault.AdapterNotContract.selector);
        vault.proposeAdapter(makeAddr("eoa"));
    }

    /**
     * The point of fix (a): a TERMINATED vault still holds unclaimed escrow
     * credit, so migration must remain available after the exit or an ABI
     * change would strand the dev's own money in their own vault.
     */
    function test_adapterMigrationStillWorksAfterTermination() public {
        _activate();
        vm.prank(devPayout);
        vault.terminate();

        address next = _newAdapter();
        vm.prank(devPayout);
        vault.proposeAdapter(next);
        vm.warp(block.timestamp + 14 days);
        vm.prank(devPayout);
        vault.setAdapter(next);
        assertEq(vault.adapter(), next);

        // And the residual stream still lands, at 100% to the dev.
        _accrue(address(usdg), 1_000_000);
        assertEq(vault.devClaimable(address(usdg)), 1_000_000);
    }

    // -----------------------------------------------------------------------
    // Operator notice
    // -----------------------------------------------------------------------

    function test_chargingContinuesDuringOperatorNotice() public {
        _activate();
        vm.prank(operator);
        vault.giveOperatorWithdrawNotice();

        _accrue(address(usdg), 1_000_000);
        assertGt(vault.operatorClaimable(address(usdg)), 0, "service continues during notice");

        vm.warp(block.timestamp + 14 days);
        vault.operatorWithdraw();

        _accrue(address(weth), 1 ether);
        assertEq(vault.operatorClaimable(address(weth)), 0, "and stops at execution");
    }
}
