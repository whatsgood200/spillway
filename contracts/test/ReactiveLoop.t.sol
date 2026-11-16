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
/// through a proxy that overwrites the first argument.
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

    function setUp() public override {
        super.setUp();
        vm.etch(SYSTEM, address(new MockSystem()).code);
        system = MockSystem(payable(SYSTEM));
        proxy = new MockCallbackProxy();
        marketId = uint256(Id.unwrap(params.id()));

        reactor = new QueueReactor(ORIGIN_CHAIN, address(morpho), Id.unwrap(params.id()), address(vault), GAS_LIMIT, MAX_ITEMS);
        callback = new SpillwayCallback(IPayable(payable(address(proxy))), address(reactor), vault);
        reactor.setCallbackContract(address(callback));
    }

    // ------------------------------------------------------------ simulation

    /// @dev Replays every log recorded on the "origin chain" into the reactor, then delivers any callbacks it
    /// asked for, and repeats until the system is quiet. Returns how many callbacks were delivered.
    function _runReactiveNetwork() internal returns (uint256 delivered) {
        uint256 next = system.callbackCount();
        for (uint256 round; round < 10; round++) {
            Vm.Log[] memory logs = vm.getRecordedLogs();
            if (logs.length == 0) break;
            for (uint256 i; i < logs.length; i++) {
                Vm.Log memory entry = logs[i];
                if (entry.topics.length == 0) continue;
                IReactive.LogRecord memory record = IReactive.LogRecord({
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
                    txHash: uint256(keccak256(abi.encode("origin tx", round, i))),
                    logIndex: i
                });
                vm.prank(SYSTEM);
                reactor.react(record);
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

    function _log(address emitter, uint256 topic0, uint256 topic1, bytes memory data) internal view returns (IReactive.LogRecord memory) {
        return IReactive.LogRecord({
            chainId: ORIGIN_CHAIN,
            contractAddress: emitter,
            topic0: topic0,
            topic1: topic1,
            topic2: 0,
            topic3: 0,
            data: data,
            blockNumber: 1234,
            opCode: 0,
            blockHash: 0,
            txHash: 0xabc,
            logIndex: 0
        });
    }

    // ------------------------------------------------------------------ tests

    function test_subscribesToTheMarketTheVaultAndTheCallback() public view {
        assertEq(system.subscriptionCount(), 6);
        for (uint256 i; i < 3; i++) {
            (uint256 chainId, address emitter,, uint256 topic1) = system.subscriptions(i);
            assertEq(chainId, ORIGIN_CHAIN);
            assertEq(emitter, address(morpho));
            assertEq(topic1, marketId, "Morpho events are filtered to this market");
        }
        (, address vaultEmitter,,) = system.subscriptions(3);
        assertEq(vaultEmitter, address(vault));
        (, address callbackEmitter, uint256 topic0,) = system.subscriptions(5);
        assertEq(callbackEmitter, address(callback));
        assertEq(topic0, reactor.LOOP_CLOSED_TOPIC());
    }

    function test_eventTopicsMatchTheContractsThatEmitThem() public {
        uint256 shares = _deposit(ana, 500 * USDC);
        _borrowAll();
        vm.recordLogs();
        _request(ana, shares);
        _repay(500 * USDC);
        vault.settle(5);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool sawQueued;
        bool sawRepay;
        bool sawSettled;
        for (uint256 i; i < logs.length; i++) {
            uint256 topic0 = uint256(logs[i].topics[0]);
            if (logs[i].emitter == address(vault) && topic0 == reactor.QUEUED_TOPIC()) sawQueued = true;
            if (logs[i].emitter == address(vault) && topic0 == reactor.SETTLED_TOPIC()) sawSettled = true;
            if (logs[i].emitter == address(morpho) && topic0 == reactor.REPAY_TOPIC()) {
                sawRepay = true;
                assertEq(uint256(logs[i].topics[1]), marketId);
            }
        }
        assertTrue(sawQueued && sawRepay && sawSettled);
    }

    function test_onlyTheSystemContractCanCallReact() public {
        // Build the log first: a view call between expectRevert and react() would be the call that is checked.
        IReactive.LogRecord memory record = _log(address(vault), reactor.QUEUED_TOPIC(), 1, "");
        vm.expectPartialRevert(AbstractPayer.NotAuthorized.selector);
        reactor.react(record);
    }

    function test_idleVaultCostsNothing() public {
        IReactive.LogRecord memory record = _log(address(morpho), reactor.REPAY_TOPIC(), marketId, "");
        vm.prank(SYSTEM);
        reactor.react(record);
        assertEq(system.callbackCount(), 0, "nobody is waiting, so no callback is requested");
    }

    function test_requestsACallbackWhenLiquidityArrivesWhileSomeoneWaits() public {
        vm.startPrank(SYSTEM);
        reactor.react(_log(address(vault), reactor.QUEUED_TOPIC(), 1, ""));
        reactor.react(_log(address(morpho), reactor.REPAY_TOPIC(), marketId, ""));
        vm.stopPrank();

        assertEq(reactor.waiting(), 1);
        assertEq(system.callbackCount(), 1);
        ISystemContract.CallbackConfiguration_V_1_0 memory config = system.callbackAt(0);
        assertEq(config.chainId, ORIGIN_CHAIN);
        assertEq(config.recipient, address(callback));
        assertEq(config.gasLimit, GAS_LIMIT);
        assertEq(
            config.payload,
            abi.encodeWithSignature("settle(address,uint256,uint256,uint256)", address(0), uint256(0xabc), uint256(1234), MAX_ITEMS)
        );
    }

    function test_ignoresOtherMarketsOtherChainsAndOtherEvents() public {
        vm.startPrank(SYSTEM);
        reactor.react(_log(address(vault), reactor.QUEUED_TOPIC(), 1, ""));
        reactor.react(_log(address(morpho), reactor.REPAY_TOPIC(), marketId + 1, ""));
        reactor.react(_log(address(morpho), uint256(keccak256("Borrow(bytes32,address,address,address,uint256,uint256)")), marketId, ""));
        reactor.react(_log(makeAddr("other"), reactor.REPAY_TOPIC(), marketId, ""));
        IReactive.LogRecord memory otherChain = _log(address(morpho), reactor.REPAY_TOPIC(), marketId, "");
        otherChain.chainId = 1;
        reactor.react(otherChain);
        vm.stopPrank();
        assertEq(system.callbackCount(), 0);
    }

    function test_waitingCountFollowsTheQueueAndNeverUnderflows() public {
        vm.startPrank(SYSTEM);
        reactor.react(_log(address(vault), reactor.SETTLED_TOPIC(), 1, ""));
        assertEq(reactor.waiting(), 0);
        reactor.react(_log(address(vault), reactor.QUEUED_TOPIC(), 1, ""));
        reactor.react(_log(address(vault), reactor.QUEUED_TOPIC(), 2, ""));
        reactor.react(_log(address(vault), reactor.SETTLED_TOPIC(), 1, ""));
        vm.stopPrank();
        assertEq(reactor.waiting(), 1);
    }

    function test_callbackWiringIsSetOnceByTheDeployer() public {
        vm.expectRevert(QueueReactor.CallbackAlreadySet.selector);
        reactor.setCallbackContract(address(1));

        QueueReactor fresh = new QueueReactor(ORIGIN_CHAIN, address(morpho), Id.unwrap(params.id()), address(vault), GAS_LIMIT, MAX_ITEMS);
        vm.prank(ana);
        vm.expectRevert(QueueReactor.NotDeployer.selector);
        fresh.setCallbackContract(address(callback));
        vm.expectRevert(QueueReactor.ZeroAddress.selector);
        fresh.setCallbackContract(address(0));
    }

    function test_callbackRejectsAnyoneButTheProxyAndTheReactor() public {
        vm.expectPartialRevert(AbstractPayer.NotAuthorized.selector);
        callback.settle(address(reactor), 1, 1, 5);

        // The right proxy, but a callback requested by some other reactive contract.
        bytes memory payload = abi.encodeWithSignature("settle(address,uint256,uint256,uint256)", address(0), 1, 1, 5);
        (bool ok, bytes memory out) = proxy.deliver(makeAddr("another reactor"), address(callback), payload);
        assertFalse(ok);
        assertEq(bytes4(out), AbstractCallback.CallbackNotAuthorized.selector);
    }

    function test_fullLoop_repaymentPaysTheQueueWithNoKeeper() public {
        uint256 shares = _deposit(ana, 1_000 * USDC);
        _borrowAll();
        vm.recordLogs();
        _request(ana, shares);
        assertEq(_runReactiveNetwork(), 0, "queueing alone triggers nothing");

        _repay(1_000 * USDC);
        uint256 delivered = _runReactiveNetwork();

        assertEq(delivered, 1);
        assertEq(usdc.balanceOf(ana), 1_000 * USDC, "paid by the callback, with no settle call from anyone");
        assertEq(reactor.waiting(), 0);
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
        uint256 delivered = _runReactiveNetwork();

        assertEq(delivered, 3, "five requests at two per callback take three callbacks");
        for (uint256 i; i < 5; i++) {
            assertEq(usdc.balanceOf(people[i]), 200 * USDC);
        }
        assertEq(vault.queueLength(), 0);
        assertEq(reactor.waiting(), 0);
    }

    function test_fullLoop_aDepositAlsoPaysTheQueue() public {
        uint256 shares = _deposit(ana, 500 * USDC);
        _borrowAll();
        vm.recordLogs();
        _request(ana, shares);
        _deposit(ben, 500 * USDC);
        assertEq(_runReactiveNetwork(), 1);
        assertEq(usdc.balanceOf(ana), 500 * USDC, "new deposits are liquidity too");
    }

    function test_fullLoop_poolIsRepaidAutomatically() public {
        _fundPool(5_000 * USDC);
        uint256 shares = _deposit(ana, 1_000 * USDC);
        _borrowAll();
        vm.recordLogs();
        vm.startPrank(ana);
        vault.approve(address(pool), shares);
        uint256 received = pool.cashOut(shares, 0, ana);
        vm.stopPrank();

        _repay(1_000 * USDC);
        assertEq(_runReactiveNetwork(), 1);
        assertEq(pool.idle(), 5_000 * USDC + (1_000 * USDC - received), "the pool got the full amount back");
        assertEq(vault.pendingAssets(address(pool)), 0);
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
        // A second callback with nothing left to pay must not add a record.
        (ok,) = proxy.deliver(address(reactor), address(callback), payload);
        assertTrue(ok);

        assertEq(callback.loopCount(), 1);
        SpillwayCallback.Loop[] memory page = callback.loopsSlice(0, 10);
        assertEq(page.length, 1);
        assertEq(page[0].originTxHash, 0xfeed);
        assertEq(page[0].originBlock, 77);
        assertEq(page[0].payoutBlock, block.number);
        assertEq(page[0].settled, 2);
        assertEq(page[0].assets, 500 * USDC);
        assertEq(page[0].paidAtMs, block.timestamp * 1000);
        assertEq(callback.loopsSlice(1, 10).length, 0);
    }

    function test_gasFundsGoBackOnlyToTheDeployer() public {
        vm.deal(address(callback), 1 ether);
        vm.deal(address(reactor), 1 ether);
        vm.prank(ana);
        vm.expectRevert(SpillwayCallback.NotDeployer.selector);
        callback.withdrawGasFunds(1 ether);
        vm.prank(ana);
        vm.expectRevert(QueueReactor.NotDeployer.selector);
        reactor.withdrawGasFunds(1 ether);

        uint256 before = address(this).balance;
        callback.withdrawGasFunds(1 ether);
        reactor.withdrawGasFunds(0.4 ether);
        assertEq(address(this).balance - before, 1.4 ether);
        assertEq(address(reactor).balance, 0.6 ether);
    }

    receive() external payable {}

    function test_loopClosedRecordsOriginAndCount() public {
        uint256 shares = _deposit(ana, 300 * USDC);
        _borrowAll();
        _request(ana, shares);
        _repay(300 * USDC);

        bytes memory payload = abi.encodeWithSignature("settle(address,uint256,uint256,uint256)", address(0), uint256(0xfeed), uint256(77), uint256(5));
        vm.expectEmit(true, false, false, true, address(callback));
        emit SpillwayCallback.LoopClosed(0xfeed, 77, 1, block.timestamp * 1000, false);
        (bool ok,) = proxy.deliver(address(reactor), address(callback), payload);
        assertTrue(ok);
    }
}
