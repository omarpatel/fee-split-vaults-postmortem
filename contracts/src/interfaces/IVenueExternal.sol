// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/**
 * Best-known shapes of the external Venue V2 surface.
 *
 * THE VENUE ABIS ARE UNPUBLISHED. Everything in this file is a pin derived from
 * on-chain verification, not from a spec, and it is the single most likely part
 * of this repository to be wrong. That is precisely why it lives behind
 * IVenueAdapter and why setAdapter is dev-callable: if these selectors are
 * wrong, a new adapter fixes it, and no vault is stranded.
 *
 * Nothing in src/ imports these interfaces to make a call. They exist so that
 * VenueAdapter can compute selectors from a named signature rather than from a
 * magic 4-byte literal, and so tests can build a faithful escrow fake.
 */
interface IVenueFeeEscrow {
    /// msg.sender-ONLY. There is no claim-on-behalf overload. Verified on chain.
    function claim(uint256 maxAmount) external returns (uint256 claimed);

    /// msg.sender-ONLY, per quote asset, bounded.
    function claimToken(address asset, uint256 maxAmount) external returns (uint256 claimed);

    /// Credited-but-unclaimed NATIVE balance for an account. View only.
    /// Verified on chain 4663 (Sourcify, 2026-09-16): the escrow exposes
    /// balanceOf/balanceOfToken, not a creditOf(account, asset) pair.
    function balanceOf(address account) external view returns (uint256);

    /// Credited-but-unclaimed ERC-20 balance for an account, per quote asset.
    function balanceOfToken(address account, address asset) external view returns (uint256);
}

interface IVenueCreatorFeeRegistry {
    /**
     * Self-service by the CURRENT recipient, immediate, NO timelock.
     * Contrast with the Venue owner's 3-day-timelocked override, which is
     * monitored off-chain via CreatorFeeRecipientChangeProposed and is not
     * addressable from here.
     */
    function transferCreatorFeeRecipient(address token, address newRecipient) external;

    function creatorFeeRecipient(address token) external view returns (address);
}
