// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";

import { MandateOutputEncodingLib } from "oif-contracts/src/libs/MandateOutputEncodingLib.sol";
import { MandateOutput } from "oif-contracts/src/input/types/MandateOutputType.sol";
import { StandardOrder, StandardOrderType } from "oif-contracts/src/input/types/StandardOrderType.sol";

/// @dev Thin wrapper to call the `internal` lib functions with calldata args.
contract EncoderHarness {
    using StandardOrderType for StandardOrder;

    function fillDescription(
        bytes32 solver,
        bytes32 oid,
        uint32 timestamp,
        MandateOutput calldata output
    ) external pure returns (bytes memory) {
        return MandateOutputEncodingLib.encodeFillDescription(solver, oid, timestamp, output);
    }

    function fillDescriptionHash(
        bytes32 solver,
        bytes32 oid,
        uint32 timestamp,
        MandateOutput calldata output
    ) external pure returns (bytes32) {
        return keccak256(MandateOutputEncodingLib.encodeFillDescription(solver, oid, timestamp, output));
    }

    function orderId(
        StandardOrder calldata order
    ) external view returns (bytes32) {
        return order.orderIdentifier();
    }
}

/**
 * @notice Differential test: asserts the TS encoder (swap-solver/src/encoding.ts,
 * invoked over FFI) produces byte-identical output to the real on-chain
 * MandateOutputEncodingLib / StandardOrderType. This is the guard that keeps the
 * off-chain agent's payloadHash in lockstep with what the InputSettler computes.
 */
