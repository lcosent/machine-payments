// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Escrow} from "../src/Escrow.sol";
import {CreditLine} from "../src/CreditLine.sol";

/// Deploys Escrow + CreditLine to whatever chain the broadcaster is pointed at
/// (Base Sepolia in CI/local) and optionally seeds the CreditLine with USDC
/// liquidity so the agent's draw_credit tool has something to borrow from.
///
/// Required env:
///   USDC_ADDRESS              ERC-20 address (Base Sepolia USDC = 0x036C...e7e)
///   DEPLOYER_PRIVATE_KEY      raw 0x-hex private key
///
/// Optional env:
///   CREDIT_LINE_LTV_BPS       default 5000 (50%)
///   CREDIT_LINE_APR_BPS       default 1000 (10% APR simple)
///   CREDIT_LINE_SEED_USDC6    USDC (6dp) to deposit into the pool at deploy
///                              time. Requires the deployer to hold + approve.
///                              Default 0 (skip seeding).
contract Deploy is Script {
    function run() external {
        address usdc = vm.envAddress("USDC_ADDRESS");
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);

        uint16 ltvBps = uint16(vm.envOr("CREDIT_LINE_LTV_BPS", uint256(5000)));
        uint16 aprBps = uint16(vm.envOr("CREDIT_LINE_APR_BPS", uint256(1000)));
        uint256 seedAmount = vm.envOr("CREDIT_LINE_SEED_USDC6", uint256(0));

        vm.startBroadcast(deployerPk);
        Escrow escrow = new Escrow(IERC20(usdc));
        CreditLine creditLine = new CreditLine(IERC20(usdc), ltvBps, aprBps, deployer);
        if (seedAmount > 0) {
            IERC20(usdc).approve(address(creditLine), seedAmount);
            creditLine.fundLiquidity(seedAmount);
        }
        vm.stopBroadcast();

        console2.log("ESCROW_ADDRESS=", address(escrow));
        console2.log("CREDIT_LINE_ADDRESS=", address(creditLine));
        console2.log("CREDIT_LINE_LTV_BPS=", ltvBps);
        console2.log("CREDIT_LINE_APR_BPS=", aprBps);
        console2.log("CREDIT_LINE_LIQUIDITY_USDC6=", seedAmount);
    }
}
