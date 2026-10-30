// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {CoinVault} from "../../src/CoinVault.sol";
import {VaultState, Legs} from "../../src/interfaces/ICoinVault.sol";
import {SafeTransferLib} from "../../src/lib/SafeTransferLib.sol";
import {MockERC20, MockWETH, MockVenueFeeEscrow} from "../mocks/Mocks.sol";

/**
 * Bounded action driver for the invariant suite.
 *
 * WHY EVERY CHECK HERE IS A COUNTER AND NOT AN ASSERTION. Some properties are
 * only observable ACROSS a call -- "the amount debited from the dev leg is the
 * amount that arrived at devPayout" -- so they have to be measured here rather
 * than in an invariant function, which only ever sees the state between calls.
 *
 * But an `assertEq` inside a handler REVERTS, and under `fail_on_revert = false`
 * the fuzzer treats a reverting handler call as an uninteresting no-op and moves
 * on. Worse, the revert rolls back the very state change that proved the bug, so
 * the evidence destroys itself. Mutation testing caught exactly that: a vault
 * mutated to pay the caller instead of devPayout went undetected until these
 * checks stopped reverting.
 *
 * So violations increment a counter and let the call stand. Invariants.t.sol
 * asserts each counter is zero, where a failure is reported properly and the
 * offending state is still there to shrink against.
 */
