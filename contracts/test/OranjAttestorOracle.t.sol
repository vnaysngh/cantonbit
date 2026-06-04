// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";

import { OranjAttestorOracle } from "../src/OranjAttestorOracle.sol";

/// @notice Unit tests for the oracle's own logic: access control + the
/// attest -> isProven / efficientRequireProven roundtrip. The full escrow
/// release path (open -> attest -> finalise) is covered separately in Task 4.
contract OranjAttestorOracleTest is Test {
    OranjAttestorOracle oracle;

    address owner = address(0xA11CE);
    address attestor = address(0xBEEF);
    address stranger = address(0xDEAD);

    // A representative proof tuple.
    uint256 constant CHAIN = 999; // stand-in for the Canton chain id
    bytes32 constant ORACLE_ID = bytes32(uint256(0x0123));
    bytes32 constant APP_ID = bytes32(uint256(0x0456)); // == output.settler
    bytes32 constant DATA_HASH = keccak256("fill-description");

    function setUp() public {
        oracle = new OranjAttestorOracle(owner, attestor);
    }

    function test_constructor_setsOwnerAndAttestor() public view {
        assertEq(oracle.owner(), owner);
        assertEq(oracle.attestor(), attestor);
    }

    function test_attest_provesTheExactSlot() public {
        assertFalse(oracle.isProven(CHAIN, ORACLE_ID, APP_ID, DATA_HASH));

        vm.prank(attestor);
        oracle.attest(CHAIN, ORACLE_ID, APP_ID, DATA_HASH);

        assertTrue(oracle.isProven(CHAIN, ORACLE_ID, APP_ID, DATA_HASH));
    }

    function test_efficientRequireProven_passesAfterAttest() public {
        vm.prank(attestor);
        oracle.attest(CHAIN, ORACLE_ID, APP_ID, DATA_HASH);

        // Build the 128-byte proof series the InputSettler would pass.
        bytes memory series = abi.encodePacked(CHAIN, ORACLE_ID, APP_ID, DATA_HASH);
        // Should not revert.
        oracle.efficientRequireProven(series);
    }

    function test_efficientRequireProven_revertsWhenUnproven() public {
        bytes memory series = abi.encodePacked(CHAIN, ORACLE_ID, APP_ID, DATA_HASH);
        vm.expectRevert(); // NotProven
        oracle.efficientRequireProven(series);
    }

    function test_attest_onlyAttestor() public {
        vm.prank(stranger);
        vm.expectRevert(OranjAttestorOracle.NotAttestor.selector);
        oracle.attest(CHAIN, ORACLE_ID, APP_ID, DATA_HASH);
    }

    function test_attest_isIdempotent() public {
        vm.startPrank(attestor);
        oracle.attest(CHAIN, ORACLE_ID, APP_ID, DATA_HASH);
        oracle.attest(CHAIN, ORACLE_ID, APP_ID, DATA_HASH); // no revert
        vm.stopPrank();
        assertTrue(oracle.isProven(CHAIN, ORACLE_ID, APP_ID, DATA_HASH));
    }

    function test_setAttestor_rotatesAndGatesByOwner() public {
        address newAttestor = address(0xCAFE);

        // stranger cannot rotate
        vm.prank(stranger);
        vm.expectRevert();
        oracle.setAttestor(newAttestor);

        // owner can rotate
        vm.prank(owner);
        oracle.setAttestor(newAttestor);
        assertEq(oracle.attestor(), newAttestor);

        // old attestor no longer authorized
        vm.prank(attestor);
        vm.expectRevert(OranjAttestorOracle.NotAttestor.selector);
        oracle.attest(CHAIN, ORACLE_ID, APP_ID, DATA_HASH);

        // new attestor is
        vm.prank(newAttestor);
        oracle.attest(CHAIN, ORACLE_ID, APP_ID, DATA_HASH);
        assertTrue(oracle.isProven(CHAIN, ORACLE_ID, APP_ID, DATA_HASH));
    }

    function test_setAttestor_rejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(OranjAttestorOracle.ZeroAttestor.selector);
        oracle.setAttestor(address(0));
    }

    function test_attestBatch_provesAll() public {
        uint256[] memory chains = new uint256[](2);
        bytes32[] memory oracles = new bytes32[](2);
        bytes32[] memory apps = new bytes32[](2);
        bytes32[] memory hashes = new bytes32[](2);
        chains[0] = CHAIN;
        oracles[0] = ORACLE_ID;
        apps[0] = APP_ID;
        hashes[0] = DATA_HASH;
        chains[1] = CHAIN;
        oracles[1] = ORACLE_ID;
        apps[1] = APP_ID;
        hashes[1] = keccak256("second-fill");

        vm.prank(attestor);
        oracle.attestBatch(chains, oracles, apps, hashes);

        assertTrue(oracle.isProven(CHAIN, ORACLE_ID, APP_ID, hashes[0]));
        assertTrue(oracle.isProven(CHAIN, ORACLE_ID, APP_ID, hashes[1]));
    }
}
