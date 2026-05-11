// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Escrow} from "../src/Escrow.sol";
import {CreditLine} from "../src/CreditLine.sol";

contract Deploy is Script {
    function run() external {
        address usdc = vm.envAddress("USDC_ADDRESS");
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);

        vm.startBroadcast(deployerPk);
        Escrow escrow = new Escrow(IERC20(usdc));
        CreditLine creditLine = new CreditLine(IERC20(usdc), 5000, 1000, deployer);
        vm.stopBroadcast();

        console2.log("ESCROW_ADDRESS=", address(escrow));
        console2.log("CREDIT_LINE_ADDRESS=", address(creditLine));
    }
}
