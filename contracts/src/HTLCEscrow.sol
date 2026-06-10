// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin/utils/ReentrancyGuard.sol";

/// @title HTLCEscrow — EVM leg of a trustless EVM<>Canton atomic swap.
///
/// Aligned to Cancore's production HTLC (verified on Sepolia; see
/// contracts/reference/CancoreHTLC.sol), with hardening:
///   - keccak256(preImage) hashlock  ← SAME hash as the Canton Daml leg
///     (Daml DA.Crypto.Text.keccak256). One secret unlocks both legs.
///   - locks keyed by the hashlock (`hashValue`); no swapId.
///   - claim(preImage): receiver-only, before unlockTime; reveals preImage in the
///     Claimed event — the cross-chain signal the other leg reads to settle.
///   - retake(hashValue): sender-only, after unlockTime (the refund).
///   - checks-effects (delete before transfer) + ReentrancyGuard + SafeERC20.
///   - emits Locked (Cancore declared but never emitted it — indexers need it).
///
/// Timelock-ladder note: this leg's `unlockTime` vs the other leg's is enforced
/// at the orchestration layer (the EVM leg of a given direction gets the longer
/// timelock). Here we only sanity-bound it (must be in the future).
contract HTLCEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Lock {
        uint64 unlockTime;       // unix seconds; claim only before, retake only after
        uint256 amount;
        address tokenAddress;
        address senderAddress;   // funder; gets the retake (refund)
        address receiverAddress; // may claim with the preimage
    }

    mapping(bytes32 => Lock) public locks; // keccak256(preImage) => Lock

    event Locked(bytes32 indexed hashValue, uint256 when, uint256 amount, address tokenAddress, address senderAddress, address receiverAddress);
    event Claimed(bytes preImage, bytes32 indexed hashValue, uint256 when, uint256 amount, address tokenAddress, address senderAddress, address receiverAddress);
    event Retaken(bytes32 indexed hashValue, uint256 when, uint256 amount, address tokenAddress, address senderAddress, address receiverAddress);

    error LockExists();
    error ZeroAmount();
    error BadUnlockTime();
    error NoLock();
    error TooLate();
    error TooEarly();
    error NotReceiver();
    error NotSender();
    error BadPreimage();

    /// Lock `amount` of `tokenAddress` under hashlock `hashValue` until `unlockTime`,
    /// claimable by `receiverAddress` with the preimage. Funder must approve first.
    function lock(
        bytes32 hashValue,
        uint64 unlockTime,
        uint256 amount,
        address tokenAddress,
        address receiverAddress
    ) external nonReentrant {
        if (locks[hashValue].amount != 0) revert LockExists();
        if (amount == 0) revert ZeroAmount();
        if (unlockTime <= block.timestamp) revert BadUnlockTime();

        locks[hashValue] = Lock({
            unlockTime: unlockTime,
            amount: amount,
            tokenAddress: tokenAddress,
            senderAddress: msg.sender,
            receiverAddress: receiverAddress
        });

        // SafeERC20: supports non-bool-returning / fee-on-transfer tokens (USDT…).
        IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), amount);

        emit Locked(hashValue, block.timestamp, amount, tokenAddress, msg.sender, receiverAddress);
    }

    /// Reveal `preImage` to release the locked tokens to the receiver. Anyone may
    /// submit, but funds go to the stored receiver — preImage is the only gate.
    /// Reveals preImage on-chain (Claimed event) for the cross-chain unlock.
    function claim(bytes calldata preImage) external nonReentrant {
        bytes32 hashValue = keccak256(preImage);
        Lock memory l = locks[hashValue];
        if (l.amount == 0) revert NoLock();
        if (block.timestamp >= l.unlockTime) revert TooLate();
        // Cancore restricts claim to the receiver; we keep that (matches their model).
        if (msg.sender != l.receiverAddress) revert NotReceiver();

        delete locks[hashValue]; // effects before interaction
        IERC20(l.tokenAddress).safeTransfer(l.receiverAddress, l.amount);

        emit Claimed(preImage, hashValue, block.timestamp, l.amount, l.tokenAddress, l.senderAddress, l.receiverAddress);
    }

    /// After the timelock, the sender reclaims the locked tokens. No preimage.
    function retake(bytes32 hashValue) external nonReentrant {
        Lock memory l = locks[hashValue];
        if (l.amount == 0) revert NoLock();
        if (block.timestamp < l.unlockTime) revert TooEarly();
        if (msg.sender != l.senderAddress) revert NotSender();

        delete locks[hashValue];
        IERC20(l.tokenAddress).safeTransfer(l.senderAddress, l.amount);

        emit Retaken(hashValue, block.timestamp, l.amount, l.tokenAddress, l.senderAddress, l.receiverAddress);
    }
}
