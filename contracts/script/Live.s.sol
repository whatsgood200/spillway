// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams} from "morpho-blue/interfaces/IMorpho.sol";
import {QueueVault} from "../src/QueueVault.sol";

interface IDemoCollateral {
    function mint(address to, uint256 amount) external;
}

/// Live checks against the Base Sepolia deployment. The sender acts as lender and as the labelled demo borrower.
///
/// 1. forge script script/Live.s.sol:SeedQueue --rpc-url base_sepolia --account spillway --sender <deployer> --broadcast
///    Deposits AMOUNT (default 5 USDC), borrows everything the market can release, then requests a withdrawal,
///    which must queue because the market is 100 percent lent out.
/// 2. forge script script/Live.s.sol:RepayLoan --rpc-url base_sepolia --account spillway --sender <deployer> --broadcast
///    Repays AMOUNT. Nothing here calls settle: Reactive Network must pay the queue by itself.
abstract contract LiveBase is Script {
    IMorpho internal constant MORPHO = IMorpho(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    IERC20 internal constant USDC = IERC20(0x036CbD53842c5426634e7929541eC2318f3dCF7e);

    function _vault() internal view returns (QueueVault) {
        return QueueVault(vm.envOr("VAULT", address(0x8a430D6472Fbf703233BA5083e134B490d2f60F6)));
    }

    function _amount() internal view returns (uint256) {
        return vm.envOr("AMOUNT", uint256(5e6));
    }
}

contract SeedQueue is LiveBase {
    function run() external {
        require(block.chainid == 84532, "run on Base Sepolia");
        QueueVault vault = _vault();
        MarketParams memory params = vault.marketParams();
        uint256 amount = _amount();

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();

        USDC.approve(address(vault), amount);
        uint256 shares = vault.deposit(amount, sender);

        // Demo borrower: 1 sdCOL is priced at 2,000 USDC, so 1 sdCOL comfortably backs a small loan.
        IDemoCollateral(params.collateralToken).mint(sender, 1e18);
        IERC20(params.collateralToken).approve(address(MORPHO), 1e18);
        MORPHO.supplyCollateral(params, 1e18, sender, "");
        uint256 liquidity = vault.withdrawable();
        MORPHO.borrow(params, liquidity, 0, sender, sender);

        (uint256 requestId, uint256 assets, bool paidAtOnce) = vault.requestRedeem(shares, sender);
        vm.stopBroadcast();

        require(!paidAtOnce, "expected the request to queue");
        console2.log("borrowed (USDC units)", liquidity);
        console2.log("queued request id    ", requestId);
        console2.log("queued assets        ", assets);
    }
}

contract RepayLoan is LiveBase {
    function run() external {
        require(block.chainid == 84532, "run on Base Sepolia");
        QueueVault vault = _vault();
        MarketParams memory params = vault.marketParams();
        uint256 amount = _amount();

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        USDC.approve(address(MORPHO), amount);
        MORPHO.repay(params, amount, 0, sender, "");
        vm.stopBroadcast();
        console2.log("repaid (USDC units)", amount);
    }
}
