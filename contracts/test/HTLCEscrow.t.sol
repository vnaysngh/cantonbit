// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {HTLCEscrow} from "../src/HTLCEscrow.sol";
import {MockWBTC} from "../src/MockWBTC.sol";

contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee Token", "FEE") {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && value > 1) {
            super._update(from, address(0xD00D), 1);
            super._update(from, to, value - 1);
        } else {
            super._update(from, to, value);
        }
    }
}

/// Tests the keccak256, hashlock-keyed HTLC (aligned to Cancore's HTLC.sol).
/// One secret `preImage` with hashValue = keccak256(preImage) gates the lock;
/// the SAME hashValue must gate the Canton Daml leg (DA.Crypto.Text.keccak256).
contract HTLCEscrowTest is Test {
    HTLCEscrow escrow;
    MockWBTC wbtc;

    address sender = address(0xF00D);   // funder / retaker
    address receiver = address(0xBEEF); // claimer

    bytes PREIMAGE = bytes("the-cross-chain-secret-32bytes!!");
    uint256 constant AMOUNT = 1e8; // 1 wBTC (8dp)

    function setUp() public {
        escrow = new HTLCEscrow();
        wbtc = new MockWBTC();
        wbtc.mint(sender, AMOUNT);
    }

    function _hash() internal view returns (bytes32) {
        return keccak256(PREIMAGE);
    }

    function _lock(uint64 unlockTime) internal {
        vm.startPrank(sender);
        wbtc.approve(address(escrow), AMOUNT);
        escrow.lock(_hash(), unlockTime, AMOUNT, address(wbtc), receiver);
        vm.stopPrank();
    }

    /// keccak256 parity: the on-chain hash of the secret is a fixed value the
    /// Canton leg must reproduce. Printed for cross-impl comparison.
    function test_keccak_parity_value() public {
        bytes32 h = keccak256(PREIMAGE);
        assertEq(h, _hash());
        emit log_named_bytes("preImage", PREIMAGE);
        emit log_named_bytes32("hashValue = keccak256(preImage)", h);
    }

    function test_lock_pulls_funds_and_emits() public {
        _lock(uint64(block.timestamp + 4 hours));
        assertEq(wbtc.balanceOf(address(escrow)), AMOUNT, "escrow holds funds");
        (, uint256 amt,, address s, address r) = escrow.locks(_hash());
        assertEq(amt, AMOUNT);
        assertEq(s, sender);
        assertEq(r, receiver);
    }

    function test_claim_with_correct_preimage() public {
        _lock(uint64(block.timestamp + 4 hours));
        vm.prank(receiver);
        escrow.claim(PREIMAGE);
        assertEq(wbtc.balanceOf(receiver), AMOUNT, "receiver paid");
    }

    function test_claim_wrong_preimage_reverts() public {
        _lock(uint64(block.timestamp + 4 hours));
        vm.prank(receiver);
        vm.expectRevert(HTLCEscrow.NoLock.selector); // wrong preimage hashes to an empty lock
        escrow.claim(bytes("not-the-secret"));
    }

    function test_claim_by_non_receiver_reverts() public {
        _lock(uint64(block.timestamp + 4 hours));
        vm.prank(sender); // sender is not the receiver
        vm.expectRevert(HTLCEscrow.NotReceiver.selector);
        escrow.claim(PREIMAGE);
    }

    function test_claim_after_timelock_reverts() public {
        uint64 t = uint64(block.timestamp + 4 hours);
        _lock(t);
        vm.warp(t);
        vm.prank(receiver);
        vm.expectRevert(HTLCEscrow.TooLate.selector);
        escrow.claim(PREIMAGE);
    }

    function test_retake_before_timelock_reverts() public {
        _lock(uint64(block.timestamp + 4 hours));
        vm.prank(sender);
        vm.expectRevert(HTLCEscrow.TooEarly.selector);
        escrow.retake(_hash());
    }

    function test_retake_after_timelock() public {
        uint64 t = uint64(block.timestamp + 4 hours);
        _lock(t);
        vm.warp(t);
        vm.prank(sender);
        escrow.retake(_hash());
        assertEq(wbtc.balanceOf(sender), AMOUNT, "sender refunded");
    }

    function test_retake_by_non_sender_reverts() public {
        uint64 t = uint64(block.timestamp + 4 hours);
        _lock(t);
        vm.warp(t);
        vm.prank(receiver);
        vm.expectRevert(HTLCEscrow.NotSender.selector);
        escrow.retake(_hash());
    }

    function test_no_double_lock_same_hash() public {
        _lock(uint64(block.timestamp + 4 hours));
        wbtc.mint(sender, AMOUNT);
        vm.startPrank(sender);
        wbtc.approve(address(escrow), AMOUNT);
        vm.expectRevert(HTLCEscrow.LockExists.selector);
        escrow.lock(_hash(), uint64(block.timestamp + 4 hours), AMOUNT, address(wbtc), receiver);
        vm.stopPrank();
    }

    function test_no_double_claim() public {
        _lock(uint64(block.timestamp + 4 hours));
        vm.prank(receiver);
        escrow.claim(PREIMAGE);
        vm.prank(receiver);
        vm.expectRevert(HTLCEscrow.NoLock.selector); // lock deleted
        escrow.claim(PREIMAGE);
    }

    function test_lock_in_past_reverts() public {
        vm.warp(1000);
        vm.startPrank(sender);
        wbtc.approve(address(escrow), AMOUNT);
        vm.expectRevert(HTLCEscrow.BadUnlockTime.selector);
        escrow.lock(_hash(), uint64(500), AMOUNT, address(wbtc), receiver);
        vm.stopPrank();
    }

    function test_zero_amount_reverts() public {
        vm.startPrank(sender);
        wbtc.approve(address(escrow), AMOUNT);
        vm.expectRevert(HTLCEscrow.ZeroAmount.selector);
        escrow.lock(_hash(), uint64(block.timestamp + 1 hours), 0, address(wbtc), receiver);
        vm.stopPrank();
    }

    function test_fee_on_transfer_token_reverts() public {
        FeeOnTransferToken feeToken = new FeeOnTransferToken();
        feeToken.mint(sender, AMOUNT);
        vm.startPrank(sender);
        feeToken.approve(address(escrow), AMOUNT);
        vm.expectRevert(HTLCEscrow.UnsupportedFeeOnTransferToken.selector);
        escrow.lock(_hash(), uint64(block.timestamp + 1 hours), AMOUNT, address(feeToken), receiver);
        vm.stopPrank();
    }
}
