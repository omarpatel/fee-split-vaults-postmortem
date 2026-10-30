// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IVenueAdapter} from "../../src/interfaces/IVenueAdapter.sol";

/**
 * A quote asset that behaves like the real thing on chain 4663: an upgradeable,
 * pausable, issuer-controlled proxy that may also impose a per-transfer cap and
 * may return nothing instead of a bool.
 *
 * These are not hypotheticals. The pause is why sweep() isolates each asset,
 * and the cap is why claim takes a maxAmount.
 */
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    /// Issuer pauses the implementation; every transfer reverts.
    bool public paused;
    /// Some equity-style quote assets cap a single transfer.
    uint256 public maxTransfer = type(uint256).max;
    /// USDT-style: mutates state but returns no data at all.
    bool public returnsNothing;

    error Paused();
    error OverTransferCap();
    error InsufficientBalance();

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function setPaused(bool v) external {
        paused = v;
    }

    function setMaxTransfer(uint256 v) external {
        maxTransfer = v;
    }

    function setReturnsNothing(bool v) external {
        returnsNothing = v;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function burn(address from, uint256 amount) external {
        balanceOf[from] -= amount;
        totalSupply -= amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        if (returnsNothing) {
            assembly { return(0, 0) }
        }
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        if (returnsNothing) {
            assembly { return(0, 0) }
        }
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        if (paused) revert Paused();
        if (amount > maxTransfer) revert OverTransferCap();
        uint256 b = balanceOf[from];
        if (b < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = b - amount;
        }
        balanceOf[to] += amount;
    }
}

/**
 * WETH with a call counter. Its only job in this suite is to stay at zero:
 * invariant I2 asserts that nothing in the vault ever wraps or unwraps, and a
 * counter that never moves is stronger evidence than an absence of assertions.
 */
contract MockWETH is MockERC20 {
    uint256 public depositCalls;
    uint256 public withdrawCalls;

    constructor() MockERC20("Wrapped Ether", "WETH", 18) {}

    function deposit() external payable {
        ++depositCalls;
        balanceOf[msg.sender] += msg.value;
        totalSupply += msg.value;
    }

    function withdraw(uint256 amount) external {
        ++withdrawCalls;
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "weth: send");
    }
}

/**
 * The Venue V2 fee escrow, faithful on the one property that shapes the whole
 * vault design: CLAIMING IS msg.sender-ONLY. There is no claim-on-behalf and no
 * recipient argument, so whoever calls is whoever gets paid. That is why the
 * vault must be the caller and why the adapter is a calldata builder.
 */
contract MockVenueFeeEscrow {
    mapping(address account => mapping(address asset => uint256)) public creditOf;

    error NothingCredited();

    receive() external payable {}

    /// Test-side crediting. The real escrow is credited by the hook's sweep.
    function creditToken(address account, address asset, uint256 amount) external {
        creditOf[account][asset] += amount;
    }

    function creditNative(address account) external payable {
        creditOf[account][address(0)] += msg.value;
    }

    function claim(uint256 maxAmount) external returns (uint256 claimed) {
        claimed = creditOf[msg.sender][address(0)];
        if (claimed > maxAmount) claimed = maxAmount;
        if (claimed == 0) revert NothingCredited();
        creditOf[msg.sender][address(0)] -= claimed;
        (bool ok,) = msg.sender.call{value: claimed}("");
        require(ok, "escrow: native send");
    }

    function claimToken(address asset, uint256 maxAmount) external returns (uint256 claimed) {
        claimed = creditOf[msg.sender][asset];
        if (claimed > maxAmount) claimed = maxAmount;
        if (claimed == 0) revert NothingCredited();
        creditOf[msg.sender][asset] -= claimed;
        // Low-level, as a real escrow's SafeERC20 would be: some approved quote
        // assets return no data. Still reverts if paused or over the cap.
        (bool ok, bytes memory ret) = asset.call(abi.encodeWithSelector(0xa9059cbb, msg.sender, claimed));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "escrow: transfer failed");
    }
}

/**
 * transferCreatorFeeRecipient is self-service by the CURRENT recipient,
 * immediate, and has no timelock. `locked` simulates the case that motivates
 * fix (b): a Venue-side access-control change that makes handback impossible.
 * terminate() must still succeed.
 */
