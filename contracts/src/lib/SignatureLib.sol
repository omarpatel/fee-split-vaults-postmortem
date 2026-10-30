// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/**
 * ECDSA recovery with an ERC-1271 fallback, vendored rather than imported.
 *
 * The 1271 branch is not a convenience. Devs who hold a token's creator fee
 * recipiency through a Safe or another smart account would otherwise be unable
 * to sign consent at all, and the only workaround would be an operator-side
 * "we'll deploy it for you" path -- which is exactly the operator-key-touches-
 * the-dev-leg shape this system exists to avoid.
 */
library SignatureLib {
    error InvalidSignatureLength();
    error MalleableSignature();
    error InvalidSigner();

    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;

    /// secp256k1n / 2. Signatures above this are the malleable twin of a valid one.
    bytes32 internal constant HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /**
     * Reverts unless `signature` authorizes `digest` on behalf of `expected`.
     *
     * Fail-closed in three ways: a wrong-length signature reverts rather than
     * recovering garbage, a high-s signature reverts rather than being silently
     * normalized, and a contract signer that returns anything but the magic
     * value reverts rather than being treated as a soft failure.
     *
     * KNOWN AND ACCEPTED: EIP-7702. The branch below is taken on
     * `code.length > 0`, so an EOA that later carries a 7702 delegation stops
     * verifying by ecrecover and starts verifying by staticcall into whatever it
     * has delegated to. For VaultFactory.deploy that is evaluated once, at
     * deployment, so the blast radius is a single transaction. For
     * CoinVault.bindWithSig - whose signature has no nonce and only a `deadline`
     * - it means the authentication mechanism for a long-lived operator-signed
     * bind can change out from under the protocol.
     *
     * We are NOT deciding the mode from the consent instead, and the reason is
     * worth stating: `devSignerIsContract` would have to join the Consent
     * struct, which is the EIP-712 type string, which is inside the CREATE2 salt
     * preimage - so adding it changes every vault address ever predicted, and
     * the string is pinned character-for-character against apps/api by
     * tools/check-coherence.mjs. That is a protocol migration, not a hardening
     * patch, and chain 4663's EVM revision is unpublished (foundry.toml pins
     * `paris` precisely because of that), so whether 7702 is even live there is
     * unknown. Establish the chain's 7702 status first; if it is live, this is
     * the change to make, and it must be made before any mainnet deployment
     * whose addresses matter.
     */
    function requireValid(address expected, bytes32 digest, bytes calldata signature) internal view {
        if (expected.code.length > 0) {
            (bool ok, bytes memory ret) = expected.staticcall(abi.encodeWithSelector(ERC1271_MAGIC, digest, signature));
            if (!ok || ret.length < 32 || abi.decode(ret, (bytes4)) != ERC1271_MAGIC) {
                revert InvalidSigner();
            }
            return;
        }

        if (signature.length != 65) revert InvalidSignatureLength();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > uint256(HALF_ORDER)) revert MalleableSignature();
        if (v != 27 && v != 28) revert InvalidSigner();

        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0) || recovered != expected) revert InvalidSigner();
    }
}
