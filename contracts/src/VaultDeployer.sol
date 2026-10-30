// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Consent} from "./lib/ConsentLib.sol";
import {CoinVault} from "./CoinVault.sol";

/**
 * Holds CoinVault's creation code and nothing else.
 *
 * WHY THIS EXISTS. `new CoinVault{salt: ...}()` embeds the vault's entire init
 * code in whatever contract performs it. Doing that inside VaultFactory put the
 * factory over the EIP-170 24,576-byte runtime limit, and -- worse -- would
 * have left any future audit fix competing for a few hundred spare bytes in the
 * one contract that must never be redeployed casually. Separating the two gives
 * both contracts several kilobytes of headroom.
 *
 * Deployed once, by VaultFactory's constructor, and bound to it immutably.
 * CREATE2 addresses derive from THIS address, so VaultFactory.predictVault
 * hashes `deployer`, not itself.
 *
 * This contract is not a privilege. It cannot choose a salt, cannot alter a
 * consent, and cannot deploy for anyone but its factory; it is a bytecode
 * container with a single caller.
 */
contract VaultDeployer {
    address public immutable factory;
    address public immutable operatorTreasury;

    /// Live only for the duration of one deploy; read by the vault constructor.
    Consent private _pending;

    error OnlyFactory();
    error NotDeploying();

    constructor(address operatorTreasury_) {
        factory = msg.sender;
        operatorTreasury = operatorTreasury_;
    }

    /// The salt is computed and validated by the factory; this only executes it.
    function deployVault(Consent calldata consent, bytes32 salt) external returns (address vault) {
        if (msg.sender != factory) revert OnlyFactory();
        _pending = consent;
        vault = address(new CoinVault{salt: salt}());
        delete _pending;
    }

    /// Read by CoinVault's constructor. Reverts outside a deploy.
    function pendingConsent() external view returns (Consent memory c) {
        c = _pending;
        if (c.devPayout == address(0)) revert NotDeploying();
    }

    function vaultInitCodeHash() external pure returns (bytes32) {
        return keccak256(type(CoinVault).creationCode);
    }
}
