// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {CoinVault} from "../../src/CoinVault.sol";
import {Consent} from "../../src/lib/ConsentLib.sol";
import {VaultState, Legs} from "../../src/interfaces/ICoinVault.sol";

import {
    AttackerToken,
    IssuerControlledToken,
    ERC677Token,
    GasBombToken,
    JunkToken,
    MutableAdapter
} from "./RedTeamMocks.sol";

/**
 * REGRESSION SUITE FOR THE HARDENING, PINNED ON PROPERTIES.
 *
 * RedTeam.t.sol pins the SYMPTOMS: the exact payloads that were demonstrated,
 * walked end to end, kept as scripts that must keep failing. This file pins the
 * PROPERTIES those symptoms were instances of, so that the next instance - a
 * different token shape, a different selector, a different way to make an asset
 * look short - is caught without anyone having to think of it first.
 *
 * Every describe-block below names the invariant it defends and the class of
 * attack it closes, not the one attack that was found.
 */
contract HardeningTest is BaseTest {
    address internal attacker = makeAddr("attacker");

    // =======================================================================
    // PROPERTY 1. NO ASSET IS EVER A HOSTAGE OF ANOTHER.
    //
    // claim() and claimToken() are the only two ways money enters the vault.
    // Whatever is true of one asset, it must remain possible to bring in and
    // pay out a different one. The demonstrated instance was an attacker token
    // with a controllable balanceOf; the CLASS is "any asset whose reported
    // balance falls below its ledger", and the class has at least three members
    // that need no attacker at all.
    // =======================================================================

    function test_property_aShortfallOnOneAssetNeverBlocksAnother() public {
        _activate();

        // Member 1: a token the attacker wrote.
        vm.startPrank(attacker);
        AttackerToken poison = new AttackerToken();
        poison.setBalance(address(vault), 1_000 ether);
        vault.settle(address(poison));
        poison.setBalance(address(vault), 0);
        vm.stopPrank();

        // Member 2: an issuer seizure on a real quote asset (USDT's
        // destroyBlackFunds). No attacker; the issuer is doing its job.
        IssuerControlledToken seized = new IssuerControlledToken();
        seized.mint(address(vault), 1_000 ether);
        vault.settle(address(seized));
        seized.seize(address(vault));

        // Member 3: a paused or freshly upgraded implementation whose balanceOf
        // reverts, which SafeTransferLib reads - correctly - as zero.
        IssuerControlledToken paused = new IssuerControlledToken();
        paused.mint(address(vault), 1_000 ether);
        vault.settle(address(paused));
        paused.setBalanceReverts(true);

        // Member 4: a token that eats every unit of gas forwarded to it.
        GasBombToken bomb = new GasBombToken();
        bomb.mint(address(vault), 1 ether);
        vault.settle(address(bomb));
        bomb.arm(true);

        usdg.mint(address(escrow), 500e6);
        escrow.creditToken(address(vault), address(usdg), 500e6);

        uint256 g0 = gasleft();
        uint256 received = vault.claimToken(address(usdg), type(uint256).max);
        assertLt(g0 - gasleft(), 5_000_000, "no untrusted asset is in the gas path");
        assertEq(received, 500e6);

        // And the money leaves, all the way to the dev's own address.
        uint256 devLeg = vault.devClaimable(address(usdg));
        vm.prank(devPayout);
        vault.withdrawDev(address(usdg), devLeg);
        assertEq(usdg.balanceOf(devPayout), 450e6);

        // Everything already banked in the escrow is recoverable, which is the
        // consequence the brick actually had.
        assertEq(escrow.creditOf(address(vault), address(usdg)), 0);
    }

    /// Narrowing the check must not have REMOVED it for the asset in play.
    function test_property_solvencyIsStillAssertedForTheAssetInPlay() public {
        _activate();

        IssuerControlledToken iusd = new IssuerControlledToken();
        iusd.mint(address(escrow), 1_500 ether);
        escrow.creditToken(address(vault), address(iusd), 1_000 ether);
        vault.claimToken(address(iusd), type(uint256).max);
        assertEq(vault.devClaimable(address(iusd)), 900 ether);

        // The issuer zeroes the vault's balance. The ledger does not move.
        iusd.seize(address(vault));

        escrow.creditToken(address(vault), address(iusd), 500 ether);
        vm.expectRevert(abi.encodeWithSelector(CoinVault.Insolvent.selector, address(iusd)));
        vault.claimToken(address(iusd), type(uint256).max);
    }

    // =======================================================================
    // PROPERTY 2. "HAS MONEY" AND "IS REGISTERED" CANNOT DIVERGE.
    //
    // Two adapter guards were keyed on registry membership, so any way of
    // making a ledgered asset unregistered was a way of switching them off. The
    // demonstrated instance filled the registry to its cap; the property is that
    // the two can never disagree, whatever the registry's size.
    // =======================================================================

    function test_property_everyLedgeredAssetIsRegistered() public {
        _activate();

        JunkToken[] memory junk = new JunkToken[](80);
        vm.startPrank(attacker);
        for (uint256 i; i < 80; ++i) {
            junk[i] = new JunkToken();
            junk[i].mint(address(vault), 1);
            vault.settle(address(junk[i]));
        }
        vm.stopPrank();

        _drop(address(usdg), 1_000e6);

        for (uint256 i; i < 80; ++i) {
            assertTrue(vault.isKnownAsset(address(junk[i])), "past the old cap, still registered");
        }
        assertTrue(vault.isKnownAsset(address(usdg)), "the real asset is registered too");
        assertEq(vault.knownAssetCount(), 81);
    }

    // =======================================================================
    // PROPERTY 3. THE ADAPTER MAY EMIT EXACTLY THREE CALL SHAPES.
    //
    // The old control was a DENYLIST of eleven approve/transfer selectors, and
    // the set of ways to move a token is open: ERC-677, ERC-223, ERC-777, WETH
    // withdraw, DAI permit, Permit2 and multicall were all outside it. Fuzzing
    // the selector is the honest way to state an allowlist.
    // =======================================================================

    function testFuzz_property_onlyTheThreeDesignSelectorsAreEverEmitted(bytes4 selector) public {
        (CoinVault v, MutableAdapter mad) = _vaultWithMutableAdapter();

        bool allowed = selector == bytes4(0x379607f5) // claim(uint256)
            || selector == bytes4(0x1698755f) // claimToken(address,uint256)
            || selector == bytes4(0x2931861b); // transferCreatorFeeRecipient(address,address)
        vm.assume(!allowed);

        // Aimed at the escrow the adapter DECLARES, which the vault holds no
        // balance of and no ledger for. Every other guard therefore passes, and
        // the only thing refusing the call is the selector allowlist.
        mad.setHostile(address(escrow), abi.encodePacked(selector, bytes32(uint256(uint160(thirdParty)))));

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(CoinVault.AdapterCallRejected.selector, address(escrow), selector));
        v.claimToken(address(usdg), 0);
    }

    /**
     * The three that ARE allowed still reach the two targets the adapter
     * declares. This is the failure mode an allowlist has and a denylist does
     * not: locking the vault out of its own escrow.
     */
    function test_property_theAllowedShapesStillWork() public {
        (CoinVault v2,) = _vaultWithMutableAdapter();
        usdg.mint(address(escrow), 100e6);
        escrow.creditToken(address(v2), address(usdg), 100e6);
        uint256 got = v2.claimToken(address(usdg), type(uint256).max);
        assertEq(got, 100e6, "the vault can still claim");

        vm.prank(devPayout);
        v2.terminate();
        assertEq(uint256(v2.state()), uint256(VaultState.TERMINATED));
    }

    // =======================================================================
    // PROPERTY 4. THE ADAPTER MAY NOT CALL ANYTHING THE VAULT HOLDS VALUE IN.
    //
    // Keyed on money now, not on a registry, so an un-settled balance - an
    // airdrop, a vest, the anti-snipe tax, fees since the last settle - is
    // covered by the same rule as a ledgered one.
    // =======================================================================

    function test_property_anUnsettledBalanceIsAsProtectedAsALedgeredOne() public {
        (CoinVault v, MutableAdapter mad) = _vaultWithMutableAdapter();

        ERC677Token airdrop = new ERC677Token();
        airdrop.mint(address(v), 1_000 ether);
        assertFalse(v.isKnownAsset(address(airdrop)), "never settled, so never registered");

        // Even a selector that IS on the allowlist may not be aimed at it: the
        // target is not one the adapter declares, and the vault holds a balance.
        mad.setHostile(address(airdrop), abi.encodeWithSignature("claim(uint256)", uint256(1)));
        vm.prank(attacker);
        vm.expectRevert();
        v.claimToken(address(usdg), 0);
        assertEq(airdrop.balanceOf(address(v)), 1_000 ether);
    }

    /**
     * GUARD 1 ON ITS OWN, with every other guard deliberately satisfied.
     *
     * The adapter here DECLARES the token as its escrow, so the target check
     * passes; the selector is `claim(uint256)`, so the allowlist passes; the
     * asset has never been settled, so the registry check passes. The only thing
     * left standing between a hostile adapter and a token the vault holds is the
     * fact that the vault holds it - which is what "keyed on money" means and
     * what a registry-keyed guard could not say.
     */
    function test_property_guard1AloneStopsACallAtADeclaredTargetWeHoldValueIn() public {
        ERC677Token token = new ERC677Token();

        MutableAdapter mad = new MutableAdapter(address(token), address(feeRegistry));
        Consent memory c = _baseConsent();
        c.adapter = address(mad);
        c.nonce = keccak256("guard1-alone");
        CoinVault v = CoinVault(payable(_deploySigned(c)));
        feeRegistry.setRecipient(address(launch), address(v));
        vm.prank(operator);
        v.bind(address(launch));
        vm.prank(devPayout);
        v.acceptService();
        vm.prank(operator);
        v.activate();

        bytes memory payload = abi.encodeWithSignature("claim(uint256)", uint256(1));

        // CONTROL. With no balance every guard passes and the call is actually
        // DISPATCHED: it dies inside the callee (the token has no claim(uint256)),
        // which is AdapterCallFailed and not AdapterCallRejected. That difference
        // in reason code is the proof that the refusals below are guard 1 and
        // nothing else.
        mad.setHostile(address(token), payload);
        vm.prank(attacker);
        vm.expectRevert(CoinVault.AdapterCallFailed.selector);
        v.claim(0);

        // One wei of that token in the vault, and the same call is refused.
        token.mint(address(v), 1);
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(CoinVault.AdapterCallRejected.selector, address(token), bytes4(0x379607f5))
        );
        v.claim(0);

        // Same again once it carries a ledger rather than a bare balance.
        v.settle(address(token));
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(CoinVault.AdapterCallRejected.selector, address(token), bytes4(0x379607f5))
        );
        v.claim(0);
    }

    // =======================================================================
    // PROPERTY 5. NO ADAPTER BEHAVIOUR CAN BLOCK AN EXIT.
    //
    // The demonstrated instances were a non-canonical bool and an undecodable
    // return. The property is that the adapter is on the far side of an external
    // self-call, so nothing it does reaches the exit's frame.
    // =======================================================================

    function test_property_theDevExitsThroughAnyAdapterBehaviour() public {
        for (uint256 mode; mode < 3; ++mode) {
            (CoinVault v, MutableAdapter mad) = _vaultWithMutableAdapter();
            if (mode == 0) mad.setNonCanonicalBool(true);
            if (mode == 1) mad.setMalformedReturn(true);
            if (mode == 2) {
                mad.setNonCanonicalBool(true);
                mad.setMalformedReturn(true);
            }
            vm.prank(devPayout);
            v.terminate();
            assertEq(uint256(v.state()), uint256(VaultState.TERMINATED), "exit is unconditional");
        }
    }

    function test_property_handbackStepIsSelfCallOnly() public {
        (CoinVault v,) = _vaultWithMutableAdapter();
        vm.prank(attacker);
        vm.expectRevert(CoinVault.OnlySelf.selector);
        v.handbackStep(attacker);
    }

    // =======================================================================
    // PROPERTY 6. EVERY UNIT OF BUDGET SERVES ITS OWN FULL PROOF WINDOW.
    //
    // refundUnproven is permissionless, so this is what makes the commitment
    // rule ("no obligation may exceed the coin's banked escrowed budget at
    // signing") true on-chain rather than only in the broker.
    // =======================================================================

    function testFuzz_property_freshBudgetIsNeverRefundable(uint32 gapSeconds) public {
        gapSeconds = uint32(bound(gapSeconds, 0, uint32(vault.PROOF_WINDOW()) - 1));
        _activate();
        _setDial(2_000);

        _accrue(address(usdg), 1_000e6);
        vm.warp(block.timestamp + vault.PROOF_WINDOW() + 1);
        _accrue(address(usdg), 1_000e6);
        vm.warp(block.timestamp + gapSeconds);

        uint256 fresh = 200e6;
        vm.prank(attacker);
        uint256 refunded = vault.refundUnproven(address(usdg));

        assertEq(refunded, 200e6, "only the aged tranche");
        assertEq(_legs(address(usdg)).budget, fresh, "the fresh tranche stays committed");
    }

    function test_property_agedBudgetIsStillRefundable() public {
        _activate();
        _setDial(2_000);
        _accrue(address(usdg), 1_000e6);
        vm.warp(block.timestamp + vault.PROOF_WINDOW() + 1);

        vm.prank(attacker);
        assertEq(vault.refundUnproven(address(usdg)), 200e6, "the window still opens");
        assertEq(_legs(address(usdg)).budget, 0);
    }

    function test_property_aStrangerCannotGriefProcurementToZero() public {
        _activate();
        _setDial(2_000);

        // Accrue every day for two weeks and try to refund after each one.
        for (uint256 day; day < 14; ++day) {
            _accrue(address(usdg), 100e6);
            vm.warp(block.timestamp + 1 days);
            vm.prank(attacker);
            try vault.refundUnproven(address(usdg)) returns (uint256) {} catch {}
        }

        // The last week of accrual is still there to spend.
        assertGe(_legs(address(usdg)).budget, 20e6 * 6, "recent budget survives the grief loop");
    }

    function test_property_spendingBudgetDoesNotResetAnAgeClock() public {
        _activate();
        _setDial(2_000);
        _accrue(address(usdg), 1_000e6);
        vm.warp(block.timestamp + vault.PROOF_WINDOW() + 1);
        _accrue(address(usdg), 1_000e6);

        // Spend half the matured tranche.
        vm.prank(operator);
        vault.pullBudget(address(usdg), 100e6, keccak256("inv-1"), hex"01");

        vm.prank(attacker);
        assertEq(vault.refundUnproven(address(usdg)), 100e6, "the rest of the matured tranche, and no more");
        assertEq(_legs(address(usdg)).budget, 200e6, "the fresh tranche is untouched");
    }

    /// An exit freezes the budget, and frozen budget goes home immediately.
    function test_property_anExitStillRefundsEverythingAtOnce() public {
        _activate();
        _setDial(2_000);
        _accrue(address(usdg), 1_000e6);

        vm.prank(devPayout);
        vault.terminate();

        vm.prank(attacker);
        assertEq(vault.refundUnproven(address(usdg)), 200e6, "no window survives an exit");
        assertEq(_legs(address(usdg)).budget, 0);
    }

    // =======================================================================
    // PROPERTY 7. FREEZING THE SPEND FREEZES THE ACCRUAL.
    //
    // Freezing an operator's ability to spend procurement while leaving the dial
    // live parks the client's own money where nobody can use it.
    // =======================================================================

    function test_property_sanctionsFreezeStopsBudgetAccrual() public {
        _activate();
        _setDial(2_000);
        _accrue(address(usdg), 1_000e6);
        assertEq(_legs(address(usdg)).budget, 200e6);

        vm.prank(operator);
        vault.sanctionsFreeze();

        _accrue(address(usdg), 1_000e6);
        assertEq(_legs(address(usdg)).budget, 200e6, "not one more unit is parked");
        assertEq(vault.budgetBps(), 0);

        // And what was already parked goes home now, not a window later.
        vm.prank(attacker);
        assertEq(vault.refundUnproven(address(usdg)), 200e6);

        // The dev's own money is untouched throughout, which is the line
        // sanctionsFreeze must never cross.
        uint256 devLeg = vault.devClaimable(address(usdg));
        vm.prank(devPayout);
        vault.withdrawDev(address(usdg), devLeg);
        assertGt(usdg.balanceOf(devPayout), 0);
    }

    // =======================================================================
    // PROPERTY 8. A TERMINAL VAULT HAS NO METER TO STOP.
    // =======================================================================

    function test_property_emergencyDevReleaseRefusesATerminalVault() public {
        _activate();
        vm.prank(operator);
        vault.poison(1);

        vm.warp(block.timestamp + 181 days);
        vm.expectRevert(abi.encodeWithSelector(CoinVault.BadState.selector, VaultState.POISONED));
        vault.emergencyDevRelease();

        // salvage() is gated on POISONED and is still reachable, which is the
        // thing the missing check could have taken away.
        usdg.mint(address(vault), 10e6);
        assertEq(vault.salvage(address(usdg)), 10e6);
    }

    // -----------------------------------------------------------------------

    function _vaultWithMutableAdapter() internal returns (CoinVault v, MutableAdapter mad) {
        mad = new MutableAdapter(address(escrow), address(feeRegistry));
        Consent memory c = _baseConsent();
        c.adapter = address(mad);
        c.nonce = keccak256(abi.encode("hardening", address(mad), vm.getNonce(address(this))));
        v = CoinVault(payable(_deploySigned(c)));
        feeRegistry.setRecipient(address(launch), address(v));

        vm.prank(operator);
        v.bind(address(launch));
        vm.prank(devPayout);
        v.acceptService();
        vm.prank(operator);
        v.activate();
    }

    receive() external payable {}
}
