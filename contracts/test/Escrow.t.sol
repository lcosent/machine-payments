// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Escrow} from "../src/Escrow.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract EscrowTest is Test {
    Escrow escrow;
    MockUSDC usdc;
    address payer = address(0xA11CE);
    uint256 providerPk = 0xB0B;
    address provider;

    function setUp() public {
        usdc = new MockUSDC();
        escrow = new Escrow(usdc);
        provider = vm.addr(providerPk);
        usdc.mint(payer, 1_000_000e6);
        vm.prank(payer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _sigOver(uint256 jobId, uint96 finalAmount) internal view returns (bytes memory) {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encodePacked(address(escrow), jobId, finalAmount))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(providerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_open_settle_releasesAndRefunds() public {
        vm.prank(payer);
        uint256 jobId = escrow.openJob(
            provider, 100e6, uint64(block.timestamp + 1 hours), keccak256("intent-1"), bytes32("task-1")
        );

        bytes memory sig = _sigOver(jobId, 78e6);
        escrow.settle(jobId, 78e6, sig);

        assertEq(usdc.balanceOf(provider), 78e6);
        assertEq(usdc.balanceOf(payer), 1_000_000e6 - 100e6 + 22e6);
    }

    function test_settle_rejectsFinalAboveAmount() public {
        vm.prank(payer);
        uint256 jobId = escrow.openJob(
            provider, 100e6, uint64(block.timestamp + 1 hours), keccak256("intent-2"), bytes32("task-2")
        );
        bytes memory sig = _sigOver(jobId, 101e6);
        vm.expectRevert(Escrow.FinalExceedsAmount.selector);
        escrow.settle(jobId, 101e6, sig);
    }

    function test_settle_rejectsWrongSigner() public {
        vm.prank(payer);
        uint256 jobId = escrow.openJob(
            provider, 100e6, uint64(block.timestamp + 1 hours), keccak256("intent-3"), bytes32("task-3")
        );
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encodePacked(address(escrow), jobId, uint96(50e6)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xDEADBEEF, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.expectRevert(Escrow.BadProviderSignature.selector);
        escrow.settle(jobId, 50e6, sig);
    }

    function test_intentReplayRejected() public {
        vm.prank(payer);
        escrow.openJob(
            provider, 100e6, uint64(block.timestamp + 1 hours), keccak256("intent-r"), bytes32("task-r")
        );
        vm.prank(payer);
        vm.expectRevert(Escrow.UsedIntent.selector);
        escrow.openJob(
            provider, 100e6, uint64(block.timestamp + 1 hours), keccak256("intent-r"), bytes32("task-r2")
        );
    }

    function test_refundAfterDeadline() public {
        vm.prank(payer);
        uint256 jobId = escrow.openJob(
            provider, 100e6, uint64(block.timestamp + 1 hours), keccak256("intent-4"), bytes32("task-4")
        );
        vm.warp(block.timestamp + 2 hours);
        escrow.refund(jobId);
        assertEq(usdc.balanceOf(payer), 1_000_000e6);
    }

    function test_refundBeforeDeadlineReverts() public {
        vm.prank(payer);
        uint256 jobId = escrow.openJob(
            provider, 100e6, uint64(block.timestamp + 1 hours), keccak256("intent-5"), bytes32("task-5")
        );
        vm.expectRevert(Escrow.NotYetExpired.selector);
        escrow.refund(jobId);
    }
}
