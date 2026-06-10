// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

// ============================================================================
// REFERENCE ONLY — Cancore's production EVM HTLC, verbatim.
//
// Source: verified on Sepolia Etherscan (full match via Sourcify),
//   contract HTLC @ 0x58D154441Fd7efEd22E49Eda369909DdbE54cC0a
// Captured 2026-06 while reverse-engineering Cancore (live mainnet HTLC
// EVM<>Canton atomic-swap product). See docs/CANCORE-REVERSE-ENGINEERED.md.
//
// KEY FACTS (these drive our T2/T4):
//   * It is a CUSTOM ~120-line HTLC — NOT a fork of OpenIntents / 1inch / chatch.
//     (OpenIntents/InputSettlerEscrow was our OLD trusted-oracle swap; it is NOT
//      the HTLC base. The HTLC leg is this simple contract.)
//   * Hash = keccak256(preImage)  ← so BOTH legs use keccak256, not sha256.
//   * Locks keyed by hashValue (the hashlock). No swapId.
//   * claim(bytes preImage): receiver-only, before unlockTime; reveals preImage
//     in the Claimed event (the cross-chain signal the other leg reads).
//   * retake(bytes32 hashValue): sender-only, after unlockTime (the refund).
//   * Reentrancy mitigated by `delete locks[hashValue]` BEFORE the transfer.
//   * ERC20-only; no native ETH; no safety deposit; no in-contract fees
//     (the 1% fee is applied off-chain in the amounts).
//
// OBSERVATIONS for OUR hardened version (contracts/src/HTLCEscrow.sol, T4):
//   - `lock()` does NOT emit the `Locked` event (declared but never emitted) —
//     we SHOULD emit it (indexers/watchtowers need it).
//   - Uses bare IERC20 transfer/transferFrom with bool checks — we should use
//     SafeERC20 to support non-standard / fee-on-transfer tokens (USDT etc.).
//   - No assert that unlockTime is in the future or within sane bounds — we
//     should enforce the timelock ladder (this leg's unlockTime vs the other
//     leg's) at the orchestration layer, and sanity-bound it here.
//   - `delete`-before-transfer is correct checks-effects; a nonReentrant guard
//     is cheap belt-and-suspenders we may still add.
//   - preImage is `bytes` (arbitrary length) — flexible; our canonical secret
//     encoding must be fixed once (T2) so both legs hash identical bytes.
// ============================================================================

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract HTLC {
    struct Lock {
        uint unlockTime;
        uint amount;
        address tokenAddress;
        address senderAddress;
        address receiverAddress;
    }

    mapping(bytes32 => Lock) public locks;

    event Claimed(
        bytes preImage,
        bytes32 hashValue,
        uint when,
        uint amount,
        address tokenAddress,
        address senderAddress,
        address receiverAddress
    );

    event Locked(
        bytes32 hashValue,
        uint when,
        uint amount,
        address tokenAddress,
        address senderAddress,
        address receiverAddress
    );

    event Retaken(
        bytes32 hashValue,
        uint when,
        uint amount,
        address tokenAddress,
        address senderAddress,
        address receiverAddress
    );

    function claim(bytes calldata preImage) external {
        bytes32 hashValue = keccak256(preImage);
        Lock storage l = locks[hashValue];
        uint amount = l.amount;
        require(amount > 0, "HTLC: not a valid pre-image for any hash");

        require(block.timestamp < l.unlockTime, "HTLC: can only claim before the unlock time");
        address receiverAddress = l.receiverAddress;
        require(msg.sender == receiverAddress, "HTLC: only the receiver can claim");

        IERC20 erc20 = IERC20(l.tokenAddress);
        delete locks[hashValue];
        require(erc20.transfer(receiverAddress, amount), "HTLC: erc20 transfer must be successful");

        emit Claimed({
            preImage: preImage,
            hashValue: hashValue,
            amount: l.amount,
            when: block.timestamp,
            tokenAddress: l.tokenAddress,
            senderAddress: l.senderAddress,
            receiverAddress: l.receiverAddress
        });
    }

    function lock(
        bytes32 hashValue,
        uint unlockTime,
        uint amount,
        address tokenAddress,
        address receiverAddress
    ) external {
        require(locks[hashValue].amount == 0, "HTLC: lock cannot already exist for the same hash value");
        require(amount > 0, "HTLC: cannot lock zero tokens");

        locks[hashValue] = Lock({
            unlockTime: unlockTime,
            amount: amount,
            tokenAddress: tokenAddress,
            senderAddress: msg.sender,
            receiverAddress: receiverAddress
        });

        IERC20 erc20 = IERC20(tokenAddress);

        require(
            erc20.transferFrom(msg.sender, address(this), amount),
            "HTLC: erc20 transfer for locking must be successful"
        );
    }

    function retake(bytes32 hashValue) external {
        Lock storage l = locks[hashValue];
        uint amount = l.amount;
        require(amount > 0, "HTLC: no lock exists for the given hash");

        require(block.timestamp >= l.unlockTime, "HTLC: can only retake on or after the unlock time");
        address senderAddress = l.senderAddress;
        require(msg.sender == senderAddress, "HTLC: only the sender can retake");

        IERC20 erc20 = IERC20(l.tokenAddress);
        delete locks[hashValue];
        require(erc20.transfer(senderAddress, amount), "HTLC: erc20 transfer must be successful");

        emit Retaken({
            hashValue: hashValue,
            amount: l.amount,
            when: block.timestamp,
            tokenAddress: l.tokenAddress,
            senderAddress: l.senderAddress,
            receiverAddress: l.receiverAddress
        });
    }
}