contract EncodingParityTest is Test {
    EncoderHarness harness;

    function setUp() public {
        harness = new EncoderHarness();
    }

    // ---- helpers ----

    function _baseOutput() internal pure returns (MandateOutput memory o) {
        o.oracle = bytes32(uint256(0xA11CE));
        o.settler = bytes32(uint256(0x5E771E2));
        o.chainId = 999;
        o.token = bytes32(uint256(0x70CE7));
        o.amount = 1_234_567_890_000_000_000;
        o.recipient = bytes32(uint256(0xBEEF));
        o.callbackData = "";
        o.context = "";
    }

    /// @dev Invoke the TS encoder over FFI for a fill-description and return its bytes.
    function _ffiFillDescription(
        bytes32 solver,
        bytes32 orderId,
        uint32 timestamp,
        MandateOutput memory o
    ) internal returns (bytes memory) {
        string memory job = string.concat(
            '{"fn":"fillDescription",',
            '"solver":"', vm.toString(solver), '",',
            '"orderId":"', vm.toString(orderId), '",',
            '"timestamp":', vm.toString(uint256(timestamp)), ',',
            '"output":', _outputJson(o),
            "}"
        );
        return vm.ffi(_tsxCmd(job));
    }

    function _outputJson(MandateOutput memory o) internal pure returns (string memory) {
        return string.concat(
            '{"oracle":"', vm.toString(o.oracle), '",',
            '"settler":"', vm.toString(o.settler), '",',
            '"chainId":"', vm.toString(o.chainId), '",',
            '"token":"', vm.toString(o.token), '",',
            '"amount":"', vm.toString(o.amount), '",',
            '"recipient":"', vm.toString(o.recipient), '",',
            '"callbackData":"', vm.toString(o.callbackData), '",',
            '"context":"', vm.toString(o.context), '"}'
        );
    }

    function _tsxCmd(string memory json) internal pure returns (string[] memory cmd) {
        cmd = new string[](3);
        cmd[0] = "../swap-solver/node_modules/.bin/tsx";
        cmd[1] = "../swap-solver/src/encode-cli.ts";
        cmd[2] = json;
    }

    // ---- tests: fill description (empty data) ----

    function test_fillDescription_empty() public {
        bytes32 solver = bytes32(uint256(0x50));
        bytes32 oid = bytes32(uint256(0x0DE21D));
        uint32 ts = 1_780_000_000;
        MandateOutput memory o = _baseOutput();

        bytes memory onchain = harness.fillDescription(solver, oid, ts, o);
        bytes memory offchain = _ffiFillDescription(solver, oid, ts, o);

        assertEq(offchain, onchain, "fillDescription mismatch (empty data)");
        // Header floor is 168 bytes (the OutputSettler's PayloadTooSmall check).
        assertEq(onchain.length, 168, "expected 168-byte header for empty data");
    }

    // ---- tests: fill description (non-empty callbackData + context) ----

    function test_fillDescription_withData() public {
        bytes32 solver = bytes32(uint256(0x51));
        bytes32 oid = bytes32(uint256(0x0DE22D));
        uint32 ts = 42;
        MandateOutput memory o = _baseOutput();
        o.callbackData = hex"deadbeef";
        o.context = hex"cafe";

        bytes memory onchain = harness.fillDescription(solver, oid, ts, o);
        bytes memory offchain = _ffiFillDescription(solver, oid, ts, o);

        assertEq(offchain, onchain, "fillDescription mismatch (with data)");
    }

    // ---- tests: timestamp edge (max uint32) ----

    function test_fillDescription_maxTimestamp() public {
        bytes32 solver = bytes32(uint256(0x52));
        bytes32 oid = bytes32(uint256(0x0DE23D));
        uint32 ts = type(uint32).max;
        MandateOutput memory o = _baseOutput();

        bytes memory onchain = harness.fillDescription(solver, oid, ts, o);
        bytes memory offchain = _ffiFillDescription(solver, oid, ts, o);
        assertEq(offchain, onchain, "fillDescription mismatch (max timestamp)");
    }

    // ---- tests: the hash itself (what the oracle attests) ----

    function test_fillDescriptionHash_matches() public {
        bytes32 solver = bytes32(uint256(0x53));
        bytes32 oid = bytes32(uint256(0x0DE24D));
        uint32 ts = 1_780_000_123;
        MandateOutput memory o = _baseOutput();
        o.callbackData = hex"0011223344";

        bytes32 onchain = harness.fillDescriptionHash(solver, oid, ts, o);

        string memory job = string.concat(
            '{"fn":"fillDescriptionHash",',
            '"solver":"', vm.toString(solver), '",',
            '"orderId":"', vm.toString(oid), '",',
            '"timestamp":', vm.toString(uint256(ts)), ',',
            '"output":', _outputJson(o),
            "}"
        );
        bytes memory raw = vm.ffi(_tsxCmd(job));
        bytes32 offchain = _toBytes32(raw);

        assertEq(offchain, onchain, "fillDescriptionHash mismatch");
    }

    // ---- tests: orderId ----

    function test_orderId_matches() public {
        MandateOutput[] memory outs = new MandateOutput[](1);
        outs[0] = _baseOutput();

        uint256[2][] memory inputs = new uint256[2][](1);
        inputs[0] = [uint256(uint160(0x5FbDB2315678afecb367f032d93F642f64180aa3)), 100e18];

        StandardOrder memory order = StandardOrder({
            user: address(0x7099),
            nonce: 7,
            originChainId: block.chainid,
            expires: uint32(block.timestamp + 1000),
            fillDeadline: uint32(block.timestamp + 500),
            inputOracle: address(0x0BAC1E),
            inputs: inputs,
            outputs: outs
        });

        bytes32 onchain = harness.orderId(order);

        // The escrow address that computes the id == address(harness) here.
        string memory job = string.concat(
            '{"fn":"orderId","escrow":"', vm.toString(address(harness)), '","order":',
            _orderJson(order),
            "}"
        );
        bytes memory raw = vm.ffi(_tsxCmd(job));
        bytes32 offchain = _toBytes32(raw);

        assertEq(offchain, onchain, "orderId mismatch");
    }

    function _orderJson(StandardOrder memory order) internal pure returns (string memory) {
        // single-input, single-output JSON (sufficient for the fixture)
        return string.concat(
            '{"user":"', vm.toString(order.user), '",',
            '"nonce":"', vm.toString(order.nonce), '",',
            '"originChainId":"', vm.toString(order.originChainId), '",',
            '"expires":', vm.toString(uint256(order.expires)), ',',
            '"fillDeadline":', vm.toString(uint256(order.fillDeadline)), ',',
            '"inputOracle":"', vm.toString(order.inputOracle), '",',
            '"inputs":[["', vm.toString(order.inputs[0][0]), '","', vm.toString(order.inputs[0][1]), '"]],',
            '"outputs":[', _outputJson(order.outputs[0]), ']}'
        );
    }

    function _toBytes32(bytes memory b) internal pure returns (bytes32 r) {
        require(b.length == 32, "ffi did not return 32 bytes");
        assembly {
            r := mload(add(b, 32))
        }
    }
}
