// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Test.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";
import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";
import {AbstractPayer} from "@reactive/src/base/AbstractPayer.sol";
import {MarketParams, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {BaseTest} from "./Base.t.sol";
import {QueueReactor} from "../src/QueueReactor.sol";
import {SpillwayCallback} from "../src/SpillwayCallback.sol";
import {MockSystem, MockCallbackProxy} from "./mocks/Mocks.sol";

/// @notice The reactive contract and the callback receiver, driven the way Reactive Network drives them:
/// origin logs are fed to `react()` from the system contract address, and the callback it requests is delivered
/// through a proxy that overwrites the first argument. The simulation feeds every log to `react()`, unfiltered,
/// so these tests also show the contract ignores what its subscriptions are meant to exclude.
contract ReactiveLoopTest is BaseTest {
    using MarketParamsLib for MarketParams;

    address internal constant SYSTEM = 0x8888888888888888888888888888888888888888;
    uint256 internal constant ORIGIN_CHAIN = 84532;
    uint64 internal constant GAS_LIMIT = 1_000_000;
    uint256 internal constant MAX_ITEMS = 2;

    MockSystem internal system;
    MockCallbackProxy internal proxy;
    QueueReactor internal reactor;
    SpillwayCallback internal callback;
    uint256 internal marketId;
    address internal stranger = makeAddr("stranger");

    function setUp() public override {
        super.setUp();
        vm.etch(SYSTEM, address(new MockSystem()).code);
        system = MockSystem(payable(SYSTEM));
        proxy = new MockCallbackProxy();
        marketId = uint256(Id.unwrap(params.id()));

        address[] memory approved = new address[](1);
        approved[0] = borrower;
        reactor = new QueueReactor(ORIGIN_CHAIN, address(morpho), Id.unwrap(params.id()), approved, GAS_LIMIT, MAX_ITEMS);
        callback = new SpillwayCallback(IPayable(payable(address(proxy))), address(reactor), vault);
        reactor.setCallbackContract(address(callback));
    }

    receive() external payable {}

    // ------------------------------------------------------------ simulation

    /// @dev Replays every log recorded on the "origin chain" into the reactor, delivers any callbacks it asked
    /// for, and repeats until the system is quiet. Returns how many callbacks were delivered.
    function _runReactiveNetwork() internal returns (uint256 delivered) {
        uint256 next = system.callbackCount();
        for (uint256 round; round < 12; round++) {
            Vm.Log[] memory logs = vm.getRecordedLogs();
            if (logs.length == 0) break;
            for (uint256 i; i < logs.length; i++) {
                if (logs[i].topics.length == 0) continue;
                vm.prank(SYSTEM);
                reactor.react(_record(logs[i], uint256(keccak256(abi.encode("origin tx", round, i)))));
            }
            uint256 count = system.callbackCount();
            for (; next < count; next++) {
                ISystemContract.CallbackConfiguration_V_1_0 memory config = system.callbackAt(next);
                (bool ok,) = proxy.deliver(address(reactor), config.recipient, config.payload);
                assertTrue(ok, "callback delivery reverted");
                delivered++;
            }
        }
    }

    function _record(Vm.Log memory entry, uint256 txHash) internal view returns (IReactive.LogRecord memory) {
        return IReactive.LogRecord({
            chainId: ORIGIN_CHAIN,
            contractAddress: entry.emitter,
            topic0: uint256(entry.topics[0]),
            topic1: entry.topics.length > 1 ? uint256(entry.topics[1]) : 0,
            topic2: entry.topics.length > 2 ? uint256(entry.topics[2]) : 0,
            topic3: entry.topics.length > 3 ? uint256(entry.topics[3]) : 0,
            data: entry.data,
            blockNumber: block.number,
            opCode: 0,
            blockHash: 0,
            txHash: txHash,
            logIndex: 0
        });
    }

    /// @dev A Morpho Repay log as Morpho emits it: market, caller, borrower.
    function _repayLog(address caller, address onBehalf, uint256 txHash) internal view returns (IReactive.LogRecord memory) {
        return IReactive.LogRecord({
            chainId: ORIGIN_CHAIN,
            contractAddress: address(morpho),
            topic0: reactor.REPAY_TOPIC(),
            topic1: marketId,
            topic2: uint256(uint160(caller)),
            topic3: uint256(uint160(onBehalf)),
            data: abi.encode(uint256(1), uint256(1)),
            blockNumber: 1234,
            opCode: 0,
            blockHash: 0,
            txHash: txHash,
            logIndex: 0
        });
    }

    function _loopClosedLog(uint256 originTx, bool more) internal view returns (IReactive.LogRecord memory) {
        return IReactive.LogRecord({
            chainId: ORIGIN_CHAIN,
            contractAddress: address(callback),
            topic0: reactor.LOOP_CLOSED_TOPIC(),
            topic1: originTx,
            topic2: 0,
            topic3: 0,
            data: abi.encode(uint256(1234), uint256(1), uint256(0), more),
            blockNumber: 1300,
            opCode: 0,
            blockHash: 0,
            txHash: 0xc105ed,
            logIndex: 0
        });
    }

    function _react(IReactive.LogRecord memory record) internal {
        vm.prank(SYSTEM);
        reactor.react(record);
    }

    // ---------------------------------------------------- subscriptions (F2)

    function test_subscribesOnlyToApprovedBorrowersAndTheCallback() public view {
        assertEq(system.activeSubscriptionCount(), 3, "repay and liquidate for one borrower, plus the callback");
        uint256 who = uint256(uint160(borrower));

        (uint256 chainId, address emitter, uint256 t0, uint256 t1, uint256 t2, uint256 t3,) = system.subscriptions(0);
        assertEq(chainId, ORIGIN_CHAIN);
        assertEq(emitter, address(morpho));
        assertEq(t0, reactor.REPAY_TOPIC());
        assertEq(t1, marketId);
        assertEq(t2, who, "the repayment must be sent by the borrower");
        assertEq(t3, who, "and repay the borrower's own loan");

        (,, t0, t1,, t3,) = system.subscriptions(1);
        assertEq(t0, reactor.LIQUIDATE_TOPIC());
        assertEq(t1, marketId);
        assertEq(t3, who);

        (, emitter, t0,,,,) = system.subscriptions(2);
        assertEq(emitter, address(callback));
        assertEq(t0, reactor.LOOP_CLOSED_TOPIC());
    }

    function test_noSubscriptionAnyStrangerCanTrigger() public view {
        for (uint256 i; i < system.subscriptionCount(); i++) {
            (,, uint256 t0,,,,) = system.subscriptions(i);
            assertTrue(t0 != uint256(keccak256("Supply(bytes32,address,address,uint256,uint256)")), "no Supply subscription");
        }
    }

    // ------------------------------------------------------- attacks on F2

    function test_strangerRepayingOnOurBorrowersBehalfTriggersNothing() public {
        uint256 shares = _deposit(ana, 500 * USDC);
        _borrowAll();
        _request(ana, shares);

        usdc.mint(stranger, 1);
        vm.startPrank(stranger);
        usdc.approve(address(morpho), 1);
        vm.recordLogs();
        morpho.repay(params, 1, 0, borrower, "");
        vm.stopPrank();

        assertEq(_runReactiveNetwork(), 0, "a 1 wei repayment by a stranger costs us nothing");
        assertFalse(reactor.inFlight());
    }

    function test_strangerSupplyTriggersNothing() public {
        uint256 shares = _deposit(ana, 500 * USDC);
        _borrowAll();
        _request(ana, shares);

        usdc.mint(stranger, 1);
        vm.startPrank(stranger);
        usdc.approve(address(morpho), 1);
        vm.recordLogs();
        morpho.supply(params, 1, 0, stranger, "");
        vm.stopPrank();
        assertEq(_runReactiveNetwork(), 0);
    }

    function test_unapprovedBorrowerTriggersNothing() public {
        _react(_repayLog(stranger, stranger, 0xbad));
        assertEq(system.callbackCount(), 0);
    }

    function test_strangerCyclingDepositsAndRequestsTriggersNothing() public {
        uint256 shares = _deposit(ana, 500 * USDC);
        _borrowAll();
        _request(ana, shares);
        vm.recordLogs();
        for (uint256 i; i < 5; i++) {
            uint256 s = _deposit(stranger, 2 * USDC);
            vm.prank(stranger);
            vault.requestRedeem(s, stranger);
        }
        assertEq(_runReactiveNetwork(), 0, "the reactor does not watch the vault at all");
    }

    function test_onlyTheSystemContractCanCallReact() public {
        IReactive.LogRecord memory record = _repayLog(borrower, borrower, 1);
        vm.expectPartialRevert(AbstractPayer.NotAuthorized.selector);
        reactor.react(record);
    }

    // ---------------------------------------------------- in-flight (F2, F5)

    function test_oneCallbackInFlightAtATime() public {
        _react(_repayLog(borrower, borrower, 0xa1));
        _react(_repayLog(borrower, borrower, 0xa2));
        _react(_repayLog(borrower, borrower, 0xa3));
        assertEq(system.callbackCount(), 1, "later repayments wait for the one in flight");
        assertTrue(reactor.missedWhileInFlight());
    }

    function test_aRepaymentDuringAFlightIsPaidWhenTheFlightReportsBack() public {
        _react(_repayLog(borrower, borrower, 0xa1));
        _react(_repayLog(borrower, borrower, 0xa2));
        _react(_loopClosedLog(0xa1, false));
        assertEq(system.callbackCount(), 2, "the deferred repayment gets its own callback");
        ISystemContract.CallbackConfiguration_V_1_0 memory second = system.callbackAt(1);
        (, uint256 originTx,,) = abi.decode(_args(second.payload), (address, uint256, uint256, uint256));
        assertEq(originTx, 0xa2, "attributed to the repayment that waited");
        assertFalse(reactor.missedWhileInFlight());
    }

    function test_aLostCallbackIsGivenUpAfterTheTimeout() public {
        _react(_repayLog(borrower, borrower, 0xa1));
        skip(reactor.CALLBACK_TIMEOUT());
        _react(_repayLog(borrower, borrower, 0xa2));
        assertEq(system.callbackCount(), 2);
    }

    function test_loopClosedWithMoreAsksAgain() public {
        _react(_repayLog(borrower, borrower, 0xa1));
        _react(_loopClosedLog(0xa1, true));
        assertEq(system.callbackCount(), 2);
        _react(_loopClosedLog(0xa1, false));
        assertEq(system.callbackCount(), 2, "and stops when nothing more can be paid");
        assertFalse(reactor.inFlight());
    }

    // ---------------------------------------------------------------- pause

    function test_pauseDropsEverySubscriptionAndIgnoresEvents() public {
        reactor.pause();
        assertEq(system.activeSubscriptionCount(), 0, "nothing can reach the reactor while paused");
        _react(_repayLog(borrower, borrower, 0xa1));
        assertEq(system.callbackCount(), 0);

        reactor.resume();
        assertEq(system.activeSubscriptionCount(), 3);
        _react(_repayLog(borrower, borrower, 0xa2));
        assertEq(system.callbackCount(), 1);
    }

    function test_onlyTheDeployerCanPauseOrChangeBorrowers() public {
        vm.startPrank(stranger);
        vm.expectRevert(QueueReactor.NotDeployer.selector);
        reactor.pause();
        vm.expectRevert(QueueReactor.NotDeployer.selector);
        reactor.setBorrower(stranger, true);
        vm.expectRevert(QueueReactor.NotDeployer.selector);
        reactor.withdrawGasFunds(1);
        vm.stopPrank();
    }

    function test_removingABorrowerUnsubscribesIt() public {
        reactor.setBorrower(borrower, false);
        assertEq(system.activeSubscriptionCount(), 1, "only the callback subscription remains");
        _react(_repayLog(borrower, borrower, 0xa1));
        assertEq(system.callbackCount(), 0);
        reactor.setBorrower(borrower, true);
        assertEq(system.activeSubscriptionCount(), 3);
    }

    function test_callbackWiringIsSetOnceByTheDeployer() public {
        vm.expectRevert(QueueReactor.CallbackAlreadySet.selector);
        reactor.setCallbackContract(address(1));
    }

    function test_gasFundsGoBackOnlyToTheDeployer() public {
        vm.deal(address(callback), 1 ether);
        vm.deal(address(reactor), 1 ether);
        vm.prank(stranger);
        vm.expectRevert(SpillwayCallback.NotDeployer.selector);
        callback.withdrawGasFunds(1 ether);

        uint256 before = address(this).balance;
        callback.withdrawGasFunds(1 ether);
        reactor.withdrawGasFunds(0.4 ether);
        assertEq(address(this).balance - before, 1.4 ether);
    }

    // ------------------------------------------------------------- callback

    function test_callbackRejectsAnyoneButTheProxyAndTheReactor() public {
        vm.expectPartialRevert(AbstractPayer.NotAuthorized.selector);
        callback.settle(address(reactor), 1, 1, 5);

        bytes memory payload = abi.encodeWithSignature("settle(address,uint256,uint256,uint256)", address(0), 1, 1, 5);
        (bool ok, bytes memory out) = proxy.deliver(makeAddr("another reactor"), address(callback), payload);
        assertFalse(ok);
        assertEq(bytes4(out), AbstractCallback.CallbackNotAuthorized.selector);
    }

    // ------------------------------------------------------------ full loops

    function test_fullLoop_repaymentPaysTheQueueWithNoKeeper() public {
        uint256 shares = _deposit(ana, 1_000 * USDC);
        _borrowAll();
        vm.recordLogs();
        _request(ana, shares);
        assertEq(_runReactiveNetwork(), 0, "queueing alone triggers nothing");

        _repay(1_000 * USDC);
        assertEq(_runReactiveNetwork(), 1);
        assertEq(usdc.balanceOf(ana), 1_000 * USDC, "paid by the callback, with no settle call from anyone");
        assertFalse(reactor.inFlight(), "the flight closed when the callback reported back");
    }

    function test_fullLoop_continuesUntilTheQueueIsEmpty() public {
        address[5] memory people = [ana, ben, cy, makeAddr("dee"), makeAddr("eli")];
        uint256[5] memory shares;
        for (uint256 i; i < 5; i++) {
            shares[i] = _deposit(people[i], 200 * USDC);
        }
        _borrowAll();
        vm.recordLogs();
        for (uint256 i; i < 5; i++) {
            _request(people[i], shares[i]);
        }
        _repay(1_000 * USDC);
        assertEq(_runReactiveNetwork(), 3, "five requests at two per callback take three callbacks");
        for (uint256 i; i < 5; i++) {
            assertEq(usdc.balanceOf(people[i]), 200 * USDC);
        }
        assertEq(vault.queueLength(), 0);
    }

    function test_fullLoop_aPartialRepaymentPaysTheFrontInPart() public {
        uint256 shares = _deposit(ana, 1_000 * USDC);
        _borrowAll();
        _request(ana, shares);
        vm.recordLogs();
        _repay(250 * USDC);
        assertEq(_runReactiveNetwork(), 1);
        assertEq(usdc.balanceOf(ana), 250 * USDC);
        assertEq(callback.loopCount(), 1, "a part payment is a loop too");
        SpillwayCallback.Loop[] memory page = callback.loopsSlice(0, 1);
        assertEq(page[0].assets, 250 * USDC);
        assertEq(page[0].settled, 0);
    }

    function test_fullLoop_aDepositPaysTheQueueWithoutTheReactor() public {
        uint256 shares = _deposit(ana, 500 * USDC);
        _borrowAll();
        _request(ana, shares);
        vm.recordLogs();
        _deposit(ben, 500 * USDC);
        assertEq(_runReactiveNetwork(), 0, "no callback needed");
        assertEq(usdc.balanceOf(ana), 500 * USDC);
    }

    function test_fullLoop_poolIsRepaidAutomatically() public {
        _fundPool(5_000 * USDC);
        uint256 shares = _deposit(ana, 1_000 * USDC);
        _borrowAll();
        vm.startPrank(ana);
        vault.approve(address(pool), shares);
        uint256 received = pool.cashOut(shares, 0, ana);
        vm.stopPrank();

        vm.recordLogs();
        _repay(1_000 * USDC);
        assertEq(_runReactiveNetwork(), 1);
        assertEq(pool.idle(), 5_000 * USDC + (1_000 * USDC - received), "the pool got the full amount back");
    }

    function test_loopsAreRecordedOnChain() public {
        uint256 a = _deposit(ana, 300 * USDC);
        uint256 b = _deposit(ben, 200 * USDC);
        _borrowAll();
        _request(ana, a);
        _request(ben, b);
        _repay(500 * USDC);

        bytes memory payload = abi.encodeWithSignature("settle(address,uint256,uint256,uint256)", address(0), uint256(0xfeed), uint256(77), uint256(5));
        (bool ok,) = proxy.deliver(address(reactor), address(callback), payload);
        assertTrue(ok);
        (ok,) = proxy.deliver(address(reactor), address(callback), payload);
        assertTrue(ok);

        assertEq(callback.loopCount(), 1, "a callback that paid nobody is not a loop");
        SpillwayCallback.Loop[] memory page = callback.loopsSlice(0, 10);
        assertEq(page[0].originTxHash, 0xfeed);
        assertEq(page[0].originBlock, 77);
        assertEq(page[0].settled, 2);
        assertEq(page[0].assets, 500 * USDC);
        assertEq(page[0].paidAtMs, block.timestamp * 1000);
    }

    /// @dev Strips the 4-byte selector so the payload's arguments can be decoded.
    function _args(bytes memory payload) internal pure returns (bytes memory args) {
        args = new bytes(payload.length - 4);
        for (uint256 i; i < args.length; i++) {
            args[i] = payload[i + 4];
        }
    }
}
