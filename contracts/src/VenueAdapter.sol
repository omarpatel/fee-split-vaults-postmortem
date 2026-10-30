// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IVenueAdapter} from "./interfaces/IVenueAdapter.sol";
import {IVenueFeeEscrow, IVenueCreatorFeeRegistry} from "./interfaces/IVenueExternal.sol";

/**
 * The pinned Venue V2 integration shim.
 *
 * FIXED SELECTOR SET. Three selectors, derived from named interface members
 * rather than magic literals, and enumerable via isPinnedSelector. There is
 * deliberately NO execute(address,bytes), no multicall, no fallback, no owner,
 * and no way to add a fourth selector. A shim that can express an arbitrary
 * call is not a shim, it is a second key on the vault.
 *
 * The escrow and registry addresses are constructor immutables. Repointing them
 * means deploying a new adapter, which the dev must then propose and wait out a
 * 14-day timelock to install -- a public, observable, refusable event.
 *
 * This contract never holds, receives, approves or moves a token. It has no
 * payable function and makes no external call of any kind: every function here
 * is a view that returns bytes for someone else to send. See IVenueAdapter for
 * why the vault, not the adapter, must be the one that sends them.
 */
contract VenueAdapter is IVenueAdapter {
    string private _adapterId;

    address public immutable override escrow;
    address public immutable override recipientRegistry;

    /// claim(uint256)
    bytes4 public constant SEL_CLAIM = IVenueFeeEscrow.claim.selector;
    /// claimToken(address,uint256)
    bytes4 public constant SEL_CLAIM_TOKEN = IVenueFeeEscrow.claimToken.selector;
    /// transferCreatorFeeRecipient(address,address)
    bytes4 public constant SEL_TRANSFER_RECIPIENT = IVenueCreatorFeeRegistry.transferCreatorFeeRecipient.selector;

    error ZeroAddress();
    error NotAContract();

    constructor(string memory adapterId_, address escrow_, address recipientRegistry_) {
        if (escrow_ == address(0) || recipientRegistry_ == address(0)) revert ZeroAddress();
        if (escrow_.code.length == 0 || recipientRegistry_.code.length == 0) revert NotAContract();
        _adapterId = adapterId_;
        escrow = escrow_;
        recipientRegistry = recipientRegistry_;
    }

    function adapterId() external view override returns (string memory) {
        return _adapterId;
    }

    function claimNativeCall(uint256 maxAmount) external view override returns (address target, bytes memory data) {
        return (escrow, abi.encodeWithSelector(SEL_CLAIM, maxAmount));
    }

    function claimTokenCall(address asset, uint256 maxAmount)
        external
        view
        override
        returns (address target, bytes memory data)
    {
        return (escrow, abi.encodeWithSelector(SEL_CLAIM_TOKEN, asset, maxAmount));
    }

    function transferRecipientCall(address token, address newRecipient)
        external
        view
        override
        returns (address target, bytes memory data)
    {
        return (recipientRegistry, abi.encodeWithSelector(SEL_TRANSFER_RECIPIENT, token, newRecipient));
    }

    function isPinnedSelector(bytes4 selector) external pure override returns (bool) {
        return selector == SEL_CLAIM || selector == SEL_CLAIM_TOKEN || selector == SEL_TRANSFER_RECIPIENT;
    }
}