contract MockCreatorFeeRegistry {
    mapping(address token => address) public creatorFeeRecipient;
    bool public locked;

    event CreatorFeeRecipientChanged(address indexed token, address indexed from, address indexed to);

    error NotCurrentRecipient();
    error RegistryLocked();

    function setRecipient(address token, address who) external {
        creatorFeeRecipient[token] = who;
    }

    function setLocked(bool v) external {
        locked = v;
    }

    function transferCreatorFeeRecipient(address token, address newRecipient) external {
        if (locked) revert RegistryLocked();
        if (msg.sender != creatorFeeRecipient[token]) revert NotCurrentRecipient();
        emit CreatorFeeRecipientChanged(token, msg.sender, newRecipient);
        creatorFeeRecipient[token] = newRecipient;
    }
}

/**
 * An adapter that tries to turn the vault into a confused deputy. Every mode
 * here must be refused by CoinVault._adapterCallAllowed, regardless of the fact
 * that the dev installed this adapter deliberately.
 */
contract HostileAdapter is IVenueAdapter {
    enum Mode {
        APPROVE_ASSET, // drain later via an allowance
        TRANSFER_ASSET, // drain now
        CALL_SELF, // re-enter the vault
        CALL_EOA, // target with no code
        UNPINNED_SELECTOR // a selector it does not itself declare
    }

    address public immutable override escrow;
    address public immutable override recipientRegistry;
    address public target;
    address public attacker;
    Mode public mode;

    constructor(address escrow_, address registry_, address target_, address attacker_) {
        escrow = escrow_;
        recipientRegistry = registry_;
        target = target_;
        attacker = attacker_;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function setTarget(address t) external {
        target = t;
    }

    function adapterId() external pure override returns (string memory) {
        return "hostile";
    }

    function _payload() internal view returns (address, bytes memory) {
        if (mode == Mode.APPROVE_ASSET) {
            return (target, abi.encodeWithSignature("approve(address,uint256)", attacker, type(uint256).max));
        }
        if (mode == Mode.TRANSFER_ASSET) {
            return (target, abi.encodeWithSignature("transfer(address,uint256)", attacker, uint256(1)));
        }
        if (mode == Mode.CALL_SELF) {
            return (msg.sender, abi.encodeWithSignature("settle(address)", target));
        }
        if (mode == Mode.CALL_EOA) {
            return (attacker, abi.encodeWithSignature("claim(uint256)", uint256(1)));
        }
        return (escrow, abi.encodeWithSignature("somethingElse(uint256)", uint256(1)));
    }

    function claimNativeCall(uint256) external view override returns (address, bytes memory) {
        return _payload();
    }

    function claimTokenCall(address, uint256) external view override returns (address, bytes memory) {
        return _payload();
    }

    function transferRecipientCall(address, address) external view override returns (address, bytes memory) {
        return _payload();
    }

    /// Declares everything pinned. The vault's own hardcoded bans must still hold.
    function isPinnedSelector(bytes4) external pure override returns (bool) {
        return true;
    }
}

/// An adapter whose view functions revert. Handback must fail closed, not brick.
contract RevertingAdapter is IVenueAdapter {
    address public immutable override escrow;
    address public immutable override recipientRegistry;

    constructor(address escrow_, address registry_) {
        escrow = escrow_;
        recipientRegistry = registry_;
    }

    function adapterId() external pure override returns (string memory) {
        return "reverting";
    }

    function claimNativeCall(uint256) external pure override returns (address, bytes memory) {
        revert("adapter down");
    }

    function claimTokenCall(address, uint256) external pure override returns (address, bytes memory) {
        revert("adapter down");
    }

    function transferRecipientCall(address, address) external pure override returns (address, bytes memory) {
        revert("adapter down");
    }

    function isPinnedSelector(bytes4) external pure override returns (bool) {
        return true;
    }
}

/// A devPayout that re-enters on receiving native value.
contract ReentrantDev {
    address public vault;
    bool public armed;

    function setVault(address v) external {
        vault = v;
    }

    function arm(bool v) external {
        armed = v;
    }

    function call(address to, bytes calldata data) external returns (bool ok, bytes memory ret) {
        (ok, ret) = to.call(data);
    }

    receive() external payable {
        if (!armed) return;
        // Must revert the whole withdrawal: the vault holds a reentrancy lock.
        (bool ok,) = vault.call(abi.encodeWithSignature("settle(address)", address(0)));
        require(ok, "reenter blocked");
    }
}

/// An ERC-1271 wallet that approves exactly one digest. Used for contract devs.
contract Wallet1271 {
    bytes32 public approvedDigest;

    function approve(bytes32 d) external {
        approvedDigest = d;
    }

    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        return digest == approvedDigest ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
