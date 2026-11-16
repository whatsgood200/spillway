// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {BaseTest} from "./Base.t.sol";
import {QueueVault} from "../src/QueueVault.sol";

contract QueueVaultTest is BaseTest {
    function test_depositGoesStraightToMorpho() public {
        uint256 shares = _deposit(ana, 1_000 * USDC);
        assertEq(usdc.balanceOf(address(vault)), 0, "vault keeps no idle cash");
        assertEq(usdc.balanceOf(address(morpho)), 1_000 * USDC);
        assertEq(vault.totalAssets(), 1_000 * USDC);
        assertEq(vault.convertToAssets(shares), 1_000 * USDC);
    }

    function test_paidAtOnceWhenLiquidAndNobodyWaits() public {
        uint256 shares = _deposit(ana, 1_000 * USDC);
        (uint256 id, uint256 assets, bool paidAtOnce) = _request(ana, shares);
        assertTrue(paidAtOnce);
        assertEq(id, 0);
        assertEq(assets, 1_000 * USDC);
        assertEq(usdc.balanceOf(ana), 1_000 * USDC);
        assertEq(vault.queueLength(), 0);
    }

    function test_queuesWhenFullyLentOut() public {
        uint256 shares = _deposit(ana, 1_000 * USDC);
        _borrowAll();
        (uint256 id, uint256 assets, bool paidAtOnce) = _request(ana, shares);
        assertFalse(paidAtOnce);
        assertEq(id, 1);
        assertEq(usdc.balanceOf(ana), 0);
        assertEq(vault.queuedAssets(), assets);
        assertEq(vault.pendingAssets(ana), assets);
        assertEq(vault.totalAssets(), 0, "queued assets leave the share price");
    }

    function test_settlePaysFirstInFirstOutAcrossTwoRepayments() public {
        uint256 anaShares = _deposit(ana, 1_000 * USDC);
        uint256 benShares = _deposit(ben, 600 * USDC);
        _borrowAll();
        _request(ana, anaShares);
        _request(ben, benShares);

        _repay(1_000 * USDC);
        (uint256 settled, bool more) = vault.settle(10);
        assertEq(settled, 1);
        assertFalse(more);
        assertEq(usdc.balanceOf(ana), 1_000 * USDC);
        assertEq(usdc.balanceOf(ben), 0);

        _repay(600 * USDC);
        (settled,) = vault.settle(10);
        assertEq(settled, 1);
        assertEq(usdc.balanceOf(ben), 600 * USDC);
        assertEq(vault.queueLength(), 0);
        assertEq(vault.queuedAssets(), 0);
    }

    function test_nobodyJumpsTheLine() public {
        uint256 anaShares = _deposit(ana, 1_000 * USDC);
        uint256 benShares = _deposit(ben, 100 * USDC);
        _borrowAll();
        _request(ana, anaShares);

        // 100 USDC comes back: enough for Ben, not for Ana who is first.
        _repay(100 * USDC);
        (, , bool paidAtOnce) = _request(ben, benShares);
        assertFalse(paidAtOnce, "a later request must queue while someone waits");

        (uint256 settled,) = vault.settle(10);
        assertEq(settled, 0, "the head is not covered, so nobody is paid");
        assertEq(usdc.balanceOf(ben), 0);
    }

    function test_settleIsBoundedAndReportsMore() public {
        uint256 a = _deposit(ana, 300 * USDC);
        uint256 b = _deposit(ben, 300 * USDC);
        uint256 c = _deposit(cy, 300 * USDC);
        _borrowAll();
        _request(ana, a);
        _request(ben, b);
        _request(cy, c);
        _repay(900 * USDC);

        (uint256 settled, bool more) = vault.settle(2);
        assertEq(settled, 2);
        assertTrue(more);
        (settled, more) = vault.settle(2);
        assertEq(settled, 1);
        assertFalse(more);
    }

    function test_anyoneCanSettleAndOnlyOwnersArePaid() public {
        uint256 shares = _deposit(ana, 500 * USDC);
        _borrowAll();
        _request(ana, shares);
        _repay(500 * USDC);

        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vault.settle(5);
        assertEq(usdc.balanceOf(ana), 500 * USDC);
        assertEq(usdc.balanceOf(stranger), 0);
    }

    function test_blockedReceiverDoesNotStallTheQueue() public {
        uint256 a = _deposit(ana, 400 * USDC);
        uint256 b = _deposit(ben, 400 * USDC);
        _borrowAll();
        _request(ana, a);
        _request(ben, b);
        usdc.setBlocked(ana, true);
        _repay(800 * USDC);

        (uint256 settled,) = vault.settle(10);
        assertEq(settled, 2);
        assertEq(usdc.balanceOf(ben), 400 * USDC, "the person behind is still paid");
        assertEq(vault.unpaid(ana), 400 * USDC);

        usdc.setBlocked(ana, false);
        vm.prank(ana);
        vault.claimUnpaid(ana);
        assertEq(usdc.balanceOf(ana), 400 * USDC);
        assertEq(vault.unpaid(ana), 0);
    }

    function test_claimUnpaidRevertsWhenNothingIsHeld() public {
        vm.prank(ana);
        vm.expectRevert(QueueVault.NothingUnpaid.selector);
        vault.claimUnpaid(ana);
    }

    function test_synchronousExitsAreDisabled() public {
        _deposit(ana, 100 * USDC);
        assertEq(vault.maxWithdraw(ana), 0);
        assertEq(vault.maxRedeem(ana), 0);
        vm.startPrank(ana);
        vm.expectRevert(QueueVault.SynchronousExitDisabled.selector);
        vault.withdraw(1, ana, ana);
        vm.expectRevert(QueueVault.SynchronousExitDisabled.selector);
        vault.redeem(1, ana, ana);
        vm.stopPrank();
    }

    function test_rejectsDustRequests() public {
        _deposit(ana, 100 * USDC);
        uint256 dustShares = vault.convertToShares(USDC / 2);
        vm.prank(ana);
        vm.expectRevert(abi.encodeWithSelector(QueueVault.RequestTooSmall.selector, USDC / 2, USDC));
        vault.requestRedeem(dustShares, ana);
    }

    function test_claimTransferNeedsOwnerOrApproval() public {
        uint256 shares = _deposit(ana, 500 * USDC);
        _borrowAll();
        (uint256 id,,) = _request(ana, shares);

        vm.prank(ben);
        vm.expectRevert(QueueVault.NotClaimOwnerOrApproved.selector);
        vault.transferClaim(id, ben);

        vm.prank(ben);
        vm.expectRevert(QueueVault.NotClaimOwnerOrApproved.selector);
        vault.approveClaim(id, ben);

        vm.prank(ana);
        vault.approveClaim(id, ben);
        vm.prank(ben);
        vault.transferClaim(id, cy);
        assertEq(vault.pendingAssets(ana), 0);
        assertEq(vault.pendingAssets(cy), 500 * USDC);
        assertEq(vault.claimApproval(id), address(0), "approval is single use");

        _repay(500 * USDC);
        vault.settle(5);
        assertEq(usdc.balanceOf(cy), 500 * USDC, "the new owner is paid");
    }

    function test_historyIsKeptOnChainAfterPayment() public {
        uint256 a = _deposit(ana, 300 * USDC);
        uint256 b = _deposit(ben, 200 * USDC);
        _borrowAll();
        vm.warp(1_000);
        _request(ana, a);
        _request(ben, b);
        vm.warp(1_060);
        vm.roll(block.number + 5);
        _repay(300 * USDC);
        vault.settle(5);

        QueueVault.Request[] memory page = vault.requestsSlice(1, 10);
        assertEq(page.length, 2);
        assertEq(page[0].owner, ana);
        assertEq(page[0].requester, ana);
        assertEq(page[0].assets, 300 * USDC);
        assertEq(page[0].queuedAtMs, 1_000_000);
        assertEq(page[0].settledAtMs, 1_060_000);
        assertEq(page[0].settledBlock, block.number);
        assertEq(page[1].settledAtMs, 0, "Ben is still waiting");
        assertEq(vault.requestsSlice(2, 10).length, 1);
        assertEq(vault.requestsSlice(3, 10).length, 0);
        assertEq(vault.requestsSlice(0, 1).length, 1, "id 0 is treated as the first request");
    }

    function test_aPaidPlaceCannotBeTransferred() public {
        uint256 shares = _deposit(ana, 500 * USDC);
        _borrowAll();
        (uint256 id,,) = _request(ana, shares);
        _repay(500 * USDC);
        vault.settle(5);

        vm.prank(ana);
        vm.expectRevert(QueueVault.AlreadySettled.selector);
        vault.transferClaim(id, ben);
    }

    function test_transferOfUnknownRequestReverts() public {
        vm.expectRevert(QueueVault.UnknownRequest.selector);
        vault.transferClaim(99, ana);
    }

    function test_interestAfterQueueingGoesToThoseWhoStay() public {
        uint256 anaShares = _deposit(ana, 1_000 * USDC);
        uint256 benShares = _deposit(ben, 1_000 * USDC);
        _borrowAll();
        (, uint256 anaAssets,) = _request(ana, anaShares);
        morpho.addInterest(params, uint128(100 * USDC));

        assertEq(anaAssets, 1_000 * USDC, "a queued request is fixed in assets");
        assertApproxEqAbs(vault.convertToAssets(benShares), 1_100 * USDC, 2, "Ben, who stayed, earns the interest");
    }

    function test_queueSliceListsFrontFirst() public {
        uint256 a = _deposit(ana, 300 * USDC);
        uint256 b = _deposit(ben, 200 * USDC);
        _borrowAll();
        _request(ana, a);
        _request(ben, b);
        (uint256[] memory ids, address[] memory owners, uint256[] memory amounts) = vault.queueSlice(0, 10);
        assertEq(ids.length, 2);
        assertEq(owners[0], ana);
        assertEq(owners[1], ben);
        assertEq(amounts[1], 200 * USDC);
        (ids,,) = vault.queueSlice(5, 10);
        assertEq(ids.length, 0);
    }

    /// Whatever the amounts, a repayment that covers the whole queue pays every request exactly.
    function testFuzz_fullRepaymentPaysEveryoneExactly(uint96 first, uint96 second, uint96 third) public {
        uint256[3] memory amounts = [bound(first, 2 * USDC, 1e12), bound(second, 2 * USDC, 1e12), bound(third, 2 * USDC, 1e12)];
        address[3] memory people = [ana, ben, cy];
        uint256[3] memory shares;
        for (uint256 i; i < 3; i++) {
            shares[i] = _deposit(people[i], amounts[i]);
        }
        _borrowAll();
        uint256[3] memory owed;
        for (uint256 i; i < 3; i++) {
            (, owed[i],) = _request(people[i], shares[i]);
        }
        _repay(owed[0] + owed[1] + owed[2]);
        (uint256 settled, bool more) = vault.settle(10);

        assertEq(settled, 3);
        assertFalse(more);
        for (uint256 i; i < 3; i++) {
            assertEq(usdc.balanceOf(people[i]), owed[i]);
            assertLe(owed[i], amounts[i], "nobody gets more than they put in without interest");
            assertGe(owed[i] + 1, amounts[i], "rounding costs at most one unit");
        }
        assertEq(vault.queuedAssets(), 0);
    }

    /// A partial repayment pays a prefix of the queue and never skips ahead.
    function testFuzz_partialRepaymentPaysOnlyAPrefix(uint96 repaid) public {
        uint256[3] memory amounts = [uint256(500 * USDC), 300 * USDC, 200 * USDC];
        address[3] memory people = [ana, ben, cy];
        for (uint256 i; i < 3; i++) {
            uint256 shares = _deposit(people[i], amounts[i]);
            if (i == 2) _borrowAll();
            if (i == 2) {
                _request(ana, vault.balanceOf(ana));
                _request(ben, vault.balanceOf(ben));
                _request(cy, shares);
            }
        }
        uint256 amount = bound(repaid, 1, 1_000 * USDC);
        _repay(amount);
        vault.settle(10);

        bool anaPaid = usdc.balanceOf(ana) > 0;
        bool benPaid = usdc.balanceOf(ben) > 0;
        bool cyPaid = usdc.balanceOf(cy) > 0;
        assertEq(anaPaid, amount >= 500 * USDC);
        assertEq(benPaid, amount >= 800 * USDC);
        assertEq(cyPaid, amount >= 1_000 * USDC);
        if (benPaid) assertTrue(anaPaid);
        if (cyPaid) assertTrue(benPaid);
    }
}
