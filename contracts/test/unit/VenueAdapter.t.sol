// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VenueAdapter} from "../../src/VenueAdapter.sol";
import {MockVenueFeeEscrow, MockCreatorFeeRegistry} from "../mocks/Mocks.sol";

contract VenueAdapterTest is Test {
    VenueAdapter internal adapter;
    MockVenueFeeEscrow internal escrow;
    MockCreatorFeeRegistry internal registry;

    function setUp() public {
        escrow = new MockVenueFeeEscrow();
        registry = new MockCreatorFeeRegistry();
        adapter = new VenueAdapter("venue-v2/2026-09", address(escrow), address(registry));
    }

    /**
     * The central claim about this contract: it has a FIXED SELECTOR SET and no
     * generic call surface. If any of these ever resolve, the adapter has
     * stopped being a shim and become a second key on every vault.
     */
    function test_adapterHasNoGenericCallSurface() public view {
        bytes4[7] memory forbidden = [
            bytes4(keccak256("execute(address,bytes)")),
            bytes4(keccak256("call(address,bytes)")),
            bytes4(keccak256("multicall(bytes[])")),
            bytes4(keccak256("delegatecall(address,bytes)")),
            bytes4(keccak256("owner()")),
            bytes4(keccak256("setEscrow(address)")),
            bytes4(keccak256("upgradeTo(address)"))
        ];
        for (uint256 i; i < forbidden.length; ++i) {
            (bool ok,) = address(adapter).staticcall(abi.encodeWithSelector(forbidden[i]));
            assertFalse(ok, "adapter must expose no generic or admin entry point");
        }
    }

    /// It also must not be able to receive value or hold anything.
    function test_adapterIsNotPayable() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(adapter).call{value: 1 wei}("");
        assertFalse(ok, "adapter must have no payable surface");
    }

    function test_pinnedSelectorSetIsExactlyThree() public view {
        assertTrue(adapter.isPinnedSelector(adapter.SEL_CLAIM()));
        assertTrue(adapter.isPinnedSelector(adapter.SEL_CLAIM_TOKEN()));
        assertTrue(adapter.isPinnedSelector(adapter.SEL_TRANSFER_RECIPIENT()));

        // Anything else, including the ERC-20 primitives the vault also bans.
        assertFalse(adapter.isPinnedSelector(bytes4(keccak256("approve(address,uint256)"))));
        assertFalse(adapter.isPinnedSelector(bytes4(keccak256("transfer(address,uint256)"))));
        assertFalse(adapter.isPinnedSelector(bytes4(keccak256("withdraw(uint256)"))));
        assertFalse(adapter.isPinnedSelector(bytes4(0)));
    }

    /// Selectors are derived from named signatures, not magic literals.
    function test_selectorsMatchTheirDeclaredSignatures() public view {
        assertEq(adapter.SEL_CLAIM(), bytes4(keccak256("claim(uint256)")));
        assertEq(adapter.SEL_CLAIM_TOKEN(), bytes4(keccak256("claimToken(address,uint256)")));
        assertEq(adapter.SEL_TRANSFER_RECIPIENT(), bytes4(keccak256("transferCreatorFeeRecipient(address,address)")));
    }

    /// Every builder targets a constructor immutable, never a caller argument.
    function test_buildersOnlyEverTargetPinnedAddresses() public view {
        (address t1, bytes memory d1) = adapter.claimNativeCall(123);
        assertEq(t1, address(escrow));
        assertEq(d1, abi.encodeWithSignature("claim(uint256)", uint256(123)));

        (address t2, bytes memory d2) = adapter.claimTokenCall(address(0xBEEF), 456);
        assertEq(t2, address(escrow));
        assertEq(d2, abi.encodeWithSignature("claimToken(address,uint256)", address(0xBEEF), uint256(456)));

        (address t3, bytes memory d3) = adapter.transferRecipientCall(address(1), address(2));
        assertEq(t3, address(registry));
        assertEq(d3, abi.encodeWithSignature("transferCreatorFeeRecipient(address,address)", address(1), address(2)));
    }

    function test_constructorRejectsNonContracts() public {
        vm.expectRevert(VenueAdapter.NotAContract.selector);
        new VenueAdapter("bad", makeAddr("eoa"), address(registry));

        vm.expectRevert(VenueAdapter.ZeroAddress.selector);
        new VenueAdapter("bad", address(0), address(registry));
    }
}
