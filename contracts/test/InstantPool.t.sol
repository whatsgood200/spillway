// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {BaseTest} from "./Base.t.sol";
import {InstantPool} from "../src/InstantPool.sol";
import {QueueVault} from "../src/QueueVault.sol";

contract InstantPoolTest is BaseTest {
    function _cashOut(address who, uint256 shares, uint256 minReceive) internal returns (uint256 received) {
        vm.startPrank(who);
        vault.approve(address(pool), shares);
        received = pool.cashOut(shares, minReceive, who);
        vm.stopPrank();
    }

    function test_cashOutPaysNowAndPoolTakesThePlace() public {
        _fundPool(10_000 * USDC);
        uint256 shares = _deposit(ana, 1_000 * USDC);
        _borrowAll();

        (uint256 quoted, uint256 fee, uint256 bps, bool available) = pool.quote(1_000 * USDC);
        assertTrue(available);
        uint256 received = _cashOut(ana, shares, quoted);

        assertEq(received, quoted, "the seller gets exactly the quote");
        assertEq(usdc.balanceOf(ana), 1_000 * USDC - fee);
        assertEq(vault.pendingAssets(address(pool)), 1_000 * USDC);
        assertEq(vault.queueLength(), 1);
        assertGe(bps, pool.MIN_FEE_BPS());
        assertLe(bps, pool.MAX_FEE_BPS());
        assertEq(pool.totalAssets(), 10_000 * USDC + fee, "the fee is the providers' gain, booked at once");
    }

    function test_settlementReturnsFullAmountToThePool() public {
        _fundPool(10_000 * USDC);
        uint256 shares = _deposit(ana, 1_000 * USDC);
        _borrowAll();
        uint256 received = _cashOut(ana, shares, 0);
        uint256 fee = 1_000 * USDC - received;

        _repay(1_000 * USDC);
        vault.settle(5);

        assertEq(pool.idle(), 10_000 * USDC + fee);
        assertEq(vault.pendingAssets(address(pool)), 0);
        assertGt(pool.convertToAssets(pool.balanceOf(lp)), 10_000 * USDC, "providers earned the fee");
    }

    function test_cashOutPassesThroughWithNoFeeWhenVaultIsLiquid() public {
        _fundPool(10_000 * USDC);
        uint256 shares = _deposit(ana, 1_000 * USDC);
        uint256 received = _cashOut(ana, shares, 1_000 * USDC);
        assertEq(received, 1_000 * USDC);
        assertEq(pool.idle(), 10_000 * USDC, "the pool neither gained nor lost");
        assertEq(vault.queueLength(), 0);
    }

    function test_buyClaimForSomeoneAlreadyWaiting() public {
        _fundPool(10_000 * USDC);
        uint256 shares = _deposit(ana, 1_000 * USDC);
        _borrowAll();
        (uint256 id,,) = _request(ana, shares);

        vm.startPrank(ana);
        vm.expectRevert(QueueVault.NotClaimOwnerOrApproved.selector);
        pool.buyClaim(id, 0, ana);
        vault.approveClaim(id, address(pool));
        uint256 received = pool.buyClaim(id, 0, ana);
        vm.stopPrank();

        assertEq(usdc.balanceOf(ana), received);
        (address owner,) = vault.requests(id);
        assertEq(owner, address(pool));
    }

    function test_onlyTheOwnerCanSellAPlace() public {
        _fundPool(10_000 * USDC);
        uint256 shares = _deposit(ana, 1_000 * USDC);
        _borrowAll();
        (uint256 id,,) = _request(ana, shares);
        vm.prank(ana);
        vault.approveClaim(id, address(pool));

        vm.prank(ben);
        vm.expectRevert(InstantPool.NotClaimOwner.selector);
        pool.buyClaim(id, 0, ben);
    }

    function test_minReceiveProtectsTheSeller() public {
        _fundPool(10_000 * USDC);
        uint256 shares = _deposit(ana, 1_000 * USDC);
        _borrowAll();
        (uint256 quoted,,,) = pool.quote(1_000 * USDC);

        vm.startPrank(ana);
        vault.approve(address(pool), shares);
        vm.expectRevert(abi.encodeWithSelector(InstantPool.ReceiveBelowMinimum.selector, quoted, quoted + 1));
        pool.cashOut(shares, quoted + 1, ana);
        vm.stopPrank();
    }

    function test_revertsWhenThePoolLacksCash() public {
        _fundPool(100 * USDC);
        uint256 shares = _deposit(ana, 1_000 * USDC);
        _borrowAll();
        vm.startPrank(ana);
        vault.approve(address(pool), shares);
        vm.expectPartialRevert(InstantPool.NotEnoughCash.selector);
        pool.cashOut(shares, 0, ana);
        vm.stopPrank();
        (,,, bool available) = pool.quote(1_000 * USDC);
        assertFalse(available);
    }

    function test_feeRisesAsThePoolDrains() public {
        _fundPool(10_000 * USDC);
        uint256 small = pool.feeBps(100 * USDC);
        uint256 large = pool.feeBps(9_000 * USDC);
        assertLt(small, large);
        assertEq(pool.feeBps(10_000 * USDC), pool.MAX_FEE_BPS());
    }

    function test_providersCanOnlyTakeOutCash() public {
        _fundPool(1_000 * USDC);
        uint256 shares = _deposit(ana, 900 * USDC);
        _borrowAll();
        _cashOut(ana, shares, 0);

        uint256 cash = pool.idle();
        assertEq(pool.maxWithdraw(lp), cash);
        vm.startPrank(lp);
        vm.expectRevert();
        pool.withdraw(cash + 1, lp, lp);
        pool.withdraw(cash, lp, lp);
        vm.stopPrank();
        assertEq(pool.idle(), 0);
    }

    function testFuzz_feeStaysWithinBounds(uint96 deposited, uint96 sold) public {
        uint256 depositAmount = bound(deposited, USDC, 1e13);
        uint256 assets = bound(sold, USDC, 1e13);
        _fundPool(depositAmount);
        (uint256 receiveAmount, uint256 fee, uint256 bps,) = pool.quote(assets);
        assertGe(bps, pool.MIN_FEE_BPS());
        assertLe(bps, pool.MAX_FEE_BPS());
        assertEq(receiveAmount + fee, assets);
    }

    /// The seller always receives the quote, and the pool is always worth at least what it was before.
    function testFuzz_cashOutNeverLosesPoolValue(uint96 poolSize, uint96 exitSize) public {
        uint256 poolAmount = bound(poolSize, 1_000 * USDC, 1e12);
        uint256 exitAmount = bound(exitSize, 2 * USDC, poolAmount / 2);
        _fundPool(poolAmount);
        uint256 shares = _deposit(ana, exitAmount);
        _borrowAll();

        uint256 before = pool.totalAssets();
        uint256 received = _cashOut(ana, shares, 0);
        assertGe(pool.totalAssets(), before);
        assertLe(received, exitAmount);
        assertEq(usdc.balanceOf(ana), received);
    }
}
