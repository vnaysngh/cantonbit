// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";

/// @title HTLCEscrow — SHA-256 hash-timelock escrow for the EVM leg of a
/// trustless wBTC <-> cBTC atomic swap (1inch Fusion+ model).
///
/// VERIFICATION ARTIFACT (this session). Proves the EVM-side primitive that the
/// design depends on: a single 32-byte secret `s` with `H = sha256(s)` unlocks
/// this escrow, and the SAME `s` must unlock the Canton-side Daml HTLC. SHA-256
/// is chosen over keccak256 so EVM and Daml hash the preimage identically
/// (Daml's DA.Crypto.Text.sha256 == Solidity's 0x02 precompile).
///
/// Lifecycle: lock(H, timelock, claimer, safetyDeposit) -> claim(preimage) | refund()
///   - claim(preimage): anyone may submit; pays `claimer` if sha256(preimage)==H,
///     before timelock. Reveals `preimage` on-chain (the cross-chain unlock).
///   - refund(): only after timelock, returns principal to `funder`.
///   - safety deposit: paid to whoever lands the terminal tx (claim or refund),
///     incentivising completion/cleanup.
contract HTLCEscrow {
    enum State { Empty, Locked, Claimed, Refunded }

    struct Lock {
        address funder;        // who locked the principal (refund recipient)
        address claimer;       // who may receive on a valid preimage
        IERC20 token;          // principal token (wBTC)
        uint256 amount;        // principal amount
        bytes32 hashlock;      // H = sha256(s)
        uint64 timelock;       // unix seconds; claim only before, refund only after
        uint256 safetyDeposit; // wei, paid to the terminal-tx sender
        State state;
    }

    mapping(bytes32 => Lock) public locks; // swapId => Lock

    event Locked(bytes32 indexed swapId, address indexed funder, address indexed claimer, bytes32 hashlock, uint64 timelock, uint256 amount);
    event Claimed(bytes32 indexed swapId, bytes32 preimage, address claimer);
    event Refunded(bytes32 indexed swapId, address funder);

    error AlreadyExists();
    error NotLocked();
    error BadPreimage();
    error TooLate();
    error TooEarly();

    /// Lock principal under hashlock H with a timelock. `swapId` ties this leg
    /// to the same swap on Canton (e.g. the signed order id).
    function lock(
        bytes32 swapId,
        address claimer,
        IERC20 token,
        uint256 amount,
        bytes32 hashlock,
        uint64 timelock
    ) external payable {
        if (locks[swapId].state != State.Empty) revert AlreadyExists();
        // pull principal from funder (test approves first)
        require(token.transferFrom(msg.sender, address(this), amount), "transferFrom");
        locks[swapId] = Lock({
            funder: msg.sender,
            claimer: claimer,
            token: token,
            amount: amount,
            hashlock: hashlock,
            timelock: timelock,
            safetyDeposit: msg.value,
            state: State.Locked
        });
        emit Locked(swapId, msg.sender, claimer, hashlock, timelock, amount);
    }

    /// Reveal the preimage to release principal to `claimer`. Callable by anyone
    /// (a watchtower can finish a stalled swap) — the preimage is the only gate.
    function claim(bytes32 swapId, bytes32 preimage) external {
        Lock storage l = locks[swapId];
        if (l.state != State.Locked) revert NotLocked();
        if (block.timestamp >= l.timelock) revert TooLate();
        // SHA-256 hashlock — identical hash function to the Canton Daml leg.
        if (sha256(abi.encodePacked(preimage)) != l.hashlock) revert BadPreimage();
        l.state = State.Claimed;
        require(l.token.transfer(l.claimer, l.amount), "transfer");
        if (l.safetyDeposit > 0) {
            (bool ok,) = msg.sender.call{value: l.safetyDeposit}("");
            require(ok, "deposit");
        }
        emit Claimed(swapId, preimage, l.claimer);
    }

    /// Return principal to the funder after the timelock. No preimage needed.
    function refund(bytes32 swapId) external {
        Lock storage l = locks[swapId];
        if (l.state != State.Locked) revert NotLocked();
        if (block.timestamp < l.timelock) revert TooEarly();
        l.state = State.Refunded;
        require(l.token.transfer(l.funder, l.amount), "transfer");
        if (l.safetyDeposit > 0) {
            (bool ok,) = msg.sender.call{value: l.safetyDeposit}("");
            require(ok, "deposit");
        }
        emit Refunded(swapId, l.funder);
    }
}
