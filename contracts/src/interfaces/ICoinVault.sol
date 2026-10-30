// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/**
 * Mirrors `VaultState` in packages/core/src/types.ts. Ordinals are part of the
 * ABI: off-chain readers decode by index, so members may be appended but never
 * reordered or removed.
 *
 *   UNBOUND     deployed, recipiency not yet confirmed. 100% dev, zero take.
 *   PASSTHROUGH operator has permanently left. 100% dev, zero take. Terminal.
 *   BOUND       recipiency confirmed, service not yet accepted. No charging.
 *   PENDING     dev accepted, operator has not activated. No charging.
 *   ACTIVE      the only state in which any fee is ever charged.
 *   SUSPENDED   service paused. No charging, no procurement. Reversible.
 *   POISONED    screening/sanctions kill. No charging, operator leg frozen. Terminal.
 *   TERMINATED  dev exited. 100% dev, zero take. Terminal.
 */
enum VaultState {
    UNBOUND,
    PASSTHROUGH,
    BOUND,
    PENDING,
    ACTIVE,
    SUSPENDED,
    POISONED,
    TERMINATED
}

/**
 * Per-asset ledger. The sum of these four numbers is the vault's ACCOUNTED
 * balance for that asset; invariant I1 is exactly
 * `balanceOf(vault, asset) >= dev + budget + operator + referrer`.
 *
 * `referrer` is a SUB-ACCOUNT OF THE OPERATOR LEG, funded only by carving the
 * operator's own slice. It is never funded from `dev` or `budget`, so a
 * referral arrangement can never dilute the client. See CoinVault._credit.
 */
struct Legs {
    uint256 dev;
    uint256 budget;
    uint256 operator_;
    uint256 referrer;
}

interface ICoinVault {
    function state() external view returns (VaultState);
    function token() external view returns (address);

    function devOwed(address asset) external view returns (uint256);
    function budgetAvailable(address asset) external view returns (uint256);
    function operatorOwed(address asset) external view returns (uint256);
    function checkSolvency(address asset) external view returns (bool solvent, uint256 balance, uint256 accounted);
}
