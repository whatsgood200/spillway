// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
import {IMorpho, MarketParams, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {IOracle} from "morpho-blue/interfaces/IOracle.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SpikeCollateral is ERC20 {
    constructor() ERC20("Spike Collateral", "SPK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract SpikeOracle is IOracle {
    uint256 public price;

    constructor(uint256 price_) {
        price = price_;
    }
}

/// Spike: can we create a usable market on the deployed Morpho Blue on Base Sepolia,
/// drive it to 100 percent utilization, and see the Repay log carry the market id in topic 1.
/// Run: BASE_SEPOLIA_RPC=https://sepolia.base.org forge test --match-contract MorphoMarketSpike -vv
contract MorphoMarketSpike is Test {
    using MarketParamsLib for MarketParams;

    IMorpho constant MORPHO = IMorpho(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address constant ADAPTIVE_CURVE_IRM = 0x46415998764C29aB2a25CbeA6254146D50D22687;
    uint256 constant LLTV = 0.86e18;
    bytes32 constant REPAY_TOPIC0 = keccak256("Repay(bytes32,address,address,uint256,uint256)");

    address lender = makeAddr("lender");
    address borrower = makeAddr("borrower");
    MarketParams params;
    Id id;

    function setUp() public {
        vm.createSelectFork(vm.envString("BASE_SEPOLIA_RPC"));
        SpikeCollateral collateral = new SpikeCollateral();
        // 1 SPK (18 decimals) = 2,000 USDC (6 decimals): price = 2000 * 1e6 * 1e36 / 1e18.
        SpikeOracle oracle = new SpikeOracle(2000 * 1e6 * 1e36 / 1e18);
        params = MarketParams({
            loanToken: USDC,
            collateralToken: address(collateral),
            oracle: address(oracle),
            irm: ADAPTIVE_CURVE_IRM,
            lltv: LLTV
        });
        id = params.id();
        MORPHO.createMarket(params);

        deal(USDC, lender, 10_000e6);
        collateral.mint(borrower, 100e18);
        vm.startPrank(lender);
        IERC20(USDC).approve(address(MORPHO), type(uint256).max);
        MORPHO.supply(params, 10_000e6, 0, lender, "");
        vm.stopPrank();
        vm.startPrank(borrower);
        collateral.approve(address(MORPHO), type(uint256).max);
        IERC20(USDC).approve(address(MORPHO), type(uint256).max);
        MORPHO.supplyCollateral(params, 100e18, borrower, "");
        MORPHO.borrow(params, 10_000e6, 0, borrower, borrower);
        vm.stopPrank();
    }

    function test_fullyUtilizedMarketBlocksWithdrawal() public {
        vm.prank(lender);
        vm.expectRevert(bytes("insufficient liquidity"));
        MORPHO.withdraw(params, 1_000e6, 0, lender, lender);
    }

    function test_repayEmitsMarketIdInTopic1AndFreesLiquidity() public {
        vm.recordLogs();
        vm.prank(borrower);
        MORPHO.repay(params, 1_000e6, 0, borrower, "");
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(MORPHO) && logs[i].topics[0] == REPAY_TOPIC0) {
                assertEq(logs[i].topics[1], Id.unwrap(id), "topic 1 is the market id");
                (uint256 assets,) = abi.decode(logs[i].data, (uint256, uint256));
                assertEq(assets, 1_000e6, "repaid assets in data");
                found = true;
            }
        }
        assertTrue(found, "Repay log seen on the Morpho singleton");

        uint256 before = IERC20(USDC).balanceOf(lender);
        vm.prank(lender);
        MORPHO.withdraw(params, 1_000e6, 0, lender, lender);
        assertEq(IERC20(USDC).balanceOf(lender) - before, 1_000e6, "freed liquidity is withdrawable");
    }
}
