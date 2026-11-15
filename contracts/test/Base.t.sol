// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {QueueVault} from "../src/QueueVault.sol";
import {InstantPool} from "../src/InstantPool.sol";
import {MockMorpho, MockUSDC} from "./mocks/Mocks.sol";

/// @notice Shared setup: a vault and pool over the mock market, plus helpers that read like the user stories.
abstract contract BaseTest is Test {
    using MarketParamsLib for MarketParams;

    uint256 internal constant USDC = 1e6;

    MockUSDC internal usdc;
    MockMorpho internal morpho;
    MarketParams internal params;
    QueueVault internal vault;
    InstantPool internal pool;

    address internal ana = makeAddr("ana");
    address internal ben = makeAddr("ben");
    address internal cy = makeAddr("cy");
    address internal lp = makeAddr("lp");
    address internal borrower = makeAddr("borrower");

    function setUp() public virtual {
        usdc = new MockUSDC();
        morpho = new MockMorpho();
        params = MarketParams({
            loanToken: address(usdc),
            collateralToken: makeAddr("collateral"),
            oracle: makeAddr("oracle"),
            irm: makeAddr("irm"),
            lltv: 0.86e18
        });
        morpho.createMarket(params);
        vault = new QueueVault(IERC20(address(usdc)), IMorpho(address(morpho)), params, "Spillway USDC", "spUSDC");
        pool = new InstantPool(vault, "Spillway Pool", "spPOOL");

        vm.startPrank(borrower);
        usdc.approve(address(morpho), type(uint256).max);
        vm.stopPrank();
    }

    function _deposit(address who, uint256 assets) internal returns (uint256 shares) {
        usdc.mint(who, assets);
        vm.startPrank(who);
        usdc.approve(address(vault), assets);
        shares = vault.deposit(assets, who);
        vm.stopPrank();
    }

    function _fundPool(uint256 assets) internal {
        usdc.mint(lp, assets);
        vm.startPrank(lp);
        usdc.approve(address(pool), assets);
        pool.deposit(assets, lp);
        vm.stopPrank();
    }

    /// @dev Borrows every dollar the market can release, so the vault is 100 percent lent out.
    function _borrowAll() internal {
        uint256 liquidity = vault.withdrawable();
        if (liquidity == 0) return;
        vm.prank(borrower);
        morpho.borrow(params, liquidity, 0, borrower, borrower);
    }

    function _repay(uint256 assets) internal {
        usdc.mint(borrower, assets);
        vm.prank(borrower);
        morpho.repay(params, assets, 0, borrower, "");
    }

    function _request(address who, uint256 shares) internal returns (uint256 requestId, uint256 assets, bool paidAtOnce) {
        vm.prank(who);
        return vault.requestRedeem(shares, who);
    }
}
