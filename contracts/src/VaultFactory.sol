// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Consent, ConsentLib} from "./lib/ConsentLib.sol";
import {SignatureLib} from "./lib/SignatureLib.sol";
import {VaultDeployer} from "./VaultDeployer.sol";

/**
 * Singleton vault factory. NO owner, NO upgrade path, NO admin key, no pause,
 * no fee switch, no allowlist. Read the whole file: there is no privileged
 * function in it, and that is a load-bearing property rather than an omission.
 *
 * THE SALT IS THE ENTIRE AGREEMENT.
 *
 *     salt = keccak256(abi.encode(consent))
 *
 * Every economic term -- operatorBps, budgetBpsMax, adapter, referrer,
 * referrerBps, devPayout, termsHash -- is in that preimage. A vault deployed at
 * a 10% take rate lives at a different address from the same dev at 12%, so
 * "repricing an existing customer" is not a forbidden operation, it is an
 * unrepresentable one: the vault at the old address cannot be redeployed and
 * the vault at the new address is a different contract the dev never signed for.
 *
 * The operator treasury is a constructor immutable and can never rotate.
 * Rotating it means deploying a new factory, which changes every future vault
 * address and is therefore visible to everyone. An operator key compromise
 * costs the operator its own revenue and can never reach a dev leg.
 */
