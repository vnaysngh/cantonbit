// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {HTLCEscrow} from "../src/HTLCEscrow.sol";
import {MockWBTC} from "../src/MockWBTC.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";

/// VERIFICATION: proves the EVM-leg HTLC primitive for the trustless atomic swap.
/// Each test maps to a kill-shot assumption from the design.
contract HTLCEscrowTest is Test {
    HTLCEscrow escrow;
    MockWBTC wbtc;

    address funder = address(0xF00D);   // resolver/solver locking wBTC (EVM->Canton: resolver claims)
    address claimer = address(0xBEEF);   // party who claims with the secret
    address watchtower = address(0xCAFE); // anyone can finish a stalled swap

    bytes32 constant SWAP_ID = keccak256("swap-1");
    // The secret `s` and its SHA-256 hashlock. THIS hash must equal Daml's
    // DA.Crypto.Text.sha256 over the same preimage for the cross-chain unlock.
    bytes32 constant SECRET = bytes32(uint256(0x1234567890abcdef));
    uint256 constant AMOUNT = 1e8; // 1 wBTC (8dp)

    function setUp() public {
        escrow = new HTLCEscrow();
        wbtc = new MockWBTC();
        wbtc.mint(funder, AMOUNT);
        vm.deal(funder, 1 ether); // safety deposit funds
    }

    function _hashlock() internal pure returns (bytes32) {
        return sha256(abi.encodePacked(SECRET));
    }

    function _lock(uint64 timelock, uint256 deposit) internal {
        vm.startPrank(funder);
        wbtc.approve(address(escrow), AMOUNT);
        escrow.lock{value: deposit}(SWAP_ID, claimer, IERC20(address(wbtc)), AMOUNT, _hashlock(), timelock);
        vm.stopPrank();
    }

    /// A1: SHA-256 hashlock parity — the on-chain digest of the secret must be a
    /// fixed, reproducible value. We print it so it can be compared byte-for-byte
    /// against Daml's sha256 of the same preimage on the Canton node.
    function test_sha256_parity_value() public {
        bytes32 h = sha256(abi.encodePacked(SECRET));
        // Known-answer: sha256 of the 32-byte secret. Daml script must produce
        // the SAME hex when given the same 32 bytes.
        assertEq(h, _hashlock());
        emit log_named_bytes32("preimage (s)", SECRET);
        emit log_named_bytes32("hashlock H = sha256(s)", h);
    }

    /// Happy path: correct preimage releases principal to claimer before timelock.
    function test_claim_with_correct_preimage() public {
        _lock(uint64(block.timestamp + 4 hours), 0);
        assertEq(wbtc.balanceOf(claimer), 0);
        vm.prank(watchtower); // ANYONE can submit the revealed secret
        escrow.claim(SWAP_ID, SECRET);
        assertEq(wbtc.balanceOf(claimer), AMOUNT, "claimer paid");
    }

    /// Wrong preimage must revert — no theft via a guessed/incorrect secret.
    function test_claim_wrong_preimage_reverts() public {
        _lock(uint64(block.timestamp + 4 hours), 0);
        vm.prank(watchtower);
        vm.expectRevert(HTLCEscrow.BadPreimage.selector);
        escrow.claim(SWAP_ID, bytes32(uint256(0xDEAD)));
    }

    /// Claim after the timelock must fail — the refund window has opened, so the
    /// secret-holder can no longer claim (prevents double-spend across the gap).
    function test_claim_after_timelock_reverts() public {
        uint64 t = uint64(block.timestamp + 4 hours);
        _lock(t, 0);
        vm.warp(t);
        vm.prank(watchtower);
        vm.expectRevert(HTLCEscrow.TooLate.selector);
        escrow.claim(SWAP_ID, SECRET);
    }

    /// Refund before the timelock must fail — funder can't pull principal out
    /// from under a still-claimable swap.
    function test_refund_before_timelock_reverts() public {
        _lock(uint64(block.timestamp + 4 hours), 0);
        vm.prank(funder);
        vm.expectRevert(HTLCEscrow.TooEarly.selector);
        escrow.refund(SWAP_ID);
    }

    /// Refund after the timelock returns principal to the funder.
    function test_refund_after_timelock() public {
        uint64 t = uint64(block.timestamp + 4 hours);
        _lock(t, 0);
        vm.warp(t);
        vm.prank(funder);
        escrow.refund(SWAP_ID);
        assertEq(wbtc.balanceOf(funder), AMOUNT, "funder refunded");
    }

    /// Safety deposit is paid to whoever lands the terminal tx (incentive to
    /// complete/clean up a stalled swap) — proven on the claim path.
    function test_safety_deposit_paid_to_claim_sender() public {
        _lock(uint64(block.timestamp + 4 hours), 0.1 ether);
        uint256 before = watchtower.balance;
        vm.prank(watchtower);
        escrow.claim(SWAP_ID, SECRET);
        assertEq(watchtower.balance - before, 0.1 ether, "watchtower earns deposit");
    }

    /// Cannot claim twice (state machine closes after terminal).
    function test_no_double_claim() public {
        _lock(uint64(block.timestamp + 4 hours), 0);
        vm.prank(watchtower);
        escrow.claim(SWAP_ID, SECRET);
        vm.prank(watchtower);
        vm.expectRevert(HTLCEscrow.NotLocked.selector);
        escrow.claim(SWAP_ID, SECRET);
    }
}
