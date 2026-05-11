// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {CreditLine} from "../src/CreditLine.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract CreditLineTest is Test {
    CreditLine line;
    MockUSDC usdc;
    address owner = address(0x0WNER);
    address agent = address(0xA9E47);

    function setUp() public {
        usdc = new MockUSDC();
        line = new CreditLine(usdc, 5000, 1000, owner); // 50% LTV, 10% APR

        usdc.mint(owner, 1_000_000e6);
        usdc.mint(agent, 1_000_000e6);

        vm.prank(owner);
        usdc.approve(address(line), type(uint256).max);
        vm.prank(owner);
        line.fundLiquidity(500_000e6);

        vm.prank(agent);
        usdc.approve(address(line), type(uint256).max);
    }

    function test_borrowWithinLtv_succeeds() public {
        vm.prank(agent);
        line.depositCollateral(100e6);
        vm.prank(agent);
        line.borrow(40e6);
        (uint128 collateral, uint128 principal,) = line.accounts(agent);
        assertEq(collateral, 100e6);
        assertEq(principal, 40e6);
        assertEq(usdc.balanceOf(agent), 1_000_000e6 - 100e6 + 40e6);
    }

    function test_borrowExceedingLtv_reverts() public {
        vm.prank(agent);
        line.depositCollateral(100e6);
        vm.prank(agent);
        vm.expectRevert(CreditLine.ExceedsLtv.selector);
        line.borrow(60e6);
    }

    function test_repay_reducesPrincipal() public {
        vm.prank(agent);
        line.depositCollateral(100e6);
        vm.prank(agent);
        line.borrow(50e6);
        vm.prank(agent);
        line.repay(30e6);
        (, uint128 principal,) = line.accounts(agent);
        assertEq(principal, 20e6);
    }

    function test_interestAccrues_overOneYear() public {
        vm.prank(agent);
        line.depositCollateral(100e6);
        vm.prank(agent);
        line.borrow(50e6);

        vm.warp(block.timestamp + 365 days);

        // Trigger accrual via repay(1)
        vm.prank(agent);
        line.repay(1);
        (, uint128 principal,) = line.accounts(agent);
        // expected: 50e6 * 10% = 5e6 interest; minus 1 wei repaid
        assertApproxEqAbs(principal, 50e6 + 5e6 - 1, 10);
    }

    function test_liquidate_unhealthyPosition() public {
        vm.prank(agent);
        line.depositCollateral(100e6);
        vm.prank(agent);
        line.borrow(50e6);

        // Tighten LTV so position becomes unhealthy: 40% would put 50/100=50% > 40%
        vm.prank(owner);
        line.setLtv(4000);

        address liquidator = address(0x114114);
        usdc.mint(liquidator, 1_000_000e6);
        vm.prank(liquidator);
        usdc.approve(address(line), type(uint256).max);

        vm.prank(liquidator);
        line.liquidate(agent);

        (uint128 collateral, uint128 principal,) = line.accounts(agent);
        assertEq(collateral, 0);
        assertEq(principal, 0);
    }

    function test_liquidate_healthyReverts() public {
        vm.prank(agent);
        line.depositCollateral(100e6);
        vm.prank(agent);
        line.borrow(40e6);

        address liquidator = address(0x114114);
        usdc.mint(liquidator, 1_000_000e6);
        vm.prank(liquidator);
        usdc.approve(address(line), type(uint256).max);

        vm.prank(liquidator);
        vm.expectRevert(CreditLine.HealthyPosition.selector);
        line.liquidate(agent);
    }
}