contract VaultHandler is Test {
    CoinVault public immutable vault;
    /// The operatorBps == 0 vault. Invariant I8's subject.
    CoinVault public immutable freeVault;

    MockVenueFeeEscrow public immutable escrow;
    MockWETH public immutable weth;
    MockERC20 public immutable launch;

    address public immutable devPayout;
    address public immutable operator;
    address public immutable referrer;
    address public immutable freeDevPayout;
    /// Never legitimately paid by anything. Invariant I4's canary.
    address public immutable thirdParty;

    address[4] public assets;

    mapping(address asset => uint256) public ghostMinted;
    mapping(address asset => uint256) public ghostDevPaid;
    mapping(address asset => uint256) public ghostOperatorPaid;
    mapping(address asset => uint256) public ghostReferrerPaid;
    mapping(address asset => uint256) public ghostBudgetPulled;
    mapping(address asset => uint256) public ghostFreeDevPaid;

    // Violation counters. Every one of these must stay at zero.
    uint256 public ghostDevMisdirected;
    uint256 public ghostOperatorMisdirected;
    uint256 public ghostBudgetMisdirected;
    uint256 public ghostRefundMovedTokens;
    uint256 public ghostFreeSplitterShortfall;
    uint256 public ghostCrossAssetLeaks;
    uint256 public ghostCeilingIncreases;
    uint256 public ghostChargedWhileInactive;

    uint256 public ghostBindSuccesses;
    uint16 private _lastCeiling;
    uint256 private _invoiceNonce;

    constructor(
        CoinVault vault_,
        CoinVault freeVault_,
        MockVenueFeeEscrow escrow_,
        address[4] memory assets_,
        address[5] memory actors
    ) {
        vault = vault_;
        freeVault = freeVault_;
        escrow = escrow_;
        assets = assets_;
        weth = MockWETH(payable(assets_[1]));
        launch = MockERC20(assets_[3]);

        devPayout = actors[0];
        operator = actors[1];
        referrer = actors[2];
        thirdParty = actors[3];
        freeDevPayout = actors[4];

        _lastCeiling = vault_.operatorCeilingBps();
    }

    receive() external payable {}

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function _asset(uint256 seed) internal view returns (address) {
        return assets[seed % 4];
    }

    function _balanceOf(address asset, address who) internal view returns (uint256) {
        if (asset == SafeTransferLib.NATIVE) return who.balance;
        return MockERC20(asset).balanceOf(who);
    }

    function _mintTo(address asset, address to, uint256 amount) internal {
        if (asset == SafeTransferLib.NATIVE) {
            vm.deal(to, to.balance + amount);
        } else {
            MockERC20(asset).mint(to, amount);
        }
        ghostMinted[asset] += amount;
    }

    /// Snapshot every asset so an action can prove it touched only one of them.
    function _snapshot() internal view returns (uint256[4] memory s) {
        for (uint256 i; i < 4; ++i) {
            s[i] = _balanceOf(assets[i], address(vault));
        }
    }

    function _checkOnlyTouched(address asset, uint256[4] memory before) internal {
        for (uint256 i; i < 4; ++i) {
            if (assets[i] == asset) continue;
            if (_balanceOf(assets[i], address(vault)) != before[i]) ++ghostCrossAssetLeaks;
        }
    }

    function _trackCeiling() internal {
        uint16 c = vault.operatorCeilingBps();
        if (c > _lastCeiling) ++ghostCeilingIncreases;
        _lastCeiling = c;
    }

    /// ACTIVE is the only state in which the operator side may grow at all.
    function _checkChargingOnlyWhenActive(address a, Legs memory before) internal {
        if (vault.state() == VaultState.ACTIVE) return;
        Legs memory now_ = vault.legOf(a);
        if (now_.operator_ > before.operator_ || now_.budget > before.budget || now_.referrer > before.referrer) {
            ++ghostChargedWhileInactive;
        }
    }

    // -----------------------------------------------------------------------
    // Inflows
    // -----------------------------------------------------------------------

    /// Fees arrive via the escrow, exactly as the Venue hook credits them.
    function accrueViaEscrow(uint256 seed, uint256 amount) external {
        address a = _asset(seed);
        amount = bound(amount, 1, 1e24);
        Legs memory before = vault.legOf(a);

        if (a == SafeTransferLib.NATIVE) {
            _mintTo(a, address(this), amount);
            escrow.creditNative{value: amount}(address(vault));
            try vault.claim(type(uint256).max) returns (uint256) {} catch {}
        } else {
            _mintTo(a, address(escrow), amount);
            escrow.creditToken(address(vault), a, amount);
            try vault.claimToken(a, type(uint256).max) returns (uint256) {} catch {}
        }
        _checkChargingOnlyWhenActive(a, before);
        _trackCeiling();
    }

    /// A direct transfer: an airdrop, a vest unlock, or the anti-snipe windfall.
    function dropDirect(uint256 seed, uint256 amount) external {
        address a = _asset(seed);
        amount = bound(amount, 1, 1e24);
        Legs memory before = vault.legOf(a);
        _mintTo(a, address(vault), amount);
        try vault.settle(a) returns (uint256) {} catch {}
        _checkChargingOnlyWhenActive(a, before);
        _trackCeiling();
    }

    function settle(uint256 seed) external {
        try vault.settle(_asset(seed)) returns (uint256) {} catch {}
    }

    function sweepAll() external {
        address[] memory list = new address[](4);
        for (uint256 i; i < 4; ++i) {
            list[i] = assets[i];
        }
        try vault.sweep(list) returns (uint256) {} catch {}
    }

    // -----------------------------------------------------------------------
    // Outflows
    // -----------------------------------------------------------------------

    /// I3 and I2: the debit from the dev leg equals the credit at devPayout, in
    /// the same asset, with no other asset balance moving.
    function withdrawDev(uint256 seed, uint256 amount) external {
        address a = _asset(seed);
        try vault.settle(a) returns (uint256) {} catch {}

        uint256 legBefore = vault.devClaimable(a);
        if (legBefore == 0) return;
        amount = bound(amount, 1, legBefore);
        uint256 recipientBefore = _balanceOf(a, devPayout);
        uint256[4] memory snap = _snapshot();

        bool ok;
        vm.prank(devPayout);
        try vault.withdrawDev(a, amount) {
            ok = true;
        } catch {}
        if (!ok) return;

        uint256 debited = legBefore - vault.devClaimable(a);
        uint256 received = _balanceOf(a, devPayout) - recipientBefore;
        if (debited != amount || received != amount) ++ghostDevMisdirected;
        ghostDevPaid[a] += received;
        _checkOnlyTouched(a, snap);
        _trackCeiling();
    }

    function pushDev(uint256 seed) external {
        address a = _asset(seed);
        try vault.settle(a) returns (uint256) {} catch {}
        uint256 legBefore = vault.devClaimable(a);
        if (legBefore == 0) return;
        uint256 recipientBefore = _balanceOf(a, devPayout);
        uint256[4] memory snap = _snapshot();

        bool ok;
        try vault.pushDev(a) {
            ok = true;
        } catch {}
        if (!ok) return;

        uint256 received = _balanceOf(a, devPayout) - recipientBefore;
        if (received != legBefore) ++ghostDevMisdirected;
        ghostDevPaid[a] += received;
        _checkOnlyTouched(a, snap);
    }

    function withdrawOperator(uint256 seed, uint256 amount) external {
        address a = _asset(seed);
        try vault.settle(a) returns (uint256) {} catch {}
        uint256 legBefore = vault.operatorClaimable(a);
        if (legBefore == 0) return;
        amount = bound(amount, 1, legBefore);
        uint256 before = _balanceOf(a, operator);

        bool ok;
        vm.prank(operator);
        try vault.withdrawOperator(a, amount) {
            ok = true;
        } catch {}
        if (!ok) return;

        uint256 received = _balanceOf(a, operator) - before;
        if (received != amount) ++ghostOperatorMisdirected;
        ghostOperatorPaid[a] += received;
        _trackCeiling();
    }

    function withdrawReferrer(uint256 seed, uint256 amount) external {
        address a = _asset(seed);
        try vault.settle(a) returns (uint256) {} catch {}
        uint256 legBefore = vault.referrerClaimable(a);
        if (legBefore == 0) return;
        amount = bound(amount, 1, legBefore);
        uint256 before = _balanceOf(a, referrer);

        bool ok;
        vm.prank(referrer);
        try vault.withdrawReferrer(a, amount) {
            ok = true;
        } catch {}
        if (!ok) return;

        ghostReferrerPaid[a] += _balanceOf(a, referrer) - before;
    }

    /// I4: a reimbursement pull can only ever land at the operator treasury.
    function pullBudget(uint256 seed, uint256 amount) external {
        address a = _asset(seed);
        try vault.settle(a) returns (uint256) {} catch {}
        uint256 legBefore = vault.budgetAvailable(a);
        if (legBefore == 0) return;
        amount = bound(amount, 1, legBefore);

        uint256 opBefore = _balanceOf(a, operator);
        uint256 thirdBefore = _balanceOf(a, thirdParty);
        uint256 devLegBefore = vault.devClaimable(a);

        bool ok;
        vm.prank(operator);
        try vault.pullBudget(a, amount, keccak256(abi.encode("inv", _invoiceNonce++)), hex"01") {
            ok = true;
        } catch {}
        if (!ok) return;

        if (_balanceOf(a, operator) - opBefore != amount) ++ghostBudgetMisdirected;
        if (_balanceOf(a, thirdParty) != thirdBefore) ++ghostBudgetMisdirected;
        // A budget pull must never be funded out of the client's leg.
        if (vault.devClaimable(a) < devLegBefore) ++ghostBudgetMisdirected;
        ghostBudgetPulled[a] += amount;
        _trackCeiling();
    }

    /// A leg-to-leg move: tokens must not leave the vault at all.
    function refundUnproven(uint256 seed) external {
        address a = _asset(seed);
        uint256 vaultBefore = _balanceOf(a, address(vault));

        bool ok;
        try vault.refundUnproven(a) returns (uint256) {
            ok = true;
        } catch {}
        if (!ok) return;

        if (_balanceOf(a, address(vault)) != vaultBefore) ++ghostRefundMovedTokens;
    }

    function salvage(uint256 seed) external {
        try vault.salvage(_asset(seed)) returns (uint256) {} catch {}
    }

    // -----------------------------------------------------------------------
    // Parameters and lifecycle
    // -----------------------------------------------------------------------

    function setDial(uint256 bps) external {
        vm.prank(devPayout);
        try vault.setDial(uint16(bound(bps, 0, 5_000))) {} catch {}
        _trackCeiling();
    }

    function applyDial() external {
        try vault.applyDial() {} catch {}
    }

    function suspendOrResume(uint256 seed) external {
        vm.prank(operator);
        if (seed % 2 == 0) {
            try vault.suspend() {} catch {}
        } else {
            try vault.resume() {} catch {}
        }
        _trackCeiling();
    }

    /**
     * Non-terminal, so it gets its own reachable action rather than sharing the
     * rare exit path. It ratchets the ceiling to zero while leaving the vault
     * ACTIVE, which is the only way to reach a suspend/resume cycle on a
     * zeroed ceiling -- the exact sequence a "resume restores the rate" bug
     * would need, and the one the first version of this handler never reached.
     */
    function freezeOperator(uint256 seed) external {
        if (seed % 8 != 0) return;
        vm.prank(operator);
        try vault.sanctionsFreeze() {} catch {}
        _trackCeiling();
    }

    /// I7: counted, never assumed.
    function tryBind(uint256 seed) external {
        address t = seed % 2 == 0 ? address(launch) : _asset(seed);
        vm.prank(operator);
        try vault.bind(t) {
            ++ghostBindSuccesses;
        } catch {}
    }

    function heartbeat() external {
        vm.prank(operator);
        try vault.heartbeat() {} catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1 hours, 30 days));
    }

    /// Terminal exits, kept rare so most sequences explore charging deeply.
    function exit(uint256 seed) external {
        if (seed % 48 != 0) return;
        uint256 which = (seed / 48) % 3;
        if (which == 0) {
            vm.prank(devPayout);
            try vault.terminate() {} catch {}
        } else if (which == 1) {
            vm.prank(operator);
            try vault.disclaim(1) {} catch {}
        } else {
            vm.prank(operator);
            try vault.poison(2) {} catch {}
        }
        _trackCeiling();
    }

    // -----------------------------------------------------------------------
    // I8: the operatorBps == 0 vault must stay a working dev splitter.
    // -----------------------------------------------------------------------

    function freeAccrue(uint256 seed, uint256 amount) external {
        address a = _asset(seed);
        if (a == SafeTransferLib.NATIVE) return;
        _mintTo(a, address(freeVault), bound(amount, 1, 1e24));
        try freeVault.settle(a) returns (uint256) {} catch {}
    }

    function freeWithdraw(uint256 seed) external {
        address a = _asset(seed);
        if (a == SafeTransferLib.NATIVE) return;
        try freeVault.settle(a) returns (uint256) {} catch {}
        uint256 leg = freeVault.devClaimable(a);
        if (leg == 0) return;
        uint256 before = _balanceOf(a, freeDevPayout);

        bool ok;
        vm.prank(freeDevPayout);
        try freeVault.withdrawDev(a, leg) {
            ok = true;
        } catch {}
        // A free splitter must never refuse to pay out its whole balance.
        if (!ok) {
            ++ghostFreeSplitterShortfall;
            return;
        }
        if (_balanceOf(a, freeDevPayout) - before != leg) ++ghostFreeSplitterShortfall;
        ghostFreeDevPaid[a] += leg;
    }
}
