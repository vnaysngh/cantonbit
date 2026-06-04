// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { ERC20 } from "openzeppelin/token/ERC20/ERC20.sol";

import { InputSettlerEscrow } from "oif-contracts/src/input/escrow/InputSettlerEscrow.sol";
import { InputSettlerBase } from "oif-contracts/src/input/InputSettlerBase.sol";
import { MandateOutput } from "oif-contracts/src/input/types/MandateOutputType.sol";
import { StandardOrder } from "oif-contracts/src/input/types/StandardOrderType.sol";
import { MandateOutputEncodingLib } from "oif-contracts/src/libs/MandateOutputEncodingLib.sol";

import { OranjAttestorOracle } from "../src/OranjAttestorOracle.sol";

contract MockWBTC is ERC20 {
    constructor() ERC20("Mock WBTC", "WBTC") {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

/**
 * @notice Proves the entire WBTC-side trust loop in isolation (no Canton, no
 * off-chain solver): open() an order into InputSettlerEscrow, attest the fill on
 * OranjAttestorOracle, then finalise() and assert the locked WBTC moves to the
 * solver. Also asserts the negative: finalise() reverts before attestation.
 *
 * This binds Task 3 (oracle) + Task 4 (encoding) at the contract level using the
 * real audited escrow.
 */
contract EscrowReleasePathTest is Test {
    InputSettlerEscrow escrow;
    OranjAttestorOracle oracle;
    MockWBTC wbtc;

    // The solver is also the order opener here (it deposits its own WBTC to lock
    // for the test; in production the USER deposits via openFor/permit2).
    uint256 solverPk;
    address solver;
    address attestor = address(0xA77E5709);

    // Canton-side identifiers (chosen by us; must match between order + attest).
    uint256 constant CANTON_CHAIN_ID = 9_000_000; // stand-in id we assign to Canton
    bytes32 cantonSettlerId; // == output.settler

    uint256 constant LOCK_AMOUNT = 5e8; // 5 WBTC (8dp) for the test

    function setUp() public {
        solverPk = uint256(keccak256("solver"));
        solver = vm.addr(solverPk);

        escrow = new InputSettlerEscrow();
        oracle = new OranjAttestorOracle(address(this), attestor);
        wbtc = new MockWBTC();

        // An arbitrary but fixed identifier we use as the Canton "settler".
        cantonSettlerId = bytes32(uint256(uint160(address(0xCA470))));

        // Fund the solver and let the escrow pull on open().
        wbtc.mint(solver, LOCK_AMOUNT);
        vm.prank(solver);
        wbtc.approve(address(escrow), type(uint256).max);
    }

    // --- helpers ---

    function _toId(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    /// @dev Build the order whose input is LOCK_AMOUNT WBTC and whose single
    /// output points at OUR oracle + canton settler id.
    function _buildOrder() internal view returns (StandardOrder memory order) {
        MandateOutput[] memory outs = new MandateOutput[](1);
        outs[0] = MandateOutput({
            oracle: _toId(address(oracle)), // output.oracle == our oracle
            settler: cantonSettlerId, // output.settler == canton settler id
            chainId: CANTON_CHAIN_ID,
            token: bytes32(uint256(0xC87C)), // cBTC token identifier (opaque here)
            amount: 5e8,
            recipient: bytes32(uint256(0x05E7_0A47)), // canton party id (opaque)
            callbackData: "",
            context: ""
        });

        uint256[2][] memory inputs = new uint256[2][](1);
        inputs[0] = [uint256(uint160(address(wbtc))), LOCK_AMOUNT];

        order = StandardOrder({
            user: solver,
            nonce: 1,
            originChainId: block.chainid,
            expires: uint32(block.timestamp + 1 days),
            fillDeadline: uint32(block.timestamp + 1 hours),
            inputOracle: address(oracle), // escrow will staticcall THIS
            inputs: inputs,
            outputs: outs
        });
    }

    /// @dev Reproduce the exact payloadHash the InputSettler will require.
    function _payloadHash(
        StandardOrder memory order,
        bytes32 solverId,
        uint32 fillTs
    ) internal view returns (bytes32) {
        bytes32 oid = escrow.orderIdentifier(order);
        return keccak256(
            MandateOutputEncodingLib.encodeFillDescriptionMemory(solverId, oid, fillTs, order.outputs[0])
        );
    }

    // --- the test ---

    function test_release_happyPath() public {
        StandardOrder memory order = _buildOrder();
        bytes32 solverId = _toId(solver);

        // 1) Open: solver deposits WBTC into the escrow.
        vm.prank(solver);
        escrow.open(order);
        assertEq(wbtc.balanceOf(address(escrow)), LOCK_AMOUNT, "escrow should hold the lock");
        assertEq(wbtc.balanceOf(solver), 0, "solver lock pulled");

        // 2) (off-chain: deliver cBTC on Canton — simulated as a no-op here)
        uint32 fillTs = uint32(block.timestamp);

        // Build solveParams the finalise() will use.
        InputSettlerBase.SolveParams[] memory sp = new InputSettlerBase.SolveParams[](1);
        sp[0] = InputSettlerBase.SolveParams({ timestamp: fillTs, solver: solverId });

        // 3a) NEGATIVE: finalise BEFORE attest must revert (NotProven).
        vm.prank(solver);
        vm.expectRevert(); // BaseInputOracle.NotProven
        escrow.finalise(order, sp, solverId, "");

        // 3b) Attest the fill on our oracle (as the attestor key).
        bytes32 ph = _payloadHash(order, solverId, fillTs);
        vm.prank(attestor);
        oracle.attest(CANTON_CHAIN_ID, _toId(address(oracle)), cantonSettlerId, ph);

        // 4) Finalise: escrow staticcalls oracle.efficientRequireProven -> true,
        //    releases WBTC to the destination (solver).
        vm.prank(solver);
        escrow.finalise(order, sp, solverId, "");

        assertEq(wbtc.balanceOf(solver), LOCK_AMOUNT, "WBTC released to solver");
        assertEq(wbtc.balanceOf(address(escrow)), 0, "escrow drained");
    }

    function test_release_wrongPayloadStaysLocked() public {
        StandardOrder memory order = _buildOrder();
        bytes32 solverId = _toId(solver);

        vm.prank(solver);
        escrow.open(order);

        uint32 fillTs = uint32(block.timestamp);
        InputSettlerBase.SolveParams[] memory sp = new InputSettlerBase.SolveParams[](1);
        sp[0] = InputSettlerBase.SolveParams({ timestamp: fillTs, solver: solverId });

        // Attest a WRONG payload hash (e.g. wrong timestamp) -> finalise still reverts.
        bytes32 wrongPh = _payloadHash(order, solverId, fillTs + 1);
        vm.prank(attestor);
        oracle.attest(CANTON_CHAIN_ID, _toId(address(oracle)), cantonSettlerId, wrongPh);

        vm.prank(solver);
        vm.expectRevert();
        escrow.finalise(order, sp, solverId, "");

        assertEq(wbtc.balanceOf(address(escrow)), LOCK_AMOUNT, "funds remain locked on wrong proof");
    }

    /// @notice The USER SAFETY VALVE: if the solver never delivers/finalises, the
    /// user reclaims their WBTC via refund() after `expires`. This is the
    /// protection that makes the two-legged model safe for users.
    function test_refund_returnsToUserAfterExpiry() public {
        // The user opens the order themselves here (they own the inputs).
        wbtc.mint(address(this), LOCK_AMOUNT);
        wbtc.approve(address(escrow), type(uint256).max);

        StandardOrder memory order = _buildOrder();
        // Override user to be this test contract so we can assert the refund target.
        order.user = address(this);

        escrow.open(order);
        assertEq(wbtc.balanceOf(address(escrow)), LOCK_AMOUNT, "locked");

        // Before expiry: refund must revert.
        vm.expectRevert();
        escrow.refund(order);

        // Warp past expiry — solver never finalised.
        vm.warp(order.expires + 1);

        uint256 before = wbtc.balanceOf(address(this));
        escrow.refund(order);
        assertEq(wbtc.balanceOf(address(this)) - before, LOCK_AMOUNT, "user refunded");
        assertEq(wbtc.balanceOf(address(escrow)), 0, "escrow drained to user");
    }
}
