// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/**
 * The dev's signed agreement. This struct is simultaneously:
 *   1. the EIP-712 payload the dev signs, and
 *   2. the CREATE2 salt preimage.
 *
 * Because (2) covers EVERY economic term, a vault at a given address can only
 * ever have had one set of rates. Repricing an existing customer is not merely
 * forbidden, it is unrepresentable: a different operatorBps is a different salt
 * is a different address, and the address that already exists cannot be
 * redeployed. There is no admin function to change a rate because there is no
 * address at which a changed rate could live.
 *
 * Field order is fixed and mirrored by `Consent` in packages/core/src/types.ts.
 * Reordering fields silently changes every vault address ever predicted.
 */
struct Consent {
    /// Signer of the EIP-712 approval. May be an EOA or an ERC-1271 contract wallet.
    address devSigner;
    /// Sole withdrawer of the dev leg. No operator key path reaches this address.
    address devPayout;
    /// The launch token. Zero on the greenfield path, where bind() supplies it.
    address token;
    /// keccak of the versioned MSA + content policy the dev agreed to.
    bytes32 termsHash;
    /// Operator take of credited fees, in bps. Immutable. In the salt preimage.
    uint16 operatorBps;
    /// Ceiling on the dev's procurement dial, in bps. Immutable. In the salt preimage.
    uint16 budgetBpsMax;
    /// Pinned Venue integration shim at signing time. In the salt preimage.
    address adapter;
    /// Referral counterparty, paid out of the operator's own slice.
    address referrer;
    /// Referrer's share OF operatorBps, not of gross. Never dilutes the dev.
    uint16 referrerBps;
    /// Signature validity deadline. Deployment after this is refused.
    uint64 expiryUnix;
    /// Uniqueness. Two identical term sets can still be two distinct vaults.
    bytes32 nonce;
}

library ConsentLib {
    /// EIP-712 struct hash type string. Field order must match `Consent` exactly.
    bytes32 internal constant CONSENT_TYPEHASH = keccak256(
        "Consent(address devSigner,address devPayout,address token,bytes32 termsHash,"
        "uint16 operatorBps,uint16 budgetBpsMax,address adapter,address referrer,"
        "uint16 referrerBps,uint64 expiryUnix,bytes32 nonce)"
    );

    uint16 internal constant BPS_DENOMINATOR = 10_000;

    /**
     * The CREATE2 salt. Note this is `abi.encode`, not `abi.encodePacked`:
     * packed encoding of a struct with two adjacent uint16 fields would be
     * ambiguous, and ambiguity in a salt preimage is a collision.
     */
    function salt(Consent memory c) internal pure returns (bytes32) {
        return keccak256(abi.encode(c));
    }

    /// EIP-712 hashStruct(Consent). Distinct from salt() by the typehash prefix.
    function hashStruct(Consent memory c) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CONSENT_TYPEHASH,
                c.devSigner,
                c.devPayout,
                c.token,
                c.termsHash,
                c.operatorBps,
                c.budgetBpsMax,
                c.adapter,
                c.referrer,
                c.referrerBps,
                c.expiryUnix,
                c.nonce
            )
        );
    }
}