contract VaultFactory {
    using ConsentLib for Consent;

    /**
     * Structural ceilings, set here so that no future vault can exceed them
     * whatever a signed consent says. TERMS.operatorBps in config/protocol.ts
     * is a placeholder that Phase 0 flagged as the most likely-wrong number in
     * the repo, so the contract refuses to be the place where a mistake there
     * becomes permanent. Exceeding these requires a NEW FACTORY, which is
     * public, address-changing, and exactly as visible as it should be.
     */
    uint16 public constant MAX_OPERATOR_BPS = 2_000;
    uint16 public constant MAX_BUDGET_BPS_MAX = 5_000;
    uint16 private constant BPS = 10_000;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    address public immutable operatorTreasury;

    /// Holds CoinVault's init code. CREATE2 addresses derive from THIS address.
    VaultDeployer public immutable deployer;

    /**
     * Constant because CoinVault takes no constructor arguments: it reads its
     * configuration back from `pendingConsent()` during construction. That
     * keeps address prediction a single keccak off-chain rather than a
     * per-consent ABI encode of constructor arguments.
     */
    bytes32 public immutable VAULT_INIT_CODE_HASH;

    bytes32 private immutable _cachedDomainSeparator;
    uint256 private immutable _cachedChainId;

    mapping(bytes32 salt => address vault) public vaultOf;
    mapping(address vault => bytes32 salt) public consentHashOf;
    mapping(address vault => bool) public isVault;
    address[] private _allVaults;

    /**
     * The full consent is emitted as one ABI-encoded struct rather than as a
     * dozen loose fields. Indexers get every economic term, and the salt in the
     * topic lets anyone recompute the address and confirm the terms are the
     * ones that produced it.
     */
    event VaultDeployed(
        address indexed vault, address indexed devPayout, bytes32 indexed salt, Consent consent, bool unsigned
    );

    error ZeroAddress();
    error AdapterNotContract();
    error ConsentExpired(uint64 expiryUnix);
    error OperatorBpsTooHigh(uint16 requested, uint16 ceiling);
    error BudgetCeilingTooHigh(uint16 requested, uint16 ceiling);
    error DevShareWouldBeZero();
    error ReferrerBpsTooHigh();
    error ReferrerBpsWithoutReferrer();
    error TermsHashRequired();
    error AlreadyDeployed(address vault);
    error OnlyDevSigner();

    constructor(address operatorTreasury_) {
        if (operatorTreasury_ == address(0)) revert ZeroAddress();
        operatorTreasury = operatorTreasury_;
        VaultDeployer d = new VaultDeployer(operatorTreasury_);
        deployer = d;
        VAULT_INIT_CODE_HASH = d.vaultInitCodeHash();
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    // -----------------------------------------------------------------------
    // Prediction
    // -----------------------------------------------------------------------

    /// Pure CREATE2 prediction. Reproducible off-chain from the factory address
    /// and VAULT_INIT_CODE_HASH alone; see packages/chain for the mirror.
    function predictVault(Consent calldata consent) external view returns (address) {
        return _predict(ConsentLib.salt(consent));
    }

    /// Prediction for the normalised consent deployUnsigned would actually use.
    function predictVaultUnsigned(Consent calldata consent) external view returns (address) {
        return _predict(ConsentLib.salt(_normaliseUnsigned(consent)));
    }

    function saltOf(Consent calldata consent) external pure returns (bytes32) {
        return ConsentLib.salt(consent);
    }

    function _predict(bytes32 salt) internal view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(deployer), salt, VAULT_INIT_CODE_HASH))))
        );
    }

    // -----------------------------------------------------------------------
    // EIP-712
    // -----------------------------------------------------------------------

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    function _buildDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("VenueVaultFactory"), keccak256("1"), block.chainid, address(this))
        );
    }

    /// The exact digest a dev's wallet must sign for `deploy`.
    function consentDigest(Consent calldata consent) external view returns (bytes32) {
        return _digest(ConsentLib.hashStruct(consent));
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    // -----------------------------------------------------------------------
    // Deployment
    // -----------------------------------------------------------------------

    /// Retrofit path: the dev signs EIP-712 consent, anyone may submit it.
    function deploy(Consent calldata consent, bytes calldata devSig) external returns (address) {
        Consent memory c = consent;
        _validate(c, true);
        SignatureLib.requireValid(c.devSigner, _digest(ConsentLib.hashStruct(c)), devSig);
        return _create(c, false);
    }

    /**
     * Self-serve path. Callable only by the dev signer itself, and it FORCES
     * operatorBps and budgetBpsMax to zero before computing the salt, so the
     * resulting vault is a pure dev-owned splitter with no operator economics
     * that no later action can introduce. Invariant I8 covers this vault shape.
     *
     * Normalisation happens before the salt is computed, so the deployed
     * address is predictVaultUnsigned(consent), not predictVault(consent).
     */
    function deployUnsigned(Consent calldata consent) external returns (address) {
        if (msg.sender != consent.devSigner) revert OnlyDevSigner();
        Consent memory c = _normaliseUnsigned(consent);
        _validate(c, false);
        return _create(c, true);
    }

    function _normaliseUnsigned(Consent calldata consent) internal pure returns (Consent memory c) {
        c = consent;
        c.operatorBps = 0;
        c.budgetBpsMax = 0;
    }

    function _create(Consent memory c, bool unsigned) internal returns (address vault) {
        bytes32 salt = ConsentLib.salt(c);
        address existing = vaultOf[salt];
        if (existing != address(0)) revert AlreadyDeployed(existing);

        vault = deployer.deployVault(c, salt);

        vaultOf[salt] = vault;
        consentHashOf[vault] = salt;
        isVault[vault] = true;
        _allVaults.push(vault);

        emit VaultDeployed(vault, c.devPayout, salt, c, unsigned);
    }

    function _validate(Consent memory c, bool requireTerms) internal view {
        if (c.devSigner == address(0) || c.devPayout == address(0)) revert ZeroAddress();
        if (c.adapter == address(0) || c.adapter.code.length == 0) revert AdapterNotContract();
        if (block.timestamp > c.expiryUnix) revert ConsentExpired(c.expiryUnix);
        if (c.operatorBps > MAX_OPERATOR_BPS) {
            revert OperatorBpsTooHigh(c.operatorBps, MAX_OPERATOR_BPS);
        }
        if (c.budgetBpsMax > MAX_BUDGET_BPS_MAX) {
            revert BudgetCeilingTooHigh(c.budgetBpsMax, MAX_BUDGET_BPS_MAX);
        }
        // The dev's share can never be squeezed to nothing, at any dial setting.
        if (uint256(c.operatorBps) + uint256(c.budgetBpsMax) >= BPS) revert DevShareWouldBeZero();
        if (c.referrerBps > BPS) revert ReferrerBpsTooHigh();
        if (c.referrer == address(0) && c.referrerBps != 0) revert ReferrerBpsWithoutReferrer();
        if (requireTerms && c.termsHash == bytes32(0)) revert TermsHashRequired();
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    function vaultCount() external view returns (uint256) {
        return _allVaults.length;
    }

    function vaultAt(uint256 i) external view returns (address) {
        return _allVaults[i];
    }
}
