// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Script, console } from "forge-std/Script.sol";

import { InputSettlerEscrow } from "oif-contracts/src/input/escrow/InputSettlerEscrow.sol";
import { OranjAttestorOracle } from "../src/OranjAttestorOracle.sol";

/**
 * Deploys the swap's on-chain pieces to the origin chain (Base Sepolia for v1):
 *   - InputSettlerEscrow (audited OIF contract, unchanged)
 *   - OranjAttestorOracle (owner = ADMIN, attestor = AGENT)
 *
 * Permit2 is already deployed canonically at 0x000000000022D473030F116dDEE9F6B43aC78BA3
 * on every chain (the escrow references it as a constant), so we don't deploy it.
 *
 * Env:
 *   PRIVATE_KEY        deployer key
 *   ORACLE_OWNER       admin that can rotate the attestor (cold key)
 *   ORACLE_ATTESTOR    the agent address that will call attest() (hot key)
 *
 * Run:
 *   forge script script/Deploy.s.sol --rpc-url $RPC --broadcast
 *
 * Prints ESCROW_ADDRESS / ORACLE_ADDRESS / ESCROW_START_BLOCK for the solver env.
 */
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address owner = vm.envAddress("ORACLE_OWNER");
        address attestor = vm.envAddress("ORACLE_ATTESTOR");

        vm.startBroadcast(pk);

        InputSettlerEscrow escrow = new InputSettlerEscrow();
        OranjAttestorOracle oracle = new OranjAttestorOracle(owner, attestor);

        vm.stopBroadcast();

        console.log("=== Swap deployment ===");
        console.log("ESCROW_ADDRESS  =", address(escrow));
        console.log("ORACLE_ADDRESS  =", address(oracle));
        console.log("ESCROW_START_BLOCK =", block.number);
        console.log("oracle.owner    =", owner);
        console.log("oracle.attestor =", attestor);
    }
}
