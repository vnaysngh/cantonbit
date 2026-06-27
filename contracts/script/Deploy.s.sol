// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Script, console } from "forge-std/Script.sol";

import { HTLCEscrow } from "../src/HTLCEscrow.sol";

/**
 * Deploy HTLCEscrow to the origin chain (Base Sepolia devnet / Base mainnet).
 *
 * Env:
 *   PRIVATE_KEY or SOLVER_EVM_PK — deployer key
 *
 * Run:
 *   forge script script/Deploy.s.sol --rpc-url $RPC --broadcast
 *
 * Prints HTLC_ESCROW_ADDRESS and ESCROW_START_BLOCK for daemon env.
 */
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        HTLCEscrow escrow = new HTLCEscrow();
        vm.stopBroadcast();

        console.log("=== HTLC deployment ===");
        console.log("HTLC_ESCROW_ADDRESS =", address(escrow));
        console.log("ESCROW_START_BLOCK  =", block.number);
    }
}
