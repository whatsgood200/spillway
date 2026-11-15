// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {IOracle} from "morpho-blue/interfaces/IOracle.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {QueueVault} from "../../src/QueueVault.sol";
import {InstantPool} from "../../src/InstantPool.sol";
import {QueueReactor} from "../../src/QueueReactor.sol";
import {SpillwayCallback} from "../../src/SpillwayCallback.sol";
import {MsClock} from "../../src/libraries/MsClock.sol";
import {MockSystem} from "../mocks/Mocks.sol";

contract ForkCollateral is ERC20 {
    constructor() ERC20("Spillway Demo Collateral", "sdCOL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract ForkOracle is IOracle {
    uint256 public price = 2000 * 1e6 * 1e36 / 1e18;
}

/// @notice The same flows as the unit tests, against the Morpho Blue contract deployed on Base Sepolia, with its
/// real interest rate model and real USDC. Skipped when BASE_SEPOLIA_RPC is not set.
/// Run: BASE_SEPOLIA_RPC=https://sepolia.base.org forge test --match-path "test/fork/*" -vv
contract MorphoBlueForkTest is Test {
    using MarketParamsLib for MarketParams;

    IMorpho internal constant MORPHO = IMorpho(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    address internal constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address internal constant ADAPTIVE_CURVE_IRM = 0x46415998764C29aB2a25CbeA6254146D50D22687;
    address internal constant CALLBACK_PROXY = 0x476F44b11F5C942c58f4c8E3d0300E5710743585;
    address internal constant SYSTEM = 0x8888888888888888888888888888888888888888;

    MarketParams internal params;
    QueueVault internal vault;
    InstantPool internal pool;
    ForkCollateral internal collateral;

    address internal ana = makeAddr("ana");
    address internal ben = makeAddr("ben");
    address internal lp = makeAddr("lp");
    address internal borrower = makeAddr("borrower");

    function setUp() public {
        string memory rpc = vm.envOr("BASE_SEPOLIA_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);

        collateral = new ForkCollateral();
        params = MarketParams({
            loanToken: USDC,
            collateralToken: address(collateral),
            oracle: address(new ForkOracle()),
            irm: ADAPTIVE_CURVE_IRM,
            lltv: 0.86e18
        });
        MORPHO.createMarket(params);
        vault = new QueueVault(IERC20(USDC), MORPHO, params, "Spillway USDC", "spUSDC");
        pool = new InstantPool(vault, "Spillway Pool", "spPOOL");

        collateral.mint(borrower, 1_000e18);
        vm.startPrank(borrower);
        collateral.approve(address(MORPHO), type(uint256).max);
        IERC20(USDC).approve(address(MORPHO), type(uint256).max);
        MORPHO.supplyCollateral(params, 1_000e18, borrower, "");
        vm.stopPrank();
    }

    function _deposit(address who, uint256 assets) internal returns (uint256 shares) {
        deal(USDC, who, assets);
        vm.startPrank(who);
        IERC20(USDC).approve(address(vault), assets);
        shares = vault.deposit(assets, who);
        vm.stopPrank();
    }

    function _borrowAll() internal {
        uint256 amount = vault.withdrawable();
        vm.prank(borrower);
        MORPHO.borrow(params, amount, 0, borrower, borrower);
    }

    function _repay(uint256 assets) internal {
        deal(USDC, borrower, assets);
        vm.prank(borrower);
        MORPHO.repay(params, assets, 0, borrower, "");
    }

    function test_fork_queueSettlesOnRealMorpho() public {
        uint256 anaShares = _deposit(ana, 5_000e6);
        uint256 benShares = _deposit(ben, 3_000e6);
        _borrowAll();
        assertEq(vault.withdrawable(), 0, "the market is 100 percent lent out");

        vm.prank(ana);
        (uint256 anaId, uint256 anaAssets, bool paidAtOnce) = vault.requestRedeem(anaShares, ana);
        assertFalse(paidAtOnce);
        assertEq(anaId, 1);
        vm.prank(ben);
        (, uint256 benAssets,) = vault.requestRedeem(benShares, ben);

        _repay(anaAssets);
        (uint256 settled, bool more) = vault.settle(10);
        assertEq(settled, 1);
        assertFalse(more);
        assertEq(IERC20(USDC).balanceOf(ana), anaAssets);
        assertEq(IERC20(USDC).balanceOf(ben), 0);

        // Time passes and real interest accrues before Ben is repaid.
        skip(1 days);
        _repay(benAssets);
        (settled,) = vault.settle(10);
        assertEq(settled, 1);
        assertEq(IERC20(USDC).balanceOf(ben), benAssets);
        assertEq(vault.queuedAssets(), 0);
    }

    function test_fork_poolBuysAPlaceAndIsRepaid() public {
        deal(USDC, lp, 20_000e6);
        vm.startPrank(lp);
        IERC20(USDC).approve(address(pool), 20_000e6);
        pool.deposit(20_000e6, lp);
        vm.stopPrank();

        uint256 shares = _deposit(ana, 2_000e6);
        _borrowAll();
        vm.startPrank(ana);
        vault.approve(address(pool), shares);
        uint256 received = pool.cashOut(shares, 0, ana);
        vm.stopPrank();

        uint256 owed = vault.pendingAssets(address(pool));
        assertEq(IERC20(USDC).balanceOf(ana), received);
        assertLt(received, owed);
        assertGe(received, owed - (owed * pool.MAX_FEE_BPS()) / 10_000);

        _repay(owed);
        vault.settle(5);
        assertEq(pool.idle(), 20_000e6 - received + owed);
        assertGt(pool.convertToAssets(pool.balanceOf(lp)), 20_000e6);
    }

    function test_fork_reactorTopicsMatchRealMorphoLogs() public {
        vm.etch(SYSTEM, address(new MockSystem()).code);
        QueueReactor reactor = new QueueReactor(block.chainid, address(MORPHO), Id.unwrap(params.id()), address(vault), 1_000_000, 5);

        vm.recordLogs();
        _deposit(ana, 1_000e6);
        _borrowAll();
        _repay(400e6);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool sawSupply;
        bool sawRepay;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(MORPHO)) continue;
            uint256 topic0 = uint256(logs[i].topics[0]);
            if (topic0 == reactor.SUPPLY_TOPIC() || topic0 == reactor.REPAY_TOPIC()) {
                assertEq(uint256(logs[i].topics[1]), reactor.MARKET_ID(), "topic 1 carries the market id");
                if (topic0 == reactor.SUPPLY_TOPIC()) sawSupply = true;
                if (topic0 == reactor.REPAY_TOPIC()) sawRepay = true;
            }
        }
        assertTrue(sawSupply && sawRepay, "the reactor's subscriptions match what Morpho really emits");
    }

    function test_fork_callbackSettlesThroughTheRealProxyAddress() public {
        address reactorAddress = makeAddr("reactor on lasna");
        SpillwayCallback callback = new SpillwayCallback(IPayable(payable(CALLBACK_PROXY)), reactorAddress, vault);

        uint256 shares = _deposit(ana, 1_500e6);
        _borrowAll();
        vm.prank(ana);
        (, uint256 owed,) = vault.requestRedeem(shares, ana);
        _repay(owed);

        vm.expectEmit(true, false, false, false, address(callback));
        emit SpillwayCallback.LoopClosed(0xbeef, 0, 0, 0, false);
        vm.prank(CALLBACK_PROXY);
        callback.settle(reactorAddress, 0xbeef, block.number, 5);
        assertEq(IERC20(USDC).balanceOf(ana), owed);
    }

    function test_fork_millisecondClockIsLive() public view {
        uint256 ms = MsClock.nowMs();
        assertGe(ms, block.timestamp * 1000);
        assertLt(ms, (block.timestamp + 1) * 1000, "the BaseTime predeploy answers within the current second");
    }
}
