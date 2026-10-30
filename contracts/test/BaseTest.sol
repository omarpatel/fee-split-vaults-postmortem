// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {VaultFactory} from "../src/VaultFactory.sol";
import {CoinVault} from "../src/CoinVault.sol";
import {VenueAdapter} from "../src/VenueAdapter.sol";
import {Consent, ConsentLib} from "../src/lib/ConsentLib.sol";
import {VaultState, Legs} from "../src/interfaces/ICoinVault.sol";

import {MockERC20, MockWETH, MockVenueFeeEscrow, MockCreatorFeeRegistry} from "./mocks/Mocks.sol";

/**
 * Shared fixture. operatorBps 1000 and budgetBpsMax 4000 are ONE vault's frozen
 * parameters, not the published defaults: the rate lives in the CREATE2 salt, so
 * the contracts must be right at whatever rate a given vault was signed at, and
 * a fixture pinned to today's TERMS.operatorBps would only ever prove the
 * arithmetic for vaults signed today. (config/protocol.ts published 1000 bps
 * when this fixture was written and publishes 500 now; both are real on-chain
 * rates for as long as the vaults signed at them exist.) referrerBps 2000 means
 * the referrer takes 20% OF the operator's fee, i.e. 2% of gross at this vault's
 * rate -- never a bp out of the client's share.
 */
abstract contract BaseTest is Test {
    VaultFactory internal factory;
    VenueAdapter internal adapter;
    MockVenueFeeEscrow internal escrow;
    MockCreatorFeeRegistry internal feeRegistry;

    MockERC20 internal usdg;
    MockWETH internal weth;
    MockERC20 internal launch;

    address internal operator = makeAddr("operatorTreasury");
    address internal referrer = makeAddr("referrer");
    /// Never legitimately paid by anything. Invariant I4's canary.
    address internal thirdParty = makeAddr("thirdPartyVendor");

    uint256 internal devKey = 0xA11CE;
    address internal devSigner;
    address internal devPayout = makeAddr("devPayout");

    CoinVault internal vault;
    Consent internal consent;

    uint16 internal constant OPERATOR_BPS = 1_000;
    uint16 internal constant BUDGET_BPS_MAX = 4_000;
    uint16 internal constant REFERRER_BPS = 2_000;

    function setUp() public virtual {
        devSigner = vm.addr(devKey);

        escrow = new MockVenueFeeEscrow();
        feeRegistry = new MockCreatorFeeRegistry();
        adapter = new VenueAdapter("venue-v2/test", address(escrow), address(feeRegistry));

        usdg = new MockERC20("Quote USD", "USDG", 6);
        weth = new MockWETH();
        launch = new MockERC20("Launch Coin", "MEME", 18);

        factory = new VaultFactory(operator);

        consent = _baseConsent();
        vault = CoinVault(payable(_deploySigned(consent)));

        // The vault is the coin's creator fee recipient, as on the retrofit path.
        feeRegistry.setRecipient(address(launch), address(vault));

        vm.label(address(vault), "vault");
        vm.label(address(usdg), "USDG");
        vm.label(address(weth), "WETH");
        vm.label(address(launch), "MEME");
    }

    function _baseConsent() internal view returns (Consent memory c) {
        c = Consent({
            devSigner: devSigner,
            devPayout: devPayout,
            token: address(launch),
            termsHash: keccak256("MSA v1"),
            operatorBps: OPERATOR_BPS,
            budgetBpsMax: BUDGET_BPS_MAX,
            adapter: address(adapter),
            referrer: referrer,
            referrerBps: REFERRER_BPS,
            expiryUnix: uint64(block.timestamp + 30 days),
            nonce: keccak256("nonce-0")
        });
    }

    function _sign(Consent memory c) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(devKey, factory.consentDigest(c));
        return abi.encodePacked(r, s, v);
    }

    function _deploySigned(Consent memory c) internal returns (address) {
        return factory.deploy(c, _sign(c));
    }

    // -----------------------------------------------------------------------
    // State helpers
    // -----------------------------------------------------------------------

    function _bind() internal {
        vm.prank(operator);
        vault.bind(address(launch));
    }

    function _activate() internal {
        _bind();
        vm.prank(devPayout);
        vault.acceptService();
        vm.prank(operator);
        vault.activate();
    }

    function _setDial(uint16 bps) internal {
        vm.prank(devPayout);
        vault.setDial(bps);
    }

    /// Credit the escrow as the Venue hook would, then let the vault claim it.
    function _accrue(address asset, uint256 amount) internal {
        MockERC20(asset).mint(address(escrow), amount);
        escrow.creditToken(address(vault), asset, amount);
        vault.claimToken(asset, type(uint256).max);
    }

    /// A direct transfer to the vault, as an airdrop or a hook payout would be.
    function _drop(address asset, uint256 amount) internal {
        MockERC20(asset).mint(address(vault), amount);
        vault.settle(asset);
    }

    function _legs(address asset) internal view returns (Legs memory) {
        return vault.legOf(asset);
    }

    function _accounted(address asset) internal view returns (uint256) {
        Legs memory L = vault.legOf(asset);
        return L.dev + L.budget + L.operator_ + L.referrer;
    }
}
