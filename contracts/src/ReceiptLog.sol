// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// Mirrors Receipt.kind in packages/core/src/types.ts. Ordinals are ABI.
enum ReceiptKind {
    PROCUREMENT,
    OPERATIONS,
    REFUND,
    FEE
}

struct ReceiptRecord {
    address vault;
    /// Deterministic id from packages/ledger. Replay is idempotent upstream.
    bytes32 receiptId;
    bytes32 disbursementId;
    ReceiptKind kind;
    /// Integer USD cents. Never a float, never a fractional unit.
    uint64 amountUsdCents;
    uint64 occurredAtUnix;
    uint64 publishAfterUnix;
    /// keccak of the full off-chain receipt document.
    bytes32 payloadHash;
    bytes32 evidenceHash;
}

struct PredicateRecord {
    bytes32 receiptId;
    uint64 checkedAtUnix;
    uint64 offsetSeconds;
    bool passed;
    bytes32 evidenceHash;
}

/**
 * Operator-written procurement evidence. Append-only.
 *
 * Like Registry, this contract AFFECTS EVIDENCE, NEVER FUNDS: no payable
 * function, no receive, no fallback, no external calls, and nothing in
 * CoinVault reads it. It is the on-chain anchor for the receipts ledger in
 * packages/ledger, so a client can prove a receipt existed and has not been
 * edited, without this contract ever being able to authorise a payment.
 *
 * USD AMOUNTS ARE INTEGER CENTS. The money rule in packages/core/src/types.ts
 * -- bigint minor units, never floating point -- applies on this side of the
 * boundary too, so nothing here is denominated in a fractional unit.
 *
 * publishAfterUnix carries the 72-hour lag from the Receipt type: an
 * unexecuted commitment published immediately would be a front-runnable
 * purchase calendar. The lag is data here and enforced by the publisher.
 */
contract ReceiptLog {
    address public immutable operator;

    ReceiptRecord[] private _receipts;
    PredicateRecord[] private _predicates;

    mapping(bytes32 receiptId => bool) public receiptExists;
    mapping(bytes32 receiptId => uint256) private _receiptIndex;
    mapping(address vault => uint256[]) private _byVault;
    mapping(bytes32 receiptId => uint256[]) private _predicatesOf;

    event ReceiptPosted(
        address indexed vault,
        bytes32 indexed receiptId,
        uint256 indexed index,
        ReceiptKind kind,
        uint64 amountUsdCents,
        uint64 occurredAtUnix,
        uint64 publishAfterUnix,
        bytes32 payloadHash
    );

    event PredicatePosted(
        bytes32 indexed receiptId, uint256 indexed index, uint64 offsetSeconds, bool passed, bytes32 evidenceHash
    );

    error OnlyOperator();
    error ZeroAddress();
    error ReceiptIdRequired();
    error DuplicateReceipt(bytes32 receiptId);
    error UnknownReceipt(bytes32 receiptId);

    constructor(address operator_) {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert OnlyOperator();
        _;
    }

    function post(ReceiptRecord calldata r) external onlyOperator returns (uint256 index) {
        if (r.vault == address(0)) revert ZeroAddress();
        if (r.receiptId == bytes32(0)) revert ReceiptIdRequired();
        // Append-only implies write-once: a correction is a new receipt that
        // supersedes, never an edit that erases.
        if (receiptExists[r.receiptId]) revert DuplicateReceipt(r.receiptId);

        index = _receipts.length;
        _receipts.push(r);
        receiptExists[r.receiptId] = true;
        _receiptIndex[r.receiptId] = index;
        _byVault[r.vault].push(index);

        emit ReceiptPosted(
            r.vault, r.receiptId, index, r.kind, r.amountUsdCents, r.occurredAtUnix, r.publishAfterUnix, r.payloadHash
        );
    }

    /**
     * Delivery verification. A KOL post is checked at T+24h AND T+7d, so one
     * receipt accumulates several of these over time; each is an append.
     */
    function postPredicate(bytes32 receiptId, uint64 offsetSeconds, bool passed, bytes32 evidenceHash)
        external
        onlyOperator
        returns (uint256 index)
    {
        if (!receiptExists[receiptId]) revert UnknownReceipt(receiptId);
        index = _predicates.length;
        _predicates.push(
            PredicateRecord({
                receiptId: receiptId,
                checkedAtUnix: uint64(block.timestamp),
                offsetSeconds: offsetSeconds,
                passed: passed,
                evidenceHash: evidenceHash
            })
        );
        _predicatesOf[receiptId].push(index);
        emit PredicatePosted(receiptId, index, offsetSeconds, passed, evidenceHash);
    }

    function receiptCount() external view returns (uint256) {
        return _receipts.length;
    }

    function receiptAt(uint256 index) external view returns (ReceiptRecord memory) {
        return _receipts[index];
    }

    function receiptById(bytes32 receiptId) external view returns (ReceiptRecord memory) {
        if (!receiptExists[receiptId]) revert UnknownReceipt(receiptId);
        return _receipts[_receiptIndex[receiptId]];
    }

    function receiptIndicesOf(address vault) external view returns (uint256[] memory) {
        return _byVault[vault];
    }

    function predicateCount() external view returns (uint256) {
        return _predicates.length;
    }

    function predicateAt(uint256 index) external view returns (PredicateRecord memory) {
        return _predicates[index];
    }

    function predicateIndicesOf(bytes32 receiptId) external view returns (uint256[] memory) {
        return _predicatesOf[receiptId];
    }
}
