// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Registry, Tier, Verdict} from "../../src/Registry.sol";
// forge-std's StdCheats declares an inherited `struct ReceiptLog`, which
// shadows the contract name inside any Test subclass. Alias it here rather than
// rename the production contract to work around a test-library collision.
import {ReceiptLog as ReceiptLogContract, ReceiptKind, ReceiptRecord} from "../../src/ReceiptLog.sol";

contract LedgersTest is Test {
    Registry internal registry;
    ReceiptLogContract internal receipts;

    address internal operator = makeAddr("operator");
    address internal vaultA = makeAddr("vaultA");
    address internal token = makeAddr("token");

    function setUp() public {
        registry = new Registry(operator);
        receipts = new ReceiptLogContract(operator);
    }

    // -----------------------------------------------------------------------
    // "Affects service and evidence, never funds" -- structurally.
    // -----------------------------------------------------------------------

    function test_ledgersCannotReceiveValue() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(registry).call{value: 1 wei}("");
        assertFalse(ok, "Registry must have no payable surface");
        (ok,) = address(receipts).call{value: 1 wei}("");
        assertFalse(ok, "ReceiptLog must have no payable surface");
    }

    function test_ledgersExposeNoTokenMovingFunctions() public view {
        bytes4[4] memory forbidden = [
            bytes4(keccak256("transfer(address,uint256)")),
            bytes4(keccak256("approve(address,uint256)")),
            bytes4(keccak256("withdraw(address,uint256)")),
            bytes4(keccak256("execute(address,bytes)"))
        ];
        for (uint256 i; i < forbidden.length; ++i) {
            (bool ok,) = address(registry).staticcall(abi.encodeWithSelector(forbidden[i]));
            assertFalse(ok);
            (ok,) = address(receipts).staticcall(abi.encodeWithSelector(forbidden[i]));
            assertFalse(ok);
        }
    }

    // -----------------------------------------------------------------------
    // Registry
    // -----------------------------------------------------------------------

    function test_registryIsAppendOnlyAndSupersedesRatherThanEdits() public {
        vm.startPrank(operator);
        registry.append(vaultA, token, keccak256("consent"), Tier.T1, Verdict.CLEAR, true, keccak256("e1"), "first");
        registry.append(vaultA, token, keccak256("consent"), Tier.T2, Verdict.CLEAR, true, keccak256("e2"), "promoted");
        vm.stopPrank();

        assertEq(registry.recordCount(), 2);
        assertEq(uint256(registry.latest(vaultA).tier), uint256(Tier.T2));

        // The superseded record is still there, unedited.
        assertEq(uint256(registry.recordAt(0).tier), uint256(Tier.T1));
        assertEq(registry.recordAt(0).evidenceHash, keccak256("e1"));
        assertEq(registry.recordIdsOf(vaultA).length, 2);
    }

    /// Fail closed: a BLOCKED verdict can never carry paid-media rights, even
    /// if the caller passes true.
    function test_blockedVerdictAlwaysDeniesPaidMedia() public {
        vm.prank(operator);
        registry.append(vaultA, token, bytes32(0), Tier.T3, Verdict.BLOCKED, true, bytes32(0), "blocked");
        assertFalse(registry.latest(vaultA).paidMediaPermitted);
    }

    function test_registryIsOperatorWritten() public {
        vm.expectRevert(Registry.OnlyOperator.selector);
        registry.append(vaultA, token, bytes32(0), Tier.T0, Verdict.CLEAR, false, bytes32(0), "");
    }

    function test_registryRevertsForUnknownVault() public {
        vm.expectRevert(Registry.NoRecord.selector);
        registry.latest(makeAddr("unknown"));
    }

    // -----------------------------------------------------------------------
    // ReceiptLog
    // -----------------------------------------------------------------------

    function _receipt(bytes32 id, uint64 cents) internal view returns (ReceiptRecord memory) {
        return ReceiptRecord({
            vault: vaultA,
            receiptId: id,
            disbursementId: keccak256("d1"),
            kind: ReceiptKind.PROCUREMENT,
            amountUsdCents: cents,
            occurredAtUnix: uint64(block.timestamp),
            publishAfterUnix: uint64(block.timestamp + 72 hours),
            payloadHash: keccak256("payload"),
            evidenceHash: keccak256("evidence")
        });
    }

    function test_receiptsAreWriteOnce() public {
        vm.startPrank(operator);
        receipts.post(_receipt(keccak256("r1"), 29_900));

        vm.expectRevert(abi.encodeWithSelector(ReceiptLogContract.DuplicateReceipt.selector, keccak256("r1")));
        receipts.post(_receipt(keccak256("r1"), 1));
        vm.stopPrank();

        assertEq(receipts.receiptCount(), 1);
        assertEq(receipts.receiptById(keccak256("r1")).amountUsdCents, 29_900);
    }

    /// A KOL post is verified at T+24h and again at T+7d; each check appends.
    function test_predicateResultsAccumulateOnOneReceipt() public {
        vm.startPrank(operator);
        receipts.post(_receipt(keccak256("r1"), 50_000));
        receipts.postPredicate(keccak256("r1"), 24 hours, true, keccak256("t24"));
        receipts.postPredicate(keccak256("r1"), 7 days, false, keccak256("t7d"));
        vm.stopPrank();

        uint256[] memory ids = receipts.predicateIndicesOf(keccak256("r1"));
        assertEq(ids.length, 2);
        assertTrue(receipts.predicateAt(ids[0]).passed);
        assertFalse(receipts.predicateAt(ids[1]).passed, "a later failure is recorded, not erased");
    }

    function test_predicateRequiresAKnownReceipt() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ReceiptLogContract.UnknownReceipt.selector, keccak256("missing")));
        receipts.postPredicate(keccak256("missing"), 0, true, bytes32(0));
    }

    function test_receiptsAreOperatorWritten() public {
        vm.expectRevert(ReceiptLogContract.OnlyOperator.selector);
        receipts.post(_receipt(keccak256("r9"), 1));
    }

    /// The 72-hour lag is data the publisher enforces; it must round-trip.
    function test_publishLagIsPreserved() public {
        vm.prank(operator);
        receipts.post(_receipt(keccak256("r1"), 1));
        ReceiptRecord memory r = receipts.receiptById(keccak256("r1"));
        assertEq(r.publishAfterUnix - r.occurredAtUnix, 72 hours);
    }
}
