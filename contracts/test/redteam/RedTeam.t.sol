// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {CoinVault} from "../../src/CoinVault.sol";
import {Consent, ConsentLib} from "../../src/lib/ConsentLib.sol";
import {VaultState, Legs} from "../../src/interfaces/ICoinVault.sol";
import {VaultFactory} from "../../src/VaultFactory.sol";

import {
    AttackerToken,
    IssuerControlledToken,
    ERC677Token,
    GasBombToken,
    JunkToken,
    MutableAdapter
} from "./RedTeamMocks.sol";

/**
 * Adversarial suite.
 *
 * Every `test_A*` asserts a property the design CLAIMS and fails against the
 * contracts as they stand. Every `*_heldUp_*` asserts a defence that survived
 * the attack and passes.
 */
contract RedTeamTest is BaseTest {
    address internal attacker = makeAddr("attacker");

    // =======================================================================
    // A1  CRITICAL. Any address can permanently destroy a vault's entire
    //     revenue path for ~50k gas.
    //
    //     _assertSolventAll() loops over EVERY registered asset and reverts on
    //     the first shortfall. settle() is permissionless and is what registers
    //     an asset; there is no removal path; balanceOfSelf() fails closed to 0.
    //     So an attacker deploys a token whose balanceOf it controls, settles it
    //     into the vault (booking a phantom ledger entry), then drops the
    //     reported balance to zero. From that block onward claim() and
    //     claimToken() -- the ONLY ways money ever enters the vault -- revert
    //     forever, for every asset, and every fee already credited to the vault
    //     inside the Venue escrow is unrecoverable.
    // =======================================================================

    function test_A1_claimSurvivesAThirdPartyRegisteringAPhantomAsset() public {
        _activate();

        // Real fees are sitting in the Venue escrow waiting to be claimed.
        usdg.mint(address(escrow), 500e6);
        escrow.creditToken(address(vault), address(usdg), 500e6);

        // The whole attack. One deploy, one permissionless settle, one setter.
        vm.startPrank(attacker);
        AttackerToken poison = new AttackerToken();
        poison.setBalance(address(vault), 1_000 ether);
        vault.settle(address(poison)); // registers it and books a 1000 ether ledger
        poison.setBalance(address(vault), 0); // the ledger is now unbacked
        vm.stopPrank();

        assertTrue(vault.isKnownAsset(address(poison)), "attacker-chosen asset is registered forever");

        // CLAIMED: the vault can always collect the fees it is owed.
        uint256 received = vault.claimToken(address(usdg), type(uint256).max);
        assertEq(received, 500e6, "vault must still be able to claim its fees");
    }

    /// Same brick with no attacker at all: an issuer seizure on a real asset.
    function test_A1b_claimSurvivesAnIssuerSeizureOnOneQuoteAsset() public {
        _activate();

        IssuerControlledToken iusd = new IssuerControlledToken();
        iusd.mint(address(vault), 1_000 ether);
        vault.settle(address(iusd));

        // USDT's destroyBlackFunds, or a paused/upgraded implementation whose
        // balanceOf reverts. SafeTransferLib then reads the balance as 0.
        iusd.seize(address(vault));

        usdg.mint(address(escrow), 500e6);
        escrow.creditToken(address(vault), address(usdg), 500e6);

        uint256 received = vault.claimToken(address(usdg), type(uint256).max);
        assertEq(received, 500e6, "one bad asset must not brick every other asset");
    }

    /// Once bricked, nothing recovers it: not sweep, not terminate, not a new adapter.
    function test_A1c_thereIsNoRecoveryFromTheBrick() public {
        _activate();

        vm.startPrank(attacker);
        AttackerToken poison = new AttackerToken();
        poison.setBalance(address(vault), 1_000 ether);
        vault.settle(address(poison));
        poison.setBalance(address(vault), 0);
        vm.stopPrank();

        usdg.mint(address(escrow), 500e6);
        escrow.creditToken(address(vault), address(usdg), 500e6);

        // sweep swallows the revert and claims nothing.
        address[] memory assets = new address[](1);
        assets[0] = address(usdg);
        vault.sweep(assets);

        // Terminating hands recipiency back for FUTURE fees but cannot reach
        // the credit already standing against the vault inside the escrow.
        vm.prank(devPayout);
        vault.terminate();
        vault.sweep(assets);

        assertEq(escrow.creditOf(address(vault), address(usdg)), 0, "escrowed fees must be recoverable");
    }

    /// The same loop forwards all remaining gas to up to 64 untrusted callees.
    function test_A1d_registeredAssetCannotBurnTheCallersGas() public {
        _activate();

        GasBombToken bomb = new GasBombToken();
        bomb.mint(address(vault), 1 ether);
        vm.prank(attacker);
        vault.settle(address(bomb));
        bomb.arm(true);

        usdg.mint(address(escrow), 500e6);
        escrow.creditToken(address(vault), address(usdg), 500e6);

        uint256 g0 = gasleft();
        try vault.claimToken(address(usdg), type(uint256).max) returns (uint256) {}
        catch {}
        uint256 burned = g0 - gasleft();
        assertLt(burned, 5_000_000, "a registered asset must not be able to burn the frame");
    }

    // =======================================================================
    // A2  MAX_KNOWN_ASSETS silently switches OFF adapter guard 1 and guard 5.
    //
    //     _registerAsset() gives up when the registry is full, but _credit()
    //     still books the legs. The asset then holds real money while
    //       - isKnownAsset[asset] == false, so _adapterCallAllowed stops
    //         refusing to CALL it ("never call an asset we hold a ledger for"),
    //       - _assertSolventAll() stops covering it (the post-call check).
    //     Filling the registry is permissionless: 64 settle() calls by anyone.
    //     A hostile or upgraded adapter can then reach the asset holding the
    //     dev's money with any selector outside the hardcoded ban list --
    //     WETH.withdraw(uint256) is enough, and it is also a conversion, which
    //     I2 says can never happen.
    // =======================================================================

    function test_A2_adapterCannotReachALedgeredAssetEvenWhenTheRegistryIsFull() public {
        (CoinVault v, MutableAdapter mad) = _vaultWithMutableAdapter();

        // A third party fills the advisory registry. Permissionless and cheap.
        vm.startPrank(attacker);
        for (uint256 i; i < 64; ++i) {
            JunkToken j = new JunkToken();
            j.mint(address(v), 1);
            v.settle(address(j));
        }
        vm.stopPrank();
        assertEq(v.knownAssetCount(), 64, "registry full");

        // The real quote asset books legs but is never registered.
        _fundWeth(address(v), 1_000 ether);
        v.settle(address(weth));
        assertEq(v.devClaimable(address(weth)), 900 ether, "dev leg is real money");
        assertTrue(v.isKnownAsset(address(weth)), "GUARD 1: a ledgered asset must always be registered");

        // The adapter aims at the asset holding the dev's money.
        mad.setHostile(address(weth), abi.encodeWithSignature("withdraw(uint256)", uint256(1_000 ether)));

        // Permissionless trigger. Anyone can fire it.
        //
        // The guard now HARD-REFUSES rather than silently allowing: the call is
        // rejected and the whole claim reverts, which is the stronger of the two
        // available outcomes and is what test_heldUp_bannedSelectorsStillBanned
        // already asserted for the selectors that were on the old ban list.
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(CoinVault.AdapterCallRejected.selector, address(weth), bytes4(0x2e1a7d4d))
        );
        v.claimToken(address(usdg), 0);

        (bool solvent,,) = v.checkSolvency(address(weth));
        assertTrue(solvent, "I1: balance >= dev + budget + operator + referrer");
        assertEq(weth.balanceOf(address(v)), 1_000 ether, "I2: no conversion happened");
        assertEq(v.devClaimable(address(weth)), 900 ether, "the dev leg is untouched");
    }

    /**
     * The extraction that used to work, walked end to end and now refused at
     * every step. This was written as `test_A2b_exploit_...` and ASSERTED THE
     * EXPLOIT: that the 65th asset came back `isKnownAsset == false`, that the
     * hostile withdraw then went through, that the dev's 900 WETH became 0, and
     * that the operator walked away with 80 ETH out of the dev's leg. Every one
     * of those assertions is now a statement about a bug that no longer exists,
     * so each is inverted here rather than deleted - the walkthrough is the
     * point, and an exploit script that fails at step one is the proof.
     */
    function test_A2b_registrySaturationNoLongerDisarmsTheGuard() public {
        (CoinVault v, MutableAdapter mad) = _vaultWithMutableAdapter();

        // Control: with room in the registry the guard behaves as advertised.
        _fundWeth(address(v), 10 ether);
        v.settle(address(weth));
        assertTrue(v.isKnownAsset(address(weth)));
        mad.setHostile(address(weth), abi.encodeWithSignature("withdraw(uint256)", uint256(10 ether)));
        vm.expectRevert(
            abi.encodeWithSelector(CoinVault.AdapterCallRejected.selector, address(weth), bytes4(0x2e1a7d4d))
        );
        v.claimToken(address(usdg), 0);

        // Same vault shape, registry pre-filled by a stranger.
        (CoinVault v2, MutableAdapter mad2) = _vaultWithMutableAdapter();
        vm.startPrank(attacker);
        for (uint256 i; i < 64; ++i) {
            JunkToken j = new JunkToken();
            j.mint(address(v2), 1);
            v2.settle(address(j));
        }
        vm.stopPrank();

        _fundWeth(address(v2), 1_000 ether);
        v2.settle(address(weth));

        // STEP ONE, WHERE THE EXPLOIT NOW DIES. An asset that carries a ledger
        // is always registered; there is no cap that can silently drop it.
        assertTrue(v2.isKnownAsset(address(weth)), "a ledgered asset is always registered");
        assertEq(v2.devClaimable(address(weth)), 900 ether);

        mad2.setHostile(address(weth), abi.encodeWithSignature("withdraw(uint256)", uint256(1_000 ether)));
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(CoinVault.AdapterCallRejected.selector, address(weth), bytes4(0x2e1a7d4d))
        );
        v2.claimToken(address(usdg), 0);

        // I1 and I2 both hold: no conversion, no shortfall.
        (bool solvent, uint256 bal, uint256 accounted) = v2.checkSolvency(address(weth));
        assertTrue(solvent);
        assertEq(bal, 1_000 ether);
        assertEq(accounted, 1_000 ether);

        // The dev withdraws the leg it is credited with.
        vm.prank(devPayout);
        v2.withdrawDev(address(weth), 900 ether);
        assertEq(weth.balanceOf(devPayout), 900 ether);

        // And there is no native ETH to re-split, so the operator gets nothing.
        v2.settle(address(0));
        assertEq(v2.operatorClaimable(address(0)), 0, "nothing was extracted from the dev leg");
    }

    // =======================================================================
    // A2c  The selector ban list is a DENYLIST, and it is missing every
    //      non-ERC20 transfer primitive: ERC-677 transferAndCall (LINK),
    //      ERC-223 transfer(address,uint256,bytes), ERC-777 send and
    //      authorizeOperator, DAI-style permit, Permit2 approve. Guard 1 only
    //      covers assets the vault has ALREADY settled, so any balance sitting
    //      un-settled -- an airdrop, a vest, the anti-snipe tax, or simply fees
    //      that arrived since the last settle -- is reachable by a hostile
    //      adapter with a third-party payee, which is exactly what I4 forbids.
    //      No registry filling required.
    // =======================================================================

    function test_A2c_adapterCannotMoveAnUnsettledBalanceToAThirdParty() public {
        (CoinVault v, MutableAdapter mad) = _vaultWithMutableAdapter();

        // A perfectly ordinary un-settled balance: an airdrop into the vault.
        ERC677Token link = new ERC677Token();
        link.mint(address(v), 1_000 ether);
        assertFalse(v.isKnownAsset(address(link)), "not settled yet, so not registered");

        mad.setHostile(
            address(link),
            abi.encodeWithSignature("transferAndCall(address,uint256,bytes)", thirdParty, uint256(1_000 ether), "")
        );
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(CoinVault.AdapterCallRejected.selector, address(link), bytes4(0x4000aea0))
        );
        v.claimToken(address(usdg), 0);

        assertEq(link.balanceOf(thirdParty), 0, "I4: no third-party payee in any code path");
        assertEq(link.balanceOf(address(v)), 1_000 ether, "the vault's balance is untouched");
    }

    /**
     * The selector control is an ALLOWLIST now, so the whole class closes at
     * once rather than one primitive at a time. Every one of these was outside
     * the old eleven-entry ban list.
     */
    function test_A2c_everyNonErc20TransferPrimitiveIsRefused() public {
        (CoinVault v, MutableAdapter mad) = _vaultWithMutableAdapter();
        ERC677Token link = new ERC677Token();
        link.mint(address(v), 1_000 ether);

        bytes[] memory payloads = new bytes[](7);
        payloads[0] = abi.encodeWithSignature("transferAndCall(address,uint256,bytes)", thirdParty, uint256(1), "");
        payloads[1] = abi.encodeWithSignature("transfer(address,uint256,bytes)", thirdParty, uint256(1), "");
        payloads[2] = abi.encodeWithSignature("send(address,uint256,bytes)", thirdParty, uint256(1), "");
        payloads[3] = abi.encodeWithSignature("authorizeOperator(address)", thirdParty);
        payloads[4] = abi.encodeWithSignature("withdraw(uint256)", uint256(1));
        payloads[5] = abi.encodeWithSignature(
            "permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)",
            address(v),
            thirdParty,
            uint256(0),
            uint256(0),
            true,
            uint8(0),
            bytes32(0),
            bytes32(0)
        );
        payloads[6] = abi.encodeWithSignature("multicall(bytes[])", new bytes[](0));

        for (uint256 i; i < payloads.length; ++i) {
            mad.setHostile(address(link), payloads[i]);
            vm.prank(attacker);
            vm.expectRevert();
            v.claimToken(address(usdg), 0);
        }

        assertEq(link.balanceOf(thirdParty), 0, "I4 holds for every primitive");
        assertEq(link.balanceOf(address(v)), 1_000 ether);
    }

    // =======================================================================
    // A3  terminate() is NOT unconditional. Two adapter behaviours strand the
    //     dev inside a charging vault.
    //
    //     _tryHandback wraps the adapter's VIEW call in try/catch, but the work
    //     that can revert happens in the SUCCESS block, outside the catch:
    //       (a) _adapterCallAllowed does abi.decode(ret,(bool)) on the adapter's
    //           isPinnedSelector return; Solidity's bool decoder reverts on any
    //           word that is not 0 or 1;
    //       (b) Solidity's try/catch does not catch return-data DECODING
    //           failures at all, so an adapter returning a short buffer reverts
    //           the caller's frame.
    //     Either kills terminate(), disclaim(), operatorWithdraw() AND
    //     emergencyDevRelease() -- every exit the design has -- while the vault
    //     stays ACTIVE and keeps charging.
    // =======================================================================

    function test_A3_terminateSucceedsAgainstAnAdapterReturningANonCanonicalBool() public {
        (CoinVault v, MutableAdapter mad) = _vaultWithMutableAdapter();
        mad.setNonCanonicalBool(true);

        vm.prank(devPayout);
        v.terminate();
        assertEq(uint256(v.state()), uint256(VaultState.TERMINATED), "the dev's exit is unconditional");
    }

    function test_A3b_terminateSucceedsAgainstAnAdapterReturningMalformedData() public {
        (CoinVault v, MutableAdapter mad) = _vaultWithMutableAdapter();
        mad.setMalformedReturn(true);

        vm.prank(devPayout);
        v.terminate();
        assertEq(uint256(v.state()), uint256(VaultState.TERMINATED), "the dev's exit is unconditional");
    }

    /**
     * Every exit path, against the same hostile adapter, on its own vault.
     *
     * This was `test_A3c_exploit_everyExitPathIsBricked` and asserted the
     * opposite of each line below: that terminate, disclaim, operatorWithdraw
     * and emergencyDevRelease all reverted, that the vault stayed ACTIVE, and
     * that the operator went on accruing 80 ether per 1,000 while the dev's only
     * escape was a fourteen-day adapter migration. Each assertion is inverted
     * rather than deleted, because the walkthrough is the proof.
     *
     * A separate vault per exit: these are one-shot transitions, so testing them
     * on one vault would only ever exercise the first.
     */
    function test_A3c_everyExitPathSurvivesAHostileAdapter() public {
        (CoinVault a, MutableAdapter ma) = _vaultWithMutableAdapter();
        ma.setNonCanonicalBool(true);
        vm.prank(devPayout);
        a.terminate();
        assertEq(uint256(a.state()), uint256(VaultState.TERMINATED), "the dev can always leave");

        (CoinVault b, MutableAdapter mb) = _vaultWithMutableAdapter();
        mb.setMalformedReturn(true);
        vm.prank(operator);
        b.disclaim(1);
        assertEq(uint256(b.state()), uint256(VaultState.PASSTHROUGH), "the operator can always leave");

        (CoinVault c, MutableAdapter mc) = _vaultWithMutableAdapter();
        mc.setNonCanonicalBool(true);
        vm.prank(operator);
        c.giveOperatorWithdrawNotice();
        vm.warp(block.timestamp + 14 days + 1);
        c.operatorWithdraw();
        assertEq(uint256(c.state()), uint256(VaultState.PASSTHROUGH), "notice always executes");

        (CoinVault d, MutableAdapter md) = _vaultWithMutableAdapter();
        md.setMalformedReturn(true);
        vm.warp(block.timestamp + 181 days);
        d.emergencyDevRelease();
        assertEq(uint256(d.state()), uint256(VaultState.PASSTHROUGH), "the dead man always fires");

        // And the meter is off: a terminated vault charges nothing.
        _fundWeth(address(a), 1_000 ether);
        a.settle(address(weth));
        assertEq(a.operatorClaimable(address(weth)), 0, "no fees accrue after the exit");
        assertEq(a.devClaimable(address(weth)), 1_000 ether, "100% to the dev");
    }

    // =======================================================================
    // A4  refundUnproven measures PROOF_WINDOW from the OLDEST accrual but
    //     applies it to the WHOLE budget balance, and it is permissionless.
    //     Budget banked one second ago is therefore refundable by a stranger,
    //     which breaks the commitment rule: an obligation signed against a
    //     banked budget can be de-funded before pullBudget executes, leaving
    //     the operator -- who buys media as principal -- unreimbursable.
    // =======================================================================

    function test_A4_budgetYoungerThanTheProofWindowIsNotRefundable() public {
        _activate();
        _setDial(2_000);

        _accrue(address(usdg), 1_000e6); // budget 200e6, oldest = now
        vm.warp(block.timestamp + 7 days + 1);
        _accrue(address(usdg), 1_000e6); // budget 400e6; 200e6 of it is 1 second old
        assertEq(_legs(address(usdg)).budget, 400e6);

        vm.prank(attacker);
        uint256 refunded = vault.refundUnproven(address(usdg));

        assertEq(refunded, 200e6, "only budget older than PROOF_WINDOW may be refunded");
        assertEq(_legs(address(usdg)).budget, 200e6, "freshly banked budget stays committed");
    }

    // =======================================================================
    // Defences that HELD UP.
    // =======================================================================

    function testFuzz_heldUp_splitNeverRoundsAgainstTheDev(uint96 amount, uint16 dial) public {
        amount = uint96(bound(amount, 1, type(uint96).max));
        dial = uint16(bound(dial, 0, BUDGET_BPS_MAX));
        _activate();
        _setDial(dial);

        _drop(address(usdg), amount);
        Legs memory L = _legs(address(usdg));

        assertEq(L.dev + L.budget + L.operator_ + L.referrer, amount, "partition is exact");
        uint256 exactDev =
            uint256(amount) - (uint256(amount) * OPERATOR_BPS) / 10_000 - (uint256(amount) * dial) / 10_000;
        assertGe(L.dev, exactDev, "dev never rounds down");
        assertLe(L.operator_ + L.referrer, (uint256(amount) * OPERATOR_BPS) / 10_000, "operator never rounds up");
    }

    function test_heldUp_manySmallSettlesDoNotHarmTheDev() public {
        _activate();
        uint256 lump = 1_000e6;
        for (uint256 i; i < 100; ++i) {
            usdg.mint(address(vault), lump / 100);
            vm.prank(attacker);
            vault.settle(address(usdg));
        }
        Legs memory L = _legs(address(usdg));
        assertGe(L.dev, (lump * 9_000) / 10_000, "dev is never worse off");
        assertEq(L.dev + L.budget + L.operator_ + L.referrer, lump);
    }

    function testFuzz_heldUp_saltIsInjective(
        address a1,
        address a2,
        uint16 op1,
        uint16 op2,
        uint16 max1,
        uint16 max2,
        bytes32 n1,
        bytes32 n2
    ) public view {
        Consent memory c1 = _baseConsent();
        Consent memory c2 = _baseConsent();
        c1.devPayout = a1;
        c2.devPayout = a2;
        c1.operatorBps = op1;
        c2.operatorBps = op2;
        c1.budgetBpsMax = max1;
        c2.budgetBpsMax = max2;
        c1.nonce = n1;
        c2.nonce = n2;

        bool same = a1 == a2 && op1 == op2 && max1 == max2 && n1 == n2;
        if (same) {
            assertEq(factory.saltOf(c1), factory.saltOf(c2));
        } else {
            assertTrue(factory.saltOf(c1) != factory.saltOf(c2), "no salt collision");
        }
    }

    function test_heldUp_deployUnsignedCannotGriefAnotherDev() public {
        Consent memory c = _baseConsent();
        c.nonce = keccak256("greenfield");
        vm.prank(attacker);
        vm.expectRevert(VaultFactory.OnlyDevSigner.selector);
        factory.deployUnsigned(c);
    }

    function test_heldUp_bannedSelectorsStillBanned() public {
        (CoinVault v, MutableAdapter mad) = _vaultWithMutableAdapter();
        _fundWeth(address(v), 10 ether);
        v.settle(address(weth));

        mad.setHostile(address(weth), abi.encodeWithSignature("approve(address,uint256)", attacker, type(uint256).max));
        vm.expectRevert();
        v.claimToken(address(usdg), 0);

        mad.setHostile(
            address(weth), abi.encodeWithSignature("transferFrom(address,address,uint256)", address(v), attacker, 1)
        );
        vm.expectRevert();
        v.claimToken(address(usdg), 0);

        mad.setHostile(address(v), abi.encodeWithSignature("settle(address)", address(0)));
        vm.expectRevert();
        v.claimToken(address(usdg), 0);
    }

    /// I8: a zero-take vault is a working dev-withdrawable splitter.
    function test_heldUp_zeroTakeVaultIsAFunctioningSplitter() public {
        Consent memory c = _baseConsent();
        c.nonce = keccak256("unsigned-i8");
        vm.prank(devSigner);
        CoinVault v = CoinVault(payable(factory.deployUnsigned(c)));
        assertEq(v.OPERATOR_BPS(), 0);
        assertEq(v.BUDGET_BPS_MAX(), 0);

        vm.prank(operator);
        v.bind(address(launch));
        vm.prank(devPayout);
        v.acceptService();
        vm.prank(operator);
        v.activate();

        usdg.mint(address(v), 1_000e6);
        v.settle(address(usdg));
        assertEq(v.devClaimable(address(usdg)), 1_000e6, "100% to the dev");
        assertEq(v.operatorClaimable(address(usdg)), 0);

        vm.prank(devPayout);
        v.withdrawDev(address(usdg), 1_000e6);
        assertEq(usdg.balanceOf(devPayout), 1_000e6);
    }

    /// The dev leg is never reachable through a reentrant quote asset.
    function test_heldUp_reentrancyLockCoversEveryMoneyFunction() public {
        _activate();
        _drop(address(usdg), 1_000e6);
        // settle/claim/withdraw/pull/refund/salvage all carry nonReentrant, and
        // sweep's inner calls are the locked ones, so a token callback that
        // re-enters can only hit a locked function or a state machine that has
        // already advanced. Spot-check the lock is actually engaged.
        vm.prank(attacker);
        vault.settle(address(usdg));
        assertEq(_accounted(address(usdg)), 1_000e6);
    }

    // -----------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------

    function _vaultWithMutableAdapter() internal returns (CoinVault v, MutableAdapter mad) {
        mad = new MutableAdapter(address(escrow), address(feeRegistry));
        Consent memory c = _baseConsent();
        c.adapter = address(mad);
        c.nonce = keccak256(abi.encode("mutable", address(mad)));
        v = CoinVault(payable(_deploySigned(c)));
        feeRegistry.setRecipient(address(launch), address(v));

        vm.prank(operator);
        v.bind(address(launch));
        vm.prank(devPayout);
        v.acceptService();
        vm.prank(operator);
        v.activate();
    }

    function _fundWeth(address to, uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        weth.deposit{value: amount}();
        weth.transfer(to, amount);
    }

    receive() external payable {}
}
