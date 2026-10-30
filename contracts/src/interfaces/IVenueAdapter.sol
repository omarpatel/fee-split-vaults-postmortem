// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/**
 * The Venue integration shim, expressed as a CALLDATA BUILDER, not an executor.
 *
 * WHY NOT AN EXECUTOR. The Venue V2 fee escrow is msg.sender-only: there is no
 * claim-on-behalf entry point. If the vault called `adapter.claimToken(...)`,
 * the escrow would see the ADAPTER as msg.sender and would pay the adapter, not
 * the vault. The credited balance belongs to whoever calls, so the caller must
 * be the vault itself.
 *
 * WHY NOT A DELEGATECALL SHIM. Making the adapter delegatecall-able would give
 * a dev-replaceable contract full authority over the vault's storage and its
 * entire balance, which would void invariants I1, I3 and I4 by construction.
 *
 * SO: the adapter is a pure view function that returns `(target, calldata)` and
 * the vault performs the call itself. The adapter can describe a call; it can
 * never make one. Every guard the vault applies to the returned tuple is
 * enforced in CoinVault._adapterCall and cannot be relaxed by a new adapter.
 *
 * Adapters are pinned per vault (the initial one is inside the CREATE2 salt)
 * and may only be replaced by the DEV, on a 14-day timelock. See the README
 * section "The adapter is the residual trust" for the threat analysis.
 */
interface IVenueAdapter {
    /// Human-readable pin, e.g. "venue-v2/escrow-2026-09". Emitted on migration.
    function adapterId() external view returns (string memory);

    /// The Venue V2 fee escrow this adapter targets.
    function escrow() external view returns (address);

    /// The contract exposing transferCreatorFeeRecipient for V2 tokens.
    function recipientRegistry() external view returns (address);

    /**
     * Build a native-asset claim. `maxAmount` is a CEILING, not a request:
     * some approved quote assets impose per-transfer caps, so callers claim in
     * bounded chunks and repeat.
     */
    function claimNativeCall(uint256 maxAmount) external view returns (address target, bytes memory data);

    /// Build a bounded ERC-20 claim for one quote asset.
    function claimTokenCall(address asset, uint256 maxAmount) external view returns (address target, bytes memory data);

    /**
     * Build the self-service recipiency handback. This is immediate and has no
     * timelock on the Venue side, and is callable only by the CURRENT recipient
     * -- which is the vault. Used by CoinVault.terminate() on a best-effort basis.
     */
    function transferRecipientCall(address token, address newRecipient)
        external
        view
        returns (address target, bytes memory data);

    /**
     * The complete set of selectors this adapter will ever emit. The vault
     * checks membership before dispatching. An adapter that returns false for
     * its own emitted selector simply bricks itself; it cannot widen anything.
     */
    function isPinnedSelector(bytes4 selector) external view returns (bool);
}
