// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { ERC20 } from "openzeppelin/token/ERC20/ERC20.sol";

/**
 * @title MockWBTC
 * @notice A test stand-in for Wrapped BTC on EVM testnets where no canonical
 * WBTC exists. It mirrors real WBTC where it matters for this app:
 *   - symbol "WBTC"
 *   - **8 decimals** (real WBTC and BTC use 8, NOT the ERC20 default of 18).
 *     The whole swap codebase treats WBTC amounts as 8dp; a token reporting 18
 *     would make wallets display balances off by 1e10. So we override here.
 *   - a permissionless mint() so testers can fund a wallet.
 *
 * On mainnet this contract is unused — the real canonical WBTC address is wired
 * via env instead.
 */
contract MockWBTC is ERC20 {
    constructor() ERC20("Mock WBTC", "WBTC") {}

    /// @dev Real WBTC/BTC precision. Overrides OZ's default of 18.
    function decimals() public pure override returns (uint8) {
        return 8;
    }

    /// @notice Permissionless test mint. Testnet only.
    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}
