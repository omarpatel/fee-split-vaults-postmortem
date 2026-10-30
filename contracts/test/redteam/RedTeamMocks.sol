// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IVenueAdapter} from "../../src/interfaces/IVenueAdapter.sol";

/**
 * An issuer-controlled, upgradeable, pausable quote-asset proxy -- exactly the
 * shape SafeTransferLib's own comment says EVERY approved quote asset on chain
 * 4663 has. Two issuer powers are modelled, both of which exist on live assets:
 *
 *   seize()              USDT's destroyBlackFunds: the issuer zeroes a holder's
 *                        balance with no transfer. The vault's balance drops
 *                        while the vault's ledger does not.
 *   setBalanceReverts()  A paused or freshly upgraded implementation whose
 *                        balanceOf reverts. SafeTransferLib.balanceOfSelf then
 *                        fails closed and returns 0.
 */
contract IssuerControlledToken {
    string public name = "Issuer USD";
    string public symbol = "IUSD";
    uint8 public decimals = 18;

    mapping(address => uint256) internal _bal;
    uint256 public totalSupply;
    bool public balanceReverts;

    function setBalanceReverts(bool v) external {
        balanceReverts = v;
    }

    function balanceOf(address who) external view returns (uint256) {
        if (balanceReverts) revert("implementation paused");
        return _bal[who];
    }

    function mint(address to, uint256 amount) external {
        _bal[to] += amount;
        totalSupply += amount;
    }

    /// The issuer's freeze-and-destroy power. No transfer, no event the vault sees.
    function seize(address holder) external {
        uint256 b = _bal[holder];
        _bal[holder] = 0;
        totalSupply -= b;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(_bal[msg.sender] >= amount, "bal");
        unchecked {
            _bal[msg.sender] -= amount;
        }
        _bal[to] += amount;
        return true;
    }
}

/**
 * The cheapest possible weapon: a token the ATTACKER wrote, so its balanceOf
 * says whatever the attacker wants, whenever the attacker wants. Costs one
 * deployment and one settle() call.
 */
contract AttackerToken {
    mapping(address => uint256) public balanceOf;

    function setBalance(address who, uint256 v) external {
        balanceOf[who] = v;
    }
}

/// A token whose balanceOf consumes every unit of gas forwarded to it.
contract GasBombToken {
    mapping(address => uint256) internal _bal;
    bool public armed;

    function arm(bool v) external {
        armed = v;
    }

    function mint(address to, uint256 amount) external {
        _bal[to] += amount;
    }

    function balanceOf(address who) external view returns (uint256) {
        if (!armed) return _bal[who];
        uint256 x = 1;
        while (true) {
            x = uint256(keccak256(abi.encode(x)));
        }
        return x;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _bal[msg.sender] -= amount;
        _bal[to] += amount;
        return true;
    }
}

/**
 * ERC-677, i.e. LINK. `transferAndCall(address,uint256,bytes)` moves tokens
 * exactly like `transfer` does, and its selector (0x4000aea0) is not in
 * CoinVault._isBannedSelector. ERC-223's transfer(address,uint256,bytes)
 * (0xbe45fd62) and ERC-777's send/authorizeOperator (0x9bd9bbc6 / 0x959b8c3f)
 * are missing from that list for the same reason: it is a denylist.
 */
contract ERC677Token {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferAndCall(address to, uint256 amount, bytes calldata) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "bal");
        unchecked {
            balanceOf[from] -= amount;
        }
        balanceOf[to] += amount;
    }
}

/// The cheapest possible registry-squat token: mint 1 wei to 64 vault ledgers.
contract JunkToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }
}

/**
 * The residual-trust adapter, made concrete. This is what an UPGRADEABLE
 * operator-supplied adapter looks like after the operator flips it, or what a
 * compromised adapter deployer key produces. Every guard in
 * CoinVault._adapterCall is supposed to make it harmless.
 */
contract MutableAdapter is IVenueAdapter {
    address public immutable override escrow;
    address public immutable override recipientRegistry;

    address public payloadTarget;
    bytes public payloadData;
    bool public hostile;

    /// isPinnedSelector returns a 32-byte word that is neither 0 nor 1.
    bool public nonCanonicalBool;
    /// transferRecipientCall returns a buffer too short to decode.
    bool public malformedReturn;

    constructor(address escrow_, address registry_) {
        escrow = escrow_;
        recipientRegistry = registry_;
    }

    function setHostile(address target_, bytes calldata data_) external {
        hostile = true;
        payloadTarget = target_;
        payloadData = data_;
    }

    function setNonCanonicalBool(bool v) external {
        nonCanonicalBool = v;
    }

    function setMalformedReturn(bool v) external {
        malformedReturn = v;
    }

    function adapterId() external pure override returns (string memory) {
        return "mutable";
    }

    function claimNativeCall(uint256 maxAmount) external view override returns (address, bytes memory) {
        if (hostile) return (payloadTarget, payloadData);
        return (escrow, abi.encodeWithSignature("claim(uint256)", maxAmount));
    }

    function claimTokenCall(address asset, uint256 maxAmount) external view override returns (address, bytes memory) {
        if (hostile) return (payloadTarget, payloadData);
        return (escrow, abi.encodeWithSignature("claimToken(address,uint256)", asset, maxAmount));
    }

    function transferRecipientCall(address token, address newRecipient)
        external
        view
        override
        returns (address, bytes memory)
    {
        if (malformedReturn) {
            assembly ("memory-safe") {
                mstore(0x00, 0x01)
                return(0x00, 0x20)
            }
        }
        return (
            recipientRegistry,
            abi.encodeWithSignature("transferCreatorFeeRecipient(address,address)", token, newRecipient)
        );
    }

    function isPinnedSelector(bytes4) external view override returns (bool) {
        if (nonCanonicalBool) {
            assembly ("memory-safe") {
                mstore(0x00, 2)
                return(0x00, 0x20)
            }
        }
        return true;
    }
}
