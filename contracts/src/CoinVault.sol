// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Consent, ConsentLib} from "./lib/ConsentLib.sol";
import {SafeTransferLib} from "./lib/SafeTransferLib.sol";
import {SignatureLib} from "./lib/SignatureLib.sol";
import {IVenueAdapter} from "./interfaces/IVenueAdapter.sol";
import {IVenueFeeEscrow, IVenueCreatorFeeRegistry} from "./interfaces/IVenueExternal.sol";
import {ICoinVault, VaultState, Legs} from "./interfaces/ICoinVault.sol";

interface IVaultDeployerView {
    function factory() external view returns (address);
    function operatorTreasury() external view returns (address);
    function pendingConsent() external view returns (Consent memory);
}

/**
 * One vault per token. Immutable: no owner, no upgrade path, no pause, no
 * admin key, no proxy. The only way to change a rate is to not be this vault.
 *
 * THE FOUR LEGS. Every asset the vault holds is partitioned into dev, budget,
 * operator and referrer. `referrer` is carved out of the operator's own slice
 * and never out of the client's. The partition is maintained by _credit() and
 * is the subject of invariant I1.
 *
 * THE ONE-LINE SPLIT RULE. Fees are charged in exactly one state:
 *
 *     if (state != ACTIVE || asset == launch token) -> 100% to the dev leg
 *
 * Everything the specification asks for about UNBOUND, PASSTHROUGH and the
 * launch token falls out of that single branch rather than out of a table of
 * special cases, which is why there is no state in which the operator can be
 * paid by accident.
 *
 * WHAT THIS CONTRACT NEVER DOES. It never swaps, wraps, unwraps or converts.
 * settle() makes no external call at all beyond `balanceOf`. Every payout
 * function has a HARDCODED destination and takes no address argument, so
 * "where can money go" is answerable by reading three function signatures:
 * DEV_PAYOUT, OPERATOR_TREASURY, REFERRER. There is no vendor path.
 *
 * Timelock constants mirror TERMS in config/protocol.ts. Solidity cannot import
 * them, so test/unit/Parameters.t.sol pins the values and the README records
 * that changing one side requires changing the other.
 */
