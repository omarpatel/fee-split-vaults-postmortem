// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/**
 * Operator-written service record. Append-only.
 *
 * THIS CONTRACT AFFECTS SERVICE AND EVIDENCE, NEVER FUNDS. That is structural,
 * not a promise: it has no payable function, no receive, no fallback, and makes
 * no external call of any kind. Nothing in CoinVault reads it, so a compromised
 * or lying registry can misdescribe a relationship but cannot move a wei.
 *
 * The temptation to have pullBudget check a vendor allowlist here must be
 * refused. The moment a registry entry can block or permit a fund movement, the
 * registry becomes an admin key on every vault, and CoinVault's "no owner"
 * property becomes false by indirection.
 *
 * APPEND-ONLY means there is no update and no delete. A tier change or a
 * re-screening is a NEW record; the previous one stays readable forever. Reads
 * resolve to the latest record for a vault, so history is never rewritten, only
 * superseded.
 *
 * (Doc comment above `contract Registry`; the shared types are declared at file
 * level so other contracts and tests can name them directly.)
 */
/// Mirrors TierId in config/protocol.ts. Ordinals are ABI; append only.
enum Tier {
    T0,
    T1,
    T2,
    T3
}

/// Mirrors ScreeningVerdict in packages/core/src/types.ts.
enum Verdict {
    CLEAR,
    RESTRICTED,
    BLOCKED
}

struct ServiceRecord {
    address vault;
    address token;
    /// keccak256(abi.encode(consent)) -- the CREATE2 salt, pinning the terms.
    bytes32 consentHash;
    Tier tier;
    Verdict verdict;
    /// RESTRICTED permits organic operations but no paid media.
    bool paidMediaPermitted;
    uint64 recordedAt;
    /// keccak of the off-chain screening/qualification evidence bundle.
    bytes32 evidenceHash;
    string note;
}

contract Registry {
    address public immutable operator;

    ServiceRecord[] private _records;
    mapping(address vault => uint256[] recordIds) private _byVault;

    event RecordAppended(
        address indexed vault,
        uint256 indexed recordId,
        address indexed token,
        Tier tier,
        Verdict verdict,
        bool paidMediaPermitted,
        bytes32 consentHash,
        bytes32 evidenceHash
    );

    error OnlyOperator();
    error ZeroAddress();
    error NoRecord();

    constructor(address operator_) {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert OnlyOperator();
        _;
    }

    function append(
        address vault,
        address token,
        bytes32 consentHash,
        Tier tier,
        Verdict verdict,
        bool paidMediaPermitted,
        bytes32 evidenceHash,
        string calldata note
    ) external onlyOperator returns (uint256 recordId) {
        if (vault == address(0)) revert ZeroAddress();
        recordId = _records.length;
        _records.push(
            ServiceRecord({
                vault: vault,
                token: token,
                consentHash: consentHash,
                tier: tier,
                verdict: verdict,
                // Fail closed: a BLOCKED verdict can never carry paid-media rights,
                // whatever the caller passed.
                paidMediaPermitted: verdict == Verdict.BLOCKED ? false : paidMediaPermitted,
                recordedAt: uint64(block.timestamp),
                evidenceHash: evidenceHash,
                note: note
            })
        );
        _byVault[vault].push(recordId);
        emit RecordAppended(
            vault,
            recordId,
            token,
            tier,
            verdict,
            verdict == Verdict.BLOCKED ? false : paidMediaPermitted,
            consentHash,
            evidenceHash
        );
    }

    function recordCount() external view returns (uint256) {
        return _records.length;
    }

    function recordAt(uint256 recordId) external view returns (ServiceRecord memory) {
        return _records[recordId];
    }

    function recordIdsOf(address vault) external view returns (uint256[] memory) {
        return _byVault[vault];
    }

    /// The current service record. Superseded entries remain readable by id.
    function latest(address vault) external view returns (ServiceRecord memory) {
        uint256[] storage ids = _byVault[vault];
        if (ids.length == 0) revert NoRecord();
        return _records[ids[ids.length - 1]];
    }

    function hasRecord(address vault) external view returns (bool) {
        return _byVault[vault].length != 0;
    }
}
