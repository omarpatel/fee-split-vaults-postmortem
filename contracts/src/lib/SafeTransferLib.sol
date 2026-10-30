// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/**
 * Minimal safe ERC-20 and native transfer helpers, vendored rather than imported.
 *
 * Every approved quote asset on chain 4663 is an upgradeable, pausable,
 * issuer-controlled proxy. Two consequences are handled here:
 *
 *   - Return data is not trustworthy in shape. A proxy implementation may
 *     return nothing, or `false`, or a full word. We accept "no return data"
 *     and "return data that decodes to true", and treat everything else as a
 *     failure.
 *   - A paused implementation makes transfers revert. That must be a per-asset
 *     failure, never a whole-vault failure, so callers wrap loops in try/catch
 *     and this library reverts loudly rather than returning a status.
 */
library SafeTransferLib {
    error TransferFailed(address asset, address to, uint256 amount);
    error NativeTransferFailed(address to, uint256 amount);

    /// Sentinel for the chain's native asset in per-asset accounting maps.
    address internal constant NATIVE = address(0);

    function balanceOfSelf(address asset) internal view returns (uint256) {
        if (asset == NATIVE) return address(this).balance;
        (bool ok, bytes memory data) = asset.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        // A balance we cannot read is not a balance we may spend. Fail closed.
        if (!ok || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }

    function transfer(address asset, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (asset == NATIVE) {
            // 2300 gas is not enough for a contract payout address; forward all
            // remaining gas. Callers hold a reentrancy lock, so this is safe.
            (bool sent,) = to.call{value: amount}("");
            if (!sent) revert NativeTransferFailed(to, amount);
            return;
        }
        (bool ok, bytes memory data) = asset.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed(asset, to, amount);
        }
    }
}