contract CoinVault is ICoinVault {
    using SafeTransferLib for address;

    uint256 internal constant BPS = 10_000;

    /// TERMS.dialLowerNoticeDays
    uint256 public constant DIAL_LOWER_NOTICE = 7 days;
    /// TERMS.operatorWithdrawNoticeDays
    uint256 public constant OPERATOR_NOTICE = 14 days;
    /// TERMS.adapterMigrationTimelockDays
    uint256 public constant ADAPTER_TIMELOCK = 14 days;
    /// TERMS.procurementProofWindowDays
    uint256 public constant PROOF_WINDOW = 7 days;
    /// TERMS.deadManDays
    uint256 public constant DEAD_MAN = 180 days;

    /**
     * THE ASSET REGISTRY IS NOT ADVISORY, AND SAYING IT WAS COST US TWO GUARDS.
     *
     * The comment that used to stand here said membership was advisory, that
     * nothing moving money depended on it, and that a griefer filling it bought
     * "a less useful view, not a stuck vault". All three were false:
     *
     *   - `_assertSolventAll()` iterated it at the end of BOTH claim paths and
     *     REVERTED on the first shortfall. settle() is permissionless and is
     *     what registers an asset, there is no removal path, and
     *     balanceOfSelf() fails closed to zero. So any address could deploy a
     *     token whose balanceOf it controlled, settle it in (booking a phantom
     *     ledger), drop the reported balance to zero, and every future claim of
     *     every asset reverted forever - stranding every fee already credited
     *     to the vault inside the Venue escrow. About 50k gas, no privileges. The
     *     same end state arrived with no attacker at all from a USDT-style
     *     issuer seizure or a paused implementation on a real quote asset.
     *   - `_adapterCallAllowed` keyed guard 1 on membership, so the CAP below
     *     was a switch that turned the guard off: 64 permissionless settles by
     *     a stranger and the next real quote asset booked its legs while
     *     `isKnownAsset` stayed false, leaving the asset holding the dev's money
     *     reachable by the adapter.
     *
     * Both are fixed at the root. Solvency is now asserted only for the asset a
     * call actually touched, so one asset's shortfall cannot block another's.
     * The adapter guards are keyed on MONEY - the ledger and the balance - not
     * on membership. And registration no longer silently gives up, because a
     * silent partial failure in a security-relevant registry is the worst of the
     * available behaviours. Nothing on a money path iterates this array any
     * more, so its length is a cost to whoever pushes and to nobody else;
     * knownAssetCount/knownAssetAt exist so a reader can page it.
     */
    uint256 public constant MAX_SWEEP = 32;

    bytes32 private constant BIND_TYPEHASH = keccak256("Bind(address vault,address token,uint64 deadline)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    // -----------------------------------------------------------------------
    // Immutables. Every one of these is inside the CREATE2 salt preimage except
    // FACTORY and OPERATOR_TREASURY, which are properties of the factory that
    // deployed this vault and are therefore equally unchangeable.
    // -----------------------------------------------------------------------

    address public immutable FACTORY;
    /// The CREATE2 deployer. Vault addresses derive from this, not from FACTORY.
    address public immutable DEPLOYER;
    address public immutable OPERATOR_TREASURY;
    address public immutable DEV_SIGNER;
    /// The sole destination of the dev leg. Not a parameter anywhere. See I3.
    address public immutable DEV_PAYOUT;
    address public immutable TOKEN_HINT;
    bytes32 public immutable TERMS_HASH;
    /// The consented take rate. Never mutated; see `operatorCeilingBps` for the
    /// live value, which is this number ratcheting toward zero and never back.
    uint16 public immutable OPERATOR_BPS;
    uint16 public immutable BUDGET_BPS_MAX;
    address public immutable REFERRER;
    uint16 public immutable REFERRER_BPS;
    bytes32 public immutable CONSENT_HASH;
    uint64 public immutable DEPLOYED_AT;

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    VaultState private _state;
    address private _token;
    address public adapter;

    /// Dev's procurement dial. Starts at zero: procurement is opt-in.
    uint16 public budgetBps;
    /// Monotone non-increasing. The subject of invariant I5.
    uint16 public operatorCeilingBps;

    uint16 public pendingBudgetBps;
    uint64 public pendingDialUnix;

    address public proposedAdapter;
    uint64 public adapterEffectiveUnix;

    uint64 public operatorNoticeUnix;
    uint64 public lastOperatorActionUnix;
    uint64 public activatedAtUnix;

    /// Set by sanctionsFreeze/poison. Blocks the OPERATOR side only, never the dev.
    bool public operatorFrozen;
    /// Set by every exit path. Makes refundUnproven immediate instead of timed.
    bool public budgetFrozen;

    mapping(address asset => Legs) private legs;

    /**
     * PROOF-WINDOW AGING, IN TWO TRANCHES.
     *
     * The budget leg used to carry ONE timestamp, written only on the 0-to-
     * positive edge, and refundUnproven measured the window from it while
     * applying the result to the WHOLE leg. So budget banked one second ago was
     * refundable the instant the oldest tranche aged out - and refundUnproven is
     * permissionless. A stranger could therefore de-fund an obligation the
     * operator had already signed and already paid a vendor for, which is
     * exactly the failure the commitment rule exists to prevent: on-chain, the
     * banked budget was not actually committed at signing. It was also a free
     * grief - call it after every accrual and a long-lived vault's procurement
     * stays at zero forever.
     *
     * Two tranches are enough and are bounded. `fresh` is the tranche currently
     * accruing; every credit into it pushes the whole tranche's maturity out to
     * that credit's own window, which errs LATE and never early. Once `fresh`
     * has fully aged, the next credit rolls it into `matured` and opens a new
     * one. refundUnproven may take only what has matured.
     */
    struct BudgetTranches {
        uint256 matured;
        uint64 maturedOpensAt;
        uint256 fresh;
        uint64 freshOpensAt;
        /// When the oldest live tranche was first credited. Reporting only.
        uint64 oldestCreditedAt;
    }

    mapping(address asset => BudgetTranches) private budgetTranches;
    mapping(bytes32 invoiceHash => bool) public usedInvoice;

    address[] private knownAssets;
    mapping(address asset => bool) public isKnownAsset;

    uint256 private _lock = 1;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event Bound(address indexed token, address indexed by);
    event StateChanged(VaultState indexed from, VaultState indexed to);
    event Credited(
        address indexed asset, uint256 amount, uint256 toDev, uint256 toBudget, uint256 toOperator, uint256 toReferrer
    );
    event Claimed(address indexed asset, uint256 received, uint256 maxAmount);
    event SweepStepFailed(address indexed asset, bytes32 stage);
    event AssetRegistered(address indexed asset);
    event DevWithdrawn(address indexed asset, uint256 amount, address indexed caller);
    event OperatorWithdrawn(address indexed asset, uint256 amount);
    event ReferrerWithdrawn(address indexed asset, uint256 amount);
    event BudgetPulled(address indexed asset, uint256 amount, bytes32 indexed invoiceHash, bytes32 countersigHash);
    event BudgetRefunded(address indexed asset, uint256 amount, bool forced);
    event Salvaged(address indexed asset, uint256 amount);
    event DialSet(uint16 effectiveBudgetBps, uint64 pendingEffectiveUnix);
    event AdapterProposed(address indexed newAdapter, uint64 effectiveUnix);
    event AdapterProposalCancelled(address indexed cancelled);
    event AdapterChanged(address indexed oldAdapter, address indexed newAdapter, string adapterId);
    event OperatorNoticeGiven(uint64 effectiveUnix);
    event OperatorWithdrew(bool handbackSucceeded);
    event Terminated(address indexed by, bool handbackSucceeded);
    event Disclaimed(uint16 reasonCode, bool handbackSucceeded);
    event Poisoned(uint16 reasonCode);
    event SanctionsFrozen();
    event EmergencyDevRelease(address indexed by, bool handbackSucceeded);
    event EmergencyOperatorLegReleased(address indexed asset, uint256 amount);
    event HandbackFailed(bytes32 reason);
    event Heartbeat(uint64 at);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error OnlyOperator();
    error OnlyDev();
    error OnlyDevPayout();
    error OnlyReferrer();
    error Reentrancy();
    error BadState(VaultState current);
    error AlreadyBound();
    error TokenRequired();
    error TokenMismatch();
    error SignatureExpired();
    error AmountExceedsLeg(uint256 requested, uint256 available);
    error OperatorLegFrozen();
    error BudgetIsFrozen();
    error InvoiceRequired();
    error InvoiceAlreadyUsed();
    error CountersigRequired();
    error NothingToDo();
    error ProofWindowOpen(uint64 opensAt);
    error AboveDialCeiling(uint16 requested, uint16 ceiling);
    error BpsOverflow();
    error NoPendingDial();
    error TimelockPending(uint64 effectiveAt);
    error AdapterNotContract();
    error AdapterNotProposed();
    error AdapterCallRejected(address target, bytes4 selector);
    error AdapterCallFailed();
    error NoNotice();
    error UseClaimForNative();
    error Insolvent(address asset);
    error TooManyAssets();
    /// handbackStep is reachable only through _tryHandback's self-call.
    error OnlySelf();

    // -----------------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------------

    /**
     * Deliberately takes no constructor arguments and reads its configuration
     * back from the deploying factory. That keeps `type(CoinVault).creationCode`
     * -- and therefore the CREATE2 init code hash -- a single constant, so
     * off-chain address prediction needs one hash rather than a per-consent
     * ABI encoding of constructor arguments.
     */
    constructor() {
        DEPLOYER = msg.sender;
        Consent memory c = IVaultDeployerView(msg.sender).pendingConsent();
        OPERATOR_TREASURY = IVaultDeployerView(msg.sender).operatorTreasury();
        FACTORY = IVaultDeployerView(msg.sender).factory();

        CONSENT_HASH = ConsentLib.salt(c);
        DEV_SIGNER = c.devSigner;
        DEV_PAYOUT = c.devPayout;
        TOKEN_HINT = c.token;
        TERMS_HASH = c.termsHash;
        OPERATOR_BPS = c.operatorBps;
        BUDGET_BPS_MAX = c.budgetBpsMax;
        REFERRER = c.referrer;
        REFERRER_BPS = c.referrerBps;
        DEPLOYED_AT = uint64(block.timestamp);

        adapter = c.adapter;
        operatorCeilingBps = c.operatorBps;
        lastOperatorActionUnix = uint64(block.timestamp);
        _state = VaultState.UNBOUND;

        // Known on the retrofit path. Recorded now so that invariant I6 (launch
        // token credits 100% to the dev) holds from block zero, not from bind().
        _token = c.token;
    }

    receive() external payable {}

    // -----------------------------------------------------------------------
    // Modifiers
    // -----------------------------------------------------------------------

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// Any operator-authenticated entry point resets the dead-man clock.
    modifier onlyOperator() {
        if (msg.sender != OPERATOR_TREASURY) revert OnlyOperator();
        lastOperatorActionUnix = uint64(block.timestamp);
        _;
    }

    /// Governance actions accept either consented dev address; payouts do not.
    modifier onlyDev() {
        if (msg.sender != DEV_PAYOUT && msg.sender != DEV_SIGNER) revert OnlyDev();
        _;
    }

    // -----------------------------------------------------------------------
    // Binding
    // -----------------------------------------------------------------------

    function bind(address token_) external onlyOperator {
        _bind(token_);
    }

    /**
     * Relayed bind. The operator signs off-chain and anyone may submit, so the
     * operator never needs gas on chain 4663 to onboard a client. Replay is
     * prevented by the one-shot state check, not by a nonce.
     */
    function bindWithSig(address token_, uint64 deadline, bytes calldata operatorSig) external {
        if (block.timestamp > deadline) revert SignatureExpired();
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01", domainSeparator(), keccak256(abi.encode(BIND_TYPEHASH, address(this), token_, deadline))
            )
        );
        SignatureLib.requireValid(OPERATOR_TREASURY, digest, operatorSig);
        lastOperatorActionUnix = uint64(block.timestamp);
        _bind(token_);
    }

    function _bind(address token_) internal {
        // Invariant I7. Every state other than UNBOUND has already been bound
        // or has permanently exited, so both cases reject here.
        if (_state != VaultState.UNBOUND) revert AlreadyBound();
        if (token_ == address(0)) revert TokenRequired();
        if (TOKEN_HINT != address(0) && TOKEN_HINT != token_) revert TokenMismatch();
        _token = token_;
        _setState(VaultState.BOUND);
        emit Bound(token_, msg.sender);
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("VenueCoinVault"), keccak256("1"), block.chainid, address(this))
        );
    }

    // -----------------------------------------------------------------------
    // State machine
    // -----------------------------------------------------------------------

    /// BOUND -> PENDING. The dev confirms the engagement may begin.
    function acceptService() external onlyDev {
        if (_state != VaultState.BOUND) revert BadState(_state);
        _setState(VaultState.PENDING);
    }

    /// PENDING -> ACTIVE. Charging starts here and nowhere else.
    function activate() external onlyOperator {
        if (_state != VaultState.PENDING) revert BadState(_state);
        activatedAtUnix = uint64(block.timestamp);
        _setState(VaultState.ACTIVE);
    }

    function suspend() external onlyOperator {
        if (_state != VaultState.ACTIVE) revert BadState(_state);
        _setState(VaultState.SUSPENDED);
    }

    function resume() external onlyOperator {
        if (_state != VaultState.SUSPENDED) revert BadState(_state);
        _setState(VaultState.ACTIVE);
    }

    /**
     * FIX (b). The dev's exit is unconditional. It stops charges, freezes the
     * budget for immediate refund, flips to a passthrough splitter, and only
     * THEN attempts to hand recipiency back -- inside try/catch, ignoring the
     * result. A third party's access control never gates our own exit.
     *
     * Residual escrow credit does NOT follow recipiency: it stays under this
     * vault's address. The vault remains fully able to claim() and settle()
     * afterwards, at 100% to the dev. See the README operational note.
     */
    function terminate() external onlyDev {
        _requireLive();
        _stopCharging(VaultState.TERMINATED);
        bool ok = _tryHandback(DEV_PAYOUT);
        emit Terminated(msg.sender, ok);
    }

    /// Operator abandons the engagement immediately and irreversibly.
    function disclaim(uint16 reasonCode) external onlyOperator {
        _requireLive();
        _stopCharging(VaultState.PASSTHROUGH);
        bool ok = _tryHandback(DEV_PAYOUT);
        emit Disclaimed(reasonCode, ok);
    }

    /// FIX (c), step one. Firing a client is unconditional, on notice.
    function giveOperatorWithdrawNotice() external onlyOperator {
        _requireLive();
        operatorNoticeUnix = uint64(block.timestamp + OPERATOR_NOTICE);
        emit OperatorNoticeGiven(operatorNoticeUnix);
    }

    /**
     * FIX (c), step two. Permissionless once the notice has elapsed, so an
     * operator cannot give notice, keep charging, and simply never execute.
     */
    function operatorWithdraw() external {
        uint64 t = operatorNoticeUnix;
        if (t == 0) revert NoNotice();
        if (block.timestamp < t) revert TimelockPending(t);
        _requireLive();
        _stopCharging(VaultState.PASSTHROUGH);
        bool ok = _tryHandback(DEV_PAYOUT);
        emit OperatorWithdrew(ok);
    }

    /// Screening or sanctions kill. Irreversible; the operator side is frozen.
    function poison(uint16 reasonCode) external onlyOperator {
        _requireLive();
        operatorFrozen = true;
        _stopCharging(VaultState.POISONED);
        emit Poisoned(reasonCode);
    }

    /**
     * Freezes the OPERATOR side only. It does not change state, does not touch
     * legs[].dev, and does not block withdrawDev, pushDev, settle, salvage or
     * refundUnproven. Freezing a client's own money would be the custody claim
     * this architecture exists to avoid.
     */
    /**
     * It also stops the PROCUREMENT dial, which it did not used to.
     *
     * The old version ratcheted the operator's take to zero and froze the
     * operator side, but left `budgetBps` live and the state ACTIVE. Every
     * subsequent fee therefore kept carving the client's money into the budget
     * leg - a leg pullBudget refuses to spend while frozen, and which
     * refundUnproven would only release a window later. The dev could not stop
     * the accrual quickly either, because LOWERING the dial is on a seven-day
     * notice. Net: at least a week of the client's own money parked where nobody
     * could use it. Freezing an operator's ability to SPEND procurement without
     * also freezing its ACCRUAL is the one combination that traps client money,
     * which is the opposite of what this function is for.
     *
     * Still deliberately untouched: state, legs[].dev, withdrawDev, pushDev,
     * settle and salvage. Freezing a client's own money would be the custody
     * claim this architecture exists to avoid.
     */
    function sanctionsFreeze() external onlyOperator {
        if (operatorFrozen) revert NothingToDo();
        operatorFrozen = true;
        operatorCeilingBps = 0;
        budgetBps = 0;
        pendingBudgetBps = 0;
        pendingDialUnix = 0;
        budgetFrozen = true;
        emit SanctionsFrozen();
    }

    function heartbeat() external onlyOperator {
        emit Heartbeat(uint64(block.timestamp));
    }

    /**
     * Anyone may stop the meter after DEAD_MAN of total operator silence.
     *
     * `_requireLive` replaces a narrower PASSTHROUGH-only check. Every other
     * exit path calls it; this one did not, so after the dead-man window any
     * address could move a TERMINATED or POISONED vault to PASSTHROUGH - and a
     * POISONED vault moved to PASSTHROUGH stops being able to call salvage(),
     * which is gated on POISONED. No loss was reachable through it, because in
     * PASSTHROUGH the ordinary settle() path credits surplus 100% to the dev,
     * which is what salvage does. It is a state machine that disagreed with
     * itself: this function exists to stop a running meter, and a vault in a
     * terminal state has no meter to stop.
     */
    function emergencyDevRelease() external {
        uint64 deadline = uint64(uint256(lastOperatorActionUnix) + DEAD_MAN);
        if (block.timestamp < deadline) revert TimelockPending(deadline);
        _requireLive();
        _stopCharging(VaultState.PASSTHROUGH);
        bool ok = _tryHandback(DEV_PAYOUT);
        emit EmergencyDevRelease(msg.sender, ok);
    }

    /**
     * After the same silence, already-earned operator and referrer balances
     * would otherwise be stranded forever. Move them to the dev leg rather than
     * burn them -- except when frozen, where frozen funds stay frozen.
     */
    function emergencyDevClaimOperatorLeg(address asset) external nonReentrant returns (uint256 moved) {
        uint64 deadline = uint64(uint256(lastOperatorActionUnix) + DEAD_MAN);
        if (block.timestamp < deadline) revert TimelockPending(deadline);
        if (operatorFrozen) revert OperatorLegFrozen();
        Legs storage L = legs[asset];
        moved = L.operator_ + L.referrer;
        if (moved == 0) revert NothingToDo();
        L.operator_ = 0;
        L.referrer = 0;
        L.dev += moved;
        emit EmergencyOperatorLegReleased(asset, moved);
    }

    function _setState(VaultState next) internal {
        VaultState prev = _state;
        _state = next;
        emit StateChanged(prev, next);
    }

    function _stopCharging(VaultState next) internal {
        operatorCeilingBps = 0; // monotone toward zero, permanently. I5.
        budgetBps = 0;
        pendingBudgetBps = 0;
        pendingDialUnix = 0;
        budgetFrozen = true;
        operatorNoticeUnix = 0;
        _setState(next);
    }

    function _requireLive() internal view {
        VaultState s = _state;
        if (s == VaultState.PASSTHROUGH || s == VaultState.TERMINATED || s == VaultState.POISONED) revert BadState(s);
    }

    // -----------------------------------------------------------------------
    // Claiming. The escrow is msg.sender-ONLY, so the vault must be the caller.
    // -----------------------------------------------------------------------

    /// Native-asset claim, bounded. Permissionless: topping up the vault is safe.
    function claim(uint256 maxAmount) external nonReentrant returns (uint256 received) {
        address asset = SafeTransferLib.NATIVE;
        uint256 before = asset.balanceOfSelf();
        (address target, bytes memory data) = IVenueAdapter(adapter).claimNativeCall(maxAmount);
        _adapterCall(target, data);
        received = asset.balanceOfSelf() - before;
        emit Claimed(asset, received, maxAmount);
        _settle(asset);
        _assertSolvent(asset);
    }

    /**
     * ERC-20 claim. `maxAmount` is a CEILING supplied by the caller: some
     * approved quote assets impose per-transfer caps, so the safe pattern is
     * repeated bounded calls rather than one unbounded one.
     */
    function claimToken(address asset, uint256 maxAmount) external nonReentrant returns (uint256 received) {
        if (asset == SafeTransferLib.NATIVE) revert UseClaimForNative();
        uint256 before = asset.balanceOfSelf();
        (address target, bytes memory data) = IVenueAdapter(adapter).claimTokenCall(asset, maxAmount);
        _adapterCall(target, data);
        received = asset.balanceOfSelf() - before;
        emit Claimed(asset, received, maxAmount);
        _settle(asset);
        _assertSolvent(asset);
    }

    /**
     * Permissionless convenience loop. Each asset is isolated behind its own
     * external self-call so that ONE PAUSED PROXY CANNOT BLOCK THE OTHERS --
     * every approved quote asset is a pausable, issuer-controlled proxy, so
     * this is an expected operating condition, not an exceptional one.
     */
    function sweep(address[] calldata quoteAssets) external returns (uint256 settledCount) {
        uint256 len = quoteAssets.length;
        if (len > MAX_SWEEP) revert TooManyAssets();
        for (uint256 i; i < len; ++i) {
            address a = quoteAssets[i];
            if (a == SafeTransferLib.NATIVE) {
                try this.claim(type(uint256).max) returns (uint256) {}
                catch {
                    emit SweepStepFailed(a, "claim");
                }
            } else {
                try this.claimToken(a, type(uint256).max) returns (uint256) {}
                catch {
                    emit SweepStepFailed(a, "claim");
                }
            }
            try this.settle(a) returns (uint256) {
                ++settledCount;
            } catch {
                emit SweepStepFailed(a, "settle");
            }
        }
    }

    // -----------------------------------------------------------------------
    // Settlement. INVARIANT I2 LIVES HERE.
    // -----------------------------------------------------------------------

    /**
     * Recognise any unaccounted balance and partition it across the four legs.
     *
     * I2 is structural rather than tested-by-sampling: this function makes NO
     * external call other than `balanceOf`, and moves no tokens whatsoever. It
     * cannot swap, wrap or convert because it never calls anything that could.
     * The asset that arrives is the asset that is credited, and the asset that
     * is credited to the dev leg is the asset withdrawDev later transfers.
     */
    function settle(address asset) external nonReentrant returns (uint256 credited) {
        return _settle(asset);
    }

    function _settle(address asset) internal returns (uint256 credited) {
        Legs storage L = legs[asset];
        uint256 accounted = L.dev + L.budget + L.operator_ + L.referrer;
        uint256 bal = asset.balanceOfSelf();
        if (bal <= accounted) return 0;
        credited = bal - accounted;
        _registerAsset(asset);
        _credit(asset, credited);
    }

    /**
     * THE SPLIT RULE, stated exactly once.
     *
     * Charging happens in one state, and the launch token is never charged at
     * all (invariant I6): it is not a quote-denominated fee, it is the client's
     * own supply arriving by vest, by airdrop, or as the 99% anti-snipe tax at
     * t=0 -- which will look like a windfall and must not be taxed as revenue.
     *
     * The dev leg absorbs the rounding remainder, so integer division can only
     * ever round in the client's favour and the four legs sum to `amount`
     * exactly, with no dust escaping the partition.
     *
     * Both the writer (_credit) and the preview (_projected) call this, so a
     * quoted figure can never disagree with what settlement actually does.
     */
    function _splitOf(address asset, uint256 amount)
        internal
        view
        returns (uint256 toDev, uint256 toBudget, uint256 toOperator, uint256 toReferrer)
    {
        if (_state != VaultState.ACTIVE || _isLaunchToken(asset)) return (amount, 0, 0, 0);

        uint256 opGross = (amount * operatorCeilingBps) / BPS;
        toBudget = (amount * budgetBps) / BPS;
        toDev = amount - opGross - toBudget;
        toReferrer = (opGross * REFERRER_BPS) / BPS;
        toOperator = opGross - toReferrer;
    }

    function _credit(address asset, uint256 amount) internal {
        (uint256 toDev, uint256 toBudget, uint256 toOperator, uint256 toReferrer) = _splitOf(asset, amount);

        Legs storage L = legs[asset];
        L.dev += toDev;
        if (toBudget != 0) {
            _bankBudget(asset, toBudget);
            L.budget += toBudget;
        }
        if (toOperator != 0) L.operator_ += toOperator;
        if (toReferrer != 0) L.referrer += toReferrer;

        emit Credited(asset, amount, toDev, toBudget, toOperator, toReferrer);
    }

    /// Bank new budget into the fresh tranche, rolling a fully-aged one back.
    function _bankBudget(address asset, uint256 amount) internal {
        BudgetTranches storage T = budgetTranches[asset];
        uint64 opensAt = uint64(block.timestamp + PROOF_WINDOW);

        if (T.fresh == 0) {
            T.fresh = amount;
        } else if (block.timestamp >= T.freshOpensAt) {
            // The tranche has served its full window: retire it and open a new
            // one, so a vault that keeps accruing still releases old budget.
            T.matured += T.fresh;
            if (T.freshOpensAt > T.maturedOpensAt) T.maturedOpensAt = T.freshOpensAt;
            T.fresh = amount;
        } else {
            // Still inside the current window. Merging pushes the whole
            // tranche's maturity out to this credit's window, which delays
            // older money rather than releasing newer money early.
            T.fresh += amount;
        }
        T.freshOpensAt = opensAt;
        if (T.oldestCreditedAt == 0) T.oldestCreditedAt = uint64(block.timestamp);
    }

    /// Spend from the oldest money first, so a spend cannot reset an age clock.
    function _spendBudget(address asset, uint256 amount) internal {
        BudgetTranches storage T = budgetTranches[asset];
        uint256 fromMatured = amount > T.matured ? T.matured : amount;
        if (fromMatured != 0) T.matured -= fromMatured;
        uint256 rest = amount - fromMatured;
        if (rest != 0) T.fresh = T.fresh > rest ? T.fresh - rest : 0;
        if (T.matured == 0) T.maturedOpensAt = 0;
        if (T.fresh == 0) T.freshOpensAt = 0;
        if (T.matured == 0 && T.fresh == 0) T.oldestCreditedAt = 0;
    }

    function _isLaunchToken(address asset) internal view returns (bool) {
        // address(0) is the native sentinel, never the launch token.
        return asset != address(0) && asset == _token;
    }

    /**
     * A LEDGERED ASSET IS ALWAYS REGISTERED. There is no cap and no silent drop.
     *
     * This used to stop at MAX_KNOWN_ASSETS, emit AssetRegistryFull, and return
     * WITHOUT registering - while `_credit` went on to book the legs regardless.
     * "Has money" and "is registered" could therefore diverge, and both adapter
     * guards were keyed on the second one. Filling the registry was
     * permissionless (64 settles by a stranger), so the divergence was
     * attacker-triggerable on demand.
     */
    function _registerAsset(address asset) internal {
        if (isKnownAsset[asset]) return;
        isKnownAsset[asset] = true;
        knownAssets.push(asset);
        emit AssetRegistered(asset);
    }

    // -----------------------------------------------------------------------
    // Payouts. Every destination below is an immutable, not a parameter.
    // -----------------------------------------------------------------------

    /// INVARIANT I3. There is no address argument. There cannot be one.
    function withdrawDev(address asset, uint256 amount) external nonReentrant {
        if (msg.sender != DEV_PAYOUT) revert OnlyDevPayout();
        _payDev(asset, amount);
    }

    /**
     * Same destination, no caller restriction. Exists so that a devPayout which
     * cannot originate transactions -- a multisig mid-migration, or an exchange
     * deposit address -- can never leave the dev's own money stranded. Pushing
     * the dev's funds to the dev's own immutable address is not an attack.
     */
    function pushDev(address asset) external nonReentrant {
        _payDev(asset, type(uint256).max);
    }

    function _payDev(address asset, uint256 amount) internal {
        _settle(asset);
        Legs storage L = legs[asset];
        uint256 amt = amount == type(uint256).max ? L.dev : amount;
        if (amt == 0) revert NothingToDo();
        if (amt > L.dev) revert AmountExceedsLeg(amt, L.dev);
        L.dev -= amt;
        asset.transfer(DEV_PAYOUT, amt);
        emit DevWithdrawn(asset, amt, msg.sender);
    }

    function withdrawOperator(address asset, uint256 amount) external nonReentrant onlyOperator {
        if (operatorFrozen) revert OperatorLegFrozen();
        _settle(asset);
        Legs storage L = legs[asset];
        uint256 amt = amount == type(uint256).max ? L.operator_ : amount;
        if (amt == 0) revert NothingToDo();
        if (amt > L.operator_) revert AmountExceedsLeg(amt, L.operator_);
        L.operator_ -= amt;
        asset.transfer(OPERATOR_TREASURY, amt);
        emit OperatorWithdrawn(asset, amt);
    }

    function withdrawReferrer(address asset, uint256 amount) external nonReentrant {
        if (msg.sender != REFERRER) revert OnlyReferrer();
        if (operatorFrozen) revert OperatorLegFrozen();
        _settle(asset);
        Legs storage L = legs[asset];
        uint256 amt = amount == type(uint256).max ? L.referrer : amount;
        if (amt == 0) revert NothingToDo();
        if (amt > L.referrer) revert AmountExceedsLeg(amt, L.referrer);
        L.referrer -= amt;
        asset.transfer(REFERRER, amt);
        emit ReferrerWithdrawn(asset, amt);
    }

    /**
     * INVARIANT I4. A REIMBURSEMENT, not a payment.
     *
     * The operator buys all media as principal, in its own name, with its own
     * money, and this repays the operator's own treasury against a countersigned
     * invoice. There is no payee argument, so there is no third-party payee --
     * not by policy, but because the function has nowhere to put one. That is
     * the unlicensed-money-transmission defence, and it is why this signature
     * must never grow an address parameter.
     *
     * The countersignature is recorded as EVIDENCE, not checked as AUTHORITY:
     * verifying a vendor's key on-chain would require a vendor registry, and a
     * registry that can block a fund movement is a registry that affects funds.
     * Registry.sol is deliberately kept out of this path.
     *
     * The on-chain cap is the coin's own banked budget -- the commitment rule.
     * No credit line exists here because there is no balance to draw beyond it.
     */
    function pullBudget(address asset, uint256 amount, bytes32 invoiceHash, bytes calldata vendorCountersig)
        external
        nonReentrant
        onlyOperator
    {
        if (operatorFrozen) revert OperatorLegFrozen();
        if (budgetFrozen) revert BudgetIsFrozen();
        if (_state != VaultState.ACTIVE) revert BadState(_state);
        if (invoiceHash == bytes32(0)) revert InvoiceRequired();
        if (usedInvoice[invoiceHash]) revert InvoiceAlreadyUsed();
        if (vendorCountersig.length == 0) revert CountersigRequired();

        _settle(asset);
        Legs storage L = legs[asset];
        if (amount == 0) revert NothingToDo();
        if (amount > L.budget) revert AmountExceedsLeg(amount, L.budget);

        usedInvoice[invoiceHash] = true;
        L.budget -= amount;
        _spendBudget(asset, amount);

        asset.transfer(OPERATOR_TREASURY, amount);
        emit BudgetPulled(asset, amount, invoiceHash, keccak256(vendorCountersig));
    }

    /**
     * PERMISSIONLESS. Budget that has sat unspent past the proof window returns
     * to the dev leg, and after any exit path it returns immediately.
     *
     * This is a pure leg-to-leg move: no tokens leave the vault, so it cannot
     * fail on a paused asset and cannot be front-run for value.
     */
    function refundUnproven(address asset) external nonReentrant returns (uint256 refunded) {
        _settle(asset);
        Legs storage L = legs[asset];
        if (L.budget == 0) revert NothingToDo();

        bool forced = budgetFrozen;
        BudgetTranches storage T = budgetTranches[asset];

        if (forced) {
            // Every exit path freezes the budget, and frozen budget goes home
            // immediately: there is nothing left to prove against.
            refunded = L.budget;
            T.matured = 0;
            T.maturedOpensAt = 0;
            T.fresh = 0;
            T.freshOpensAt = 0;
            T.oldestCreditedAt = 0;
        } else {
            // ONLY WHAT HAS SERVED ITS OWN WINDOW. Budget banked a second ago is
            // money the operator may already have signed an obligation against
            // and bought media as principal for; releasing it here would make
            // the commitment rule untrue on-chain, and this function is
            // permissionless.
            if (T.matured != 0 && block.timestamp >= T.maturedOpensAt) refunded += T.matured;
            if (T.fresh != 0 && block.timestamp >= T.freshOpensAt) refunded += T.fresh;
            if (refunded == 0) {
                uint64 opensAt = T.matured != 0 ? T.maturedOpensAt : T.freshOpensAt;
                revert ProofWindowOpen(opensAt);
            }
            _spendBudget(asset, refunded);
        }

        L.budget -= refunded;
        L.dev += refunded;
        emit BudgetRefunded(asset, refunded, forced);
    }

    /**
     * When the oldest live budget tranche was first credited. Kept as a function
     * with the same name and signature the public mapping's getter had, so no
     * off-chain reader breaks; the aging decision itself is made from the
     * tranche windows, not from this.
     */
    function budgetOldestUnix(address asset) external view returns (uint64) {
        return budgetTranches[asset].oldestCreditedAt;
    }

    /// The two tranches, readable so an operator can see what is committed.
    function budgetAging(address asset)
        external
        view
        returns (uint256 matured, uint64 maturedOpensAt, uint256 fresh, uint64 freshOpensAt)
    {
        BudgetTranches storage T = budgetTranches[asset];
        return (T.matured, T.maturedOpensAt, T.fresh, T.freshOpensAt);
    }

    /**
     * POISONED-state recovery. Unaccounted surplus goes to the dev leg and only
     * to the dev leg. Restricted to POISONED because in a live vault `settle`
     * is the correct entry point and an unrestricted salvage would let anyone
     * route the operator's earned share away by choosing which function to call.
     */
    function salvage(address asset) external nonReentrant returns (uint256 salvaged) {
        if (_state != VaultState.POISONED) revert BadState(_state);
        Legs storage L = legs[asset];
        uint256 accounted = L.dev + L.budget + L.operator_ + L.referrer;
        uint256 bal = asset.balanceOfSelf();
        if (bal <= accounted) revert NothingToDo();
        salvaged = bal - accounted;
        _registerAsset(asset);
        L.dev += salvaged;
        emit Salvaged(asset, salvaged);
    }

    // -----------------------------------------------------------------------
    // Dev-controlled parameters
    // -----------------------------------------------------------------------

    /// Raising the dial is immediate; lowering it gives the operator notice.
    function setDial(uint16 newBudgetBps) external onlyDev {
        _requireLive();
        if (newBudgetBps > BUDGET_BPS_MAX) revert AboveDialCeiling(newBudgetBps, BUDGET_BPS_MAX);
        if (uint256(operatorCeilingBps) + newBudgetBps > BPS) revert BpsOverflow();

        if (newBudgetBps >= budgetBps) {
            budgetBps = newBudgetBps;
            pendingBudgetBps = 0;
            pendingDialUnix = 0;
            emit DialSet(newBudgetBps, 0);
        } else {
            pendingBudgetBps = newBudgetBps;
            pendingDialUnix = uint64(block.timestamp + DIAL_LOWER_NOTICE);
            emit DialSet(budgetBps, pendingDialUnix);
        }
    }

    /// Permissionless: the parameters were fixed when the notice was given.
    function applyDial() external {
        uint64 t = pendingDialUnix;
        if (t == 0) revert NoPendingDial();
        if (block.timestamp < t) revert TimelockPending(t);
        budgetBps = pendingBudgetBps;
        pendingBudgetBps = 0;
        pendingDialUnix = 0;
        emit DialSet(budgetBps, 0);
    }

    /**
     * FIX (a). Adapter migration is DEV-callable, on a timelock.
     *
     * The Venue ABIs are unpublished. If the adapter were operator-controlled --
     * or worse, frozen -- then a Venue-side ABI change would strand the dev's
     * entire fee stream in a non-upgradeable vault with nobody able to fix it.
     * Handing the migration right to the dev removes that hostage situation:
     * the party whose money is at risk is the party who can rescue it.
     *
     * Deliberately available in terminal states too, because a TERMINATED vault
     * still needs to claim residual escrow credit at 100% to the dev.
     */
    function proposeAdapter(address newAdapter) external onlyDev {
        if (newAdapter == address(0) || newAdapter.code.length == 0) revert AdapterNotContract();
        proposedAdapter = newAdapter;
        adapterEffectiveUnix = uint64(block.timestamp + ADAPTER_TIMELOCK);
        emit AdapterProposed(newAdapter, adapterEffectiveUnix);
    }

    function cancelAdapterProposal() external onlyDev {
        address cancelled = proposedAdapter;
        if (cancelled == address(0)) revert NothingToDo();
        proposedAdapter = address(0);
        adapterEffectiveUnix = 0;
        emit AdapterProposalCancelled(cancelled);
    }

    function setAdapter(address newAdapter) external onlyDev {
        if (newAdapter == address(0) || newAdapter != proposedAdapter) revert AdapterNotProposed();
        uint64 t = adapterEffectiveUnix;
        if (block.timestamp < t) revert TimelockPending(t);
        if (newAdapter.code.length == 0) revert AdapterNotContract();

        address old = adapter;
        adapter = newAdapter;
        proposedAdapter = address(0);
        adapterEffectiveUnix = 0;

        string memory id = "";
        try IVenueAdapter(newAdapter).adapterId() returns (string memory s) {
            id = s;
        } catch {}
        emit AdapterChanged(old, newAdapter, id);
    }

    // -----------------------------------------------------------------------
    // Adapter dispatch
    // -----------------------------------------------------------------------

    /**
     * The adapter proposes a call; these guards decide whether it happens.
     * None of them can be relaxed by installing a different adapter:
     *
     *   1. never call anything the vault holds VALUE in - a ledgered asset, an
     *      asset it merely holds a balance of, or the launch token
     *   2. never call ourselves
     *   3. only ever emit one of the THREE selectors the design has, chosen by
     *      the vault; and only at one of the two targets the adapter declares
     *   4. never send value
     *   5. the asset the call touched must still be solvent afterwards
     *
     * WHY GUARD 1 CHANGED. It used to read `isKnownAsset[target]`, so it covered
     * neither an asset whose registration had silently failed at the old
     * MAX_KNOWN_ASSETS (permissionless to induce) nor any balance that had
     * simply not been settled yet - an airdrop, a vest, the 99% anti-snipe tax,
     * or fees that arrived since the last settle. It is now keyed on money:
     * `accountedOf` for what we owe, and a fail-closed `balanceOfSelf` for what
     * we hold. Neither can diverge from the thing it protects, because it IS the
     * thing it protects.
     *
     * WHY GUARD 3 CHANGED FROM A DENYLIST TO AN ALLOWLIST. `_isBannedSelector`
     * enumerated eleven ERC-20/721/1155 approve-and-transfer selectors and
     * missed every non-ERC20 transfer primitive there is: ERC-677
     * transferAndCall (LINK), ERC-223 transfer(address,uint256,bytes), ERC-777
     * send and authorizeOperator, WETH withdraw, DAI permit, Permit2 approve,
     * multicall. A denylist of primitives is a losing shape - the set of ways to
     * move a token is open and grows - and it also delegated the final say to
     * `isPinnedSelector` on the untrusted adapter itself. The vault knows the
     * only three call shapes it will ever need, so it names them, derived from
     * IVenueExternal members rather than from magic literals. An adapter that
     * needs a fourth is a redesign, not a config change.
     *
     * `isPinnedSelector` is still consulted, and can now only NARROW: an adapter
     * that declines its own selector bricks itself and widens nothing. Its
     * return is decoded TOTALLY (see below) rather than through abi.decode.
     */
    function _adapterCall(address target, bytes memory data) internal {
        bytes4 sel = data.length >= 4 ? bytes4(data) : bytes4(0);
        if (!_adapterCallAllowed(target, data)) revert AdapterCallRejected(target, sel);
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) _bubble(ret);
    }

    function _adapterCallAllowed(address target, bytes memory data) internal view returns (bool) {
        if (target == address(0) || target == address(this)) return false;
        if (target.code.length == 0) return false;

        // GUARD 1, keyed on money rather than on a registry.
        if (target == _token) return false;
        if (isKnownAsset[target]) return false;
        if (accountedOf(target) != 0) return false;
        if (target.balanceOfSelf() != 0) return false;

        if (data.length < 4) return false;
        if (!_isAllowedSelector(bytes4(data))) return false;
        if (!_isAdapterDeclaredTarget(target)) return false;

        // Asked of the adapter via staticcall so a hostile adapter that reverts
        // here fails closed instead of propagating. The result is decoded as a
        // WORD, not as a bool: Solidity's bool decoder reverts on any word that
        // is not 0 or 1, and this function is called from inside `_tryHandback`,
        // where a revert took out the dev's only exit.
        (bool ok, bytes memory ret) =
            adapter.staticcall(abi.encodeWithSelector(IVenueAdapter.isPinnedSelector.selector, bytes4(data)));
        if (!ok || ret.length < 32) return false;
        return abi.decode(ret, (uint256)) != 0;
    }

    /**
     * THE COMPLETE SET. Three call shapes, held by the VAULT, derived from named
     * interface members so a selector cannot be mistyped.
     */
    function _isAllowedSelector(bytes4 s) internal pure returns (bool) {
        return s == IVenueFeeEscrow.claim.selector || s == IVenueFeeEscrow.claimToken.selector
            || s == IVenueCreatorFeeRegistry.transferCreatorFeeRecipient.selector;
    }

    /**
     * The target must be one of the two addresses the adapter itself declares.
     * Read by staticcall and fail-closed: an adapter that reverts or returns
     * garbage here gets no call at all.
     */
    function _isAdapterDeclaredTarget(address target) internal view returns (bool) {
        return target == _adapterAddress(IVenueAdapter.escrow.selector)
            || target == _adapterAddress(IVenueAdapter.recipientRegistry.selector);
    }

    function _adapterAddress(bytes4 selector) internal view returns (address) {
        (bool ok, bytes memory ret) = adapter.staticcall(abi.encodeWithSelector(selector));
        if (!ok || ret.length < 32) return address(0);
        return abi.decode(ret, (address));
    }

    /**
     * THE DEV'S EXIT CANNOT BE TAKEN OUT BY THE ADAPTER.
     *
     * The whole attempt runs inside an external self-call, so nothing it does -
     * a revert, a decode failure, an assertion, an out-of-gas in a sub-call -
     * can touch the frame of terminate(), disclaim(), operatorWithdraw() or
     * emergencyDevRelease().
     *
     * It used to be a typed `try` around the adapter's view call only, and two
     * things then reverted the caller anyway. `_adapterCallAllowed` ran in the
     * SUCCESS block, outside the catch, and did `abi.decode(ret,(bool))` on the
     * adapter's return - Solidity's bool decoder reverts on any word that is not
     * 0 or 1. And Solidity does not route return-data DECODING failures to a
     * catch clause at all, so a `transferRecipientCall` returning a buffer that
     * is not a valid `(address,bytes)` reverted in the vault's own frame. Either
     * one stranded the dev inside an ACTIVE, still-charging vault whose only
     * escape was a 14-day adapter migration.
     *
     * Both root causes are fixed above as well - the decode is total now - and
     * this self-call is the structural belt: any future statement added here is
     * inside the catch by construction rather than by review.
     */
    function _tryHandback(address newRecipient) internal returns (bool) {
        try this.handbackStep(newRecipient) returns (bool ok) {
            if (!ok) emit HandbackFailed("revert");
            return ok;
        } catch {
            emit HandbackFailed("step");
            return false;
        }
    }

    /// Self-call only. Public solely so `_tryHandback` can put it behind a catch.
    function handbackStep(address newRecipient) external returns (bool) {
        if (msg.sender != address(this)) revert OnlySelf();
        address t = _token;
        if (t == address(0)) return false;
        address a = adapter;
        if (a.code.length == 0) return false;

        (address target, bytes memory data) = IVenueAdapter(a).transferRecipientCall(t, newRecipient);
        if (!_adapterCallAllowed(target, data)) return false;
        (bool ok,) = target.call(data);
        return ok;
    }

    /**
     * GUARD 5, SCOPED TO WHAT THE CALL ACTUALLY TOUCHED.
     *
     * This was `_assertSolventAll()`: a loop over every registered asset,
     * reverting on the first shortfall, at the end of both claim paths. Three
     * things were wrong with that shape and only the third is obvious.
     *
     *   1. It made one asset's shortfall block every other asset. The only two
     *      ways money ever enters this vault are claim() and claimToken(), so a
     *      single unbacked ledger entry - phantom, seized, or paused - was a
     *      permanent, unrecoverable brick on the whole revenue path.
     *   2. Registering an entry was permissionless and un-prunable, so any
     *      address could install that shortfall for the price of a token deploy.
     *   3. It staticcalled up to 64 untrusted contracts with all remaining gas,
     *      so a registered asset could consume the caller's entire frame.
     *
     * Checking the asset in play keeps the property the guard is for - an
     * adapter call cannot leave the asset it touched short - and drops the
     * coupling that made every other asset hostage to it. A shortfall on some
     * other asset is real and worth knowing about, but it is not a reason to
     * refuse the money arriving for this one; checkSolvency(asset) reads it for
     * any asset, registered or not, and knownAssetAt pages the registry.
     */
    function _assertSolvent(address asset) internal view {
        (bool ok,,) = checkSolvency(asset);
        if (!ok) revert Insolvent(asset);
    }

    /// Propagate the callee's own revert data; a silent revert gets a named one.
    function _bubble(bytes memory ret) internal pure {
        if (ret.length == 0) revert AdapterCallFailed();
        assembly ("memory-safe") {
            revert(add(ret, 32), mload(ret))
        }
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    function state() external view returns (VaultState) {
        return _state;
    }

    function token() external view returns (address) {
        return _token;
    }

    function legOf(address asset) external view returns (Legs memory) {
        return legs[asset];
    }

    /// Settled only: exactly what withdrawDev can move right now.
    function devClaimable(address asset) public view returns (uint256) {
        return legs[asset].dev;
    }

    function operatorClaimable(address asset) public view returns (uint256) {
        return legs[asset].operator_;
    }

    function referrerClaimable(address asset) public view returns (uint256) {
        return legs[asset].referrer;
    }

    /// Settled plus this asset's share of anything not yet run through settle().
    function devOwed(address asset) external view returns (uint256) {
        (uint256 d,,,) = _projected(asset);
        return d;
    }

    function operatorOwed(address asset) external view returns (uint256) {
        (,, uint256 o,) = _projected(asset);
        return o;
    }

    function referrerOwed(address asset) external view returns (uint256) {
        (,,, uint256 r) = _projected(asset);
        return r;
    }

    /// Spendable procurement escrow. Settled only -- pullBudget settles first.
    function budgetAvailable(address asset) external view returns (uint256) {
        (, uint256 b,,) = _projected(asset);
        return b;
    }

    function accountedOf(address asset) public view returns (uint256) {
        Legs storage L = legs[asset];
        return L.dev + L.budget + L.operator_ + L.referrer;
    }

    /// INVARIANT I1, readable on-chain for any asset, registered or not.
    function checkSolvency(address asset) public view returns (bool solvent, uint256 balance, uint256 accounted) {
        accounted = accountedOf(asset);
        balance = asset.balanceOfSelf();
        solvent = balance >= accounted;
    }

    function knownAssetCount() external view returns (uint256) {
        return knownAssets.length;
    }

    function knownAssetAt(uint256 i) external view returns (address) {
        return knownAssets[i];
    }

    function allKnownAssets() external view returns (address[] memory) {
        return knownAssets;
    }

    function deadManDeadline() external view returns (uint64) {
        return uint64(uint256(lastOperatorActionUnix) + DEAD_MAN);
    }

    function _projected(address asset)
        internal
        view
        returns (uint256 dev_, uint256 budget_, uint256 operator_, uint256 referrer_)
    {
        Legs storage L = legs[asset];
        dev_ = L.dev;
        budget_ = L.budget;
        operator_ = L.operator_;
        referrer_ = L.referrer;

        uint256 accounted = dev_ + budget_ + operator_ + referrer_;
        uint256 bal = asset.balanceOfSelf();
        if (bal <= accounted) return (dev_, budget_, operator_, referrer_);

        (uint256 d, uint256 b, uint256 o, uint256 r) = _splitOf(asset, bal - accounted);
        return (dev_ + d, budget_ + b, operator_ + o, referrer_ + r);
    }
}
