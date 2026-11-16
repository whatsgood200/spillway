// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams} from "morpho-blue/interfaces/IMorpho.sol";
import {QueueVault} from "../src/QueueVault.sol";
import {InstantPool} from "../src/InstantPool.sol";
import {MockMorpho, MockUSDC} from "./mocks/Mocks.sol";

/// @notice Random users deposit, queue, sell places, borrow, repay and settle in any order.
contract Handler is Test {
    MockUSDC public usdc;
    MockMorpho public morpho;
    MarketParams public params;
    QueueVault public vault;
    InstantPool public pool;
    address[] public actors;
    address public borrower = makeAddr("borrower");

    uint256 public minted;
    uint256 public requestedAssets;
    uint256 public settledCount;
    uint256 public highestHead = 1;

    constructor(MockUSDC usdc_, MockMorpho morpho_, MarketParams memory params_, QueueVault vault_, InstantPool pool_) {
        usdc = usdc_;
        morpho = morpho_;
        params = params_;
        vault = vault_;
        pool = pool_;
        for (uint256 i; i < 4; i++) {
            actors.push(makeAddr(string(abi.encodePacked("actor", vm.toString(i)))));
        }
        vm.prank(borrower);
        usdc.approve(address(morpho), type(uint256).max);
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _mint(address to, uint256 amount) private {
        usdc.mint(to, amount);
        minted += amount;
    }

    function deposit(uint256 actorSeed, uint256 amount) external {
        address actor = actors[actorSeed % actors.length];
        amount = bound(amount, 1e6, 1e11);
        _mint(actor, amount);
        vm.startPrank(actor);
        usdc.approve(address(vault), amount);
        vault.deposit(amount, actor);
        vm.stopPrank();
    }

    function fundPool(uint256 actorSeed, uint256 amount) external {
        address actor = actors[actorSeed % actors.length];
        amount = bound(amount, 1e6, 1e11);
        _mint(actor, amount);
        vm.startPrank(actor);
        usdc.approve(address(pool), amount);
        pool.deposit(amount, actor);
        vm.stopPrank();
    }

    function requestRedeem(uint256 actorSeed, uint256 fraction) external {
        address actor = actors[actorSeed % actors.length];
        uint256 shares = (vault.balanceOf(actor) * bound(fraction, 1, 100)) / 100;
        if (vault.previewRedeem(shares) < vault.MIN_REQUEST()) return;
        vm.prank(actor);
        (, uint256 assets,) = vault.requestRedeem(shares, actor);
        requestedAssets += assets;
    }

    function cashOut(uint256 actorSeed, uint256 fraction) external {
        address actor = actors[actorSeed % actors.length];
        uint256 shares = (vault.balanceOf(actor) * bound(fraction, 1, 100)) / 100;
        uint256 assets = vault.previewRedeem(shares);
        if (assets < vault.MIN_REQUEST()) return;
        (uint256 receiveAmount,,, bool available) = pool.quote(assets);
        if (!available && (vault.queueLength() != 0 || vault.withdrawable() < assets)) return;
        vm.startPrank(actor);
        vault.approve(address(pool), shares);
        uint256 received = pool.cashOut(shares, 0, actor);
        vm.stopPrank();
        assertGe(received, receiveAmount, "the seller never gets less than the quote");
    }

    function borrow(uint256 fraction) external {
        uint256 amount = (vault.withdrawable() * bound(fraction, 1, 100)) / 100;
        if (amount == 0) return;
        vm.prank(borrower);
        morpho.borrow(params, amount, 0, borrower, borrower);
    }

    function repay(uint256 fraction) external {
        uint256 owed = morpho.market(vault.MARKET_ID()).totalBorrowAssets;
        uint256 amount = (owed * bound(fraction, 1, 100)) / 100;
        uint256 held = usdc.balanceOf(borrower);
        if (amount > held) amount = held;
        if (amount == 0) return;
        vm.prank(borrower);
        morpho.repay(params, amount, 0, borrower, "");
    }

    function settle(uint256 maxItems) external {
        uint256 headBefore = vault.head();
        (uint256 settled,,) = vault.settle(bound(maxItems, 1, 5));
        settledCount += settled;
        assertEq(vault.head(), headBefore + settled, "settle only ever advances the front of the queue");
        highestHead = vault.head();
    }
}

contract InvariantsTest is Test {
    MockUSDC internal usdc;
    MockMorpho internal morpho;
    QueueVault internal vault;
    InstantPool internal pool;
    Handler internal handler;

    function setUp() public {
        usdc = new MockUSDC();
        morpho = new MockMorpho();
        MarketParams memory params = MarketParams({
            loanToken: address(usdc),
            collateralToken: makeAddr("collateral"),
            oracle: makeAddr("oracle"),
            irm: makeAddr("irm"),
            lltv: 0.86e18
        });
        morpho.createMarket(params);
        vault = new QueueVault(IERC20(address(usdc)), IMorpho(address(morpho)), params, "Spillway USDC", "spUSDC");
        pool = new InstantPool(vault, "Spillway Pool", "spPOOL");
        handler = new Handler(usdc, morpho, params, vault, pool);
        targetContract(address(handler));
    }

    /// The vault's record of what it owes equals what is still owed to the requests actually in the queue.
    /// Only the front request may be part paid; everyone behind it is untouched.
    function invariant_queuedAssetsMatchesTheQueue() public view {
        uint256 sum;
        for (uint256 id = vault.head(); id < vault.nextRequestId(); id++) {
            (address owner,, uint256 assets, uint256 paid,,, uint64 settledAtMs,) = vault.requests(id);
            assertTrue(owner != address(0), "no holes in the queue");
            assertEq(settledAtMs, 0, "nothing in the queue is marked complete");
            assertLt(paid, assets, "nothing in the queue is fully paid");
            if (id != vault.head()) assertEq(paid, 0, "nobody behind the front is paid before it");
            sum += assets - paid;
        }
        assertEq(sum, vault.queuedAssets());
    }

    /// What each owner is owed adds up to the whole queue: no claim is lost or duplicated when places are sold.
    function invariant_pendingPerOwnerAddsUpToTheQueue() public view {
        uint256 sum = vault.pendingAssets(address(pool));
        for (uint256 i; i < handler.actorCount(); i++) {
            sum += vault.pendingAssets(handler.actors(i));
        }
        assertEq(sum, vault.queuedAssets());
    }

    /// Every test dollar is in exactly one place. Nothing is created or destroyed by the vault or the pool.
    function invariant_dollarsAreConserved() public view {
        uint256 sum = usdc.balanceOf(address(morpho)) + usdc.balanceOf(address(vault)) + usdc.balanceOf(address(pool))
            + usdc.balanceOf(handler.borrower());
        for (uint256 i; i < handler.actorCount(); i++) {
            sum += usdc.balanceOf(handler.actors(i));
        }
        assertEq(sum, handler.minted());
    }

    /// Everything in front of the queue is marked paid, exactly once, and the record of it is kept.
    function invariant_paidRequestsKeepTheirRecord() public view {
        for (uint256 id = 1; id < vault.head(); id++) {
            (address owner,, uint256 assets, uint256 paid, uint64 queuedAtMs,, uint64 settledAtMs,) = vault.requests(id);
            assertTrue(owner != address(0));
            assertGt(assets, 0);
            assertEq(paid, assets, "a completed request was paid exactly what it was owed");
            assertGe(settledAtMs, queuedAtMs);
            assertGt(settledAtMs, 0);
        }
    }

    /// The vault's Morpho position always covers what it owes the queue.
    function invariant_queueIsAlwaysBacked() public view {
        assertGe(vault.suppliedAssets() + 1e3, vault.queuedAssets());
    }

    /// The vault never sits on cash except payouts it is holding for a receiver who could not be paid.
    function invariant_vaultHoldsNoStrayCash() public view {
        assertEq(usdc.balanceOf(address(vault)), 0);
    }
}
