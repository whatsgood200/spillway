// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractReactive} from "@reactive/src/base/AbstractReactive.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";

/// @title QueueReactor
/// @notice Lives on Reactive Network. When an approved borrower repays the Morpho Blue market the vault lends on,
/// or is liquidated, it asks for a callback on the origin chain that pays the vault's queue.
/// @dev Nothing a stranger does can make it spend gas:
/// - It watches `Repay` only when an approved borrower both sends the repayment and is the one repaid (Morpho
///   indexes the market, caller and borrower), so repaying someone else's loan, even by 1 wei, matches nothing.
/// - It watches `Liquidate` only for approved borrowers, which needs an unhealthy loan of ours.
/// - It does not watch deposits: the vault pays the queue itself when a deposit arrives.
/// - It keeps at most one callback in flight. A repayment that lands meanwhile is remembered and paid when that
///   callback reports back; a callback that never reports back is given up after CALLBACK_TIMEOUT.
/// The deployer can pause it, which drops every subscription, and resume it.
contract QueueReactor is AbstractReactive {
    uint256 public constant REPAY_TOPIC = uint256(keccak256("Repay(bytes32,address,address,uint256,uint256)"));
    uint256 public constant LIQUIDATE_TOPIC =
        uint256(keccak256("Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)"));
    uint256 public constant LOOP_CLOSED_TOPIC = uint256(keccak256("LoopClosed(uint256,uint256,uint256,uint256,bool)"));
    uint256 public constant CALLBACK_TIMEOUT = 60;

    uint256 public immutable ORIGIN_CHAIN_ID;
    address public immutable MORPHO;
    uint256 public immutable MARKET_ID;
    uint64 public immutable CALLBACK_GAS_LIMIT;
    uint256 public immutable MAX_ITEMS;
    address public immutable DEPLOYER;

    /// @notice The contract on the origin chain that receives callbacks. Set once, after it is deployed.
    address public callbackContract;
    address[] internal _borrowers;
    mapping(address borrower => bool) public isBorrower;
    bool public active;

    /// @notice True while a callback has been requested and has not reported back.
    bool public inFlight;
    uint256 public inFlightSince;
    /// @notice A repayment arrived while a callback was in flight; it is paid when that callback reports back.
    bool public missedWhileInFlight;
    uint256 internal _missedOriginTx;
    uint256 internal _missedOriginBlock;

    event CallbackRequested(uint256 indexed originTxHash, uint256 originBlock);
    event RepaymentDeferred(uint256 indexed originTxHash, uint256 originBlock);
    event BorrowerApproved(address indexed borrower, bool isApproved);
    event Paused(bool isPaused);

    error NotDeployer();
    error CallbackAlreadySet();
    error ZeroAddress();
    error AlreadyInState();

    modifier onlyDeployer() {
        if (msg.sender != DEPLOYER) revert NotDeployer();
        _;
    }

    constructor(
        uint256 originChainId_,
        address morpho_,
        bytes32 marketId_,
        address[] memory borrowers_,
        uint64 callbackGasLimit_,
        uint256 maxItems_
    ) payable {
        ORIGIN_CHAIN_ID = originChainId_;
        MORPHO = morpho_;
        MARKET_ID = uint256(marketId_);
        CALLBACK_GAS_LIMIT = callbackGasLimit_;
        MAX_ITEMS = maxItems_;
        DEPLOYER = msg.sender;
        active = true;
        for (uint256 i; i < borrowers_.length; i++) {
            _addBorrower(borrowers_[i]);
        }
    }

    // ----------------------------------------------------------------- admin

    /// @notice Points this contract at the callback receiver. The receiver needs this contract's address in its
    /// constructor, so it is deployed second and wired here once.
    function setCallbackContract(address callbackContract_) external onlyDeployer {
        if (callbackContract != address(0)) revert CallbackAlreadySet();
        if (callbackContract_ == address(0)) revert ZeroAddress();
        callbackContract = callbackContract_;
        if (active) _subscribeLoopClosed(true);
    }

    function setBorrower(address borrower, bool approved) external onlyDeployer {
        if (borrower == address(0)) revert ZeroAddress();
        if (isBorrower[borrower] == approved) revert AlreadyInState();
        if (approved) {
            _addBorrower(borrower);
        } else {
            isBorrower[borrower] = false;
            if (active) _subscribeBorrower(borrower, false);
            for (uint256 i; i < _borrowers.length; i++) {
                if (_borrowers[i] == borrower) {
                    _borrowers[i] = _borrowers[_borrowers.length - 1];
                    _borrowers.pop();
                    break;
                }
            }
            emit BorrowerApproved(borrower, false);
        }
    }

    /// @notice Stops all reactions by dropping every subscription. Use it if anything starts costing gas it should not.
    function pause() external onlyDeployer {
        if (!active) revert AlreadyInState();
        active = false;
        for (uint256 i; i < _borrowers.length; i++) {
            _subscribeBorrower(_borrowers[i], false);
        }
        if (callbackContract != address(0)) _subscribeLoopClosed(false);
        emit Paused(true);
    }

    function resume() external onlyDeployer {
        if (active) revert AlreadyInState();
        active = true;
        inFlight = false;
        missedWhileInFlight = false;
        for (uint256 i; i < _borrowers.length; i++) {
            _subscribeBorrower(_borrowers[i], true);
        }
        if (callbackContract != address(0)) _subscribeLoopClosed(true);
        emit Paused(false);
    }

    function borrowers() external view returns (address[] memory) {
        return _borrowers;
    }

    /// @notice Settles any debt to the system contract from this contract's balance. Anyone can fund and call it.
    function coverDebt() external {
        _coverDebt();
    }

    /// @notice Returns unused gas money to the deployer. This contract never holds user funds.
    function withdrawGasFunds(uint256 amount) external onlyDeployer {
        _pay(payable(DEPLOYER), amount);
    }

    // ----------------------------------------------------------------- react

    /// @inheritdoc IReactive
    function react(LogRecord calldata log_) external onlySystem {
        if (!active || log_.chainId != ORIGIN_CHAIN_ID || callbackContract == address(0)) return;

        if (log_.contractAddress == callbackContract && log_.topic0 == LOOP_CLOSED_TOPIC) {
            _onLoopClosed(log_);
            return;
        }

        // The subscriptions already filter these; checking again keeps the contract correct on its own.
        if (log_.contractAddress != MORPHO || log_.topic1 != MARKET_ID) return;
        address borrower = address(uint160(log_.topic3));
        bool repaidByBorrower = log_.topic0 == REPAY_TOPIC && log_.topic2 == log_.topic3 && isBorrower[borrower];
        bool borrowerLiquidated = log_.topic0 == LIQUIDATE_TOPIC && isBorrower[borrower];
        if (!repaidByBorrower && !borrowerLiquidated) return;

        if (inFlight && block.timestamp < inFlightSince + CALLBACK_TIMEOUT) {
            missedWhileInFlight = true;
            _missedOriginTx = log_.txHash;
            _missedOriginBlock = log_.blockNumber;
            emit RepaymentDeferred(log_.txHash, log_.blockNumber);
            return;
        }
        _request(log_.txHash, log_.blockNumber);
    }

    /// @dev LoopClosed data is (originBlock, settled, paidAtMs, more); topic 1 is the origin transaction.
    function _onLoopClosed(LogRecord calldata log_) private {
        inFlight = false;
        bool more;
        uint256 originBlock;
        if (log_.data.length >= 128) (originBlock,,, more) = abi.decode(log_.data, (uint256, uint256, uint256, bool));
        if (missedWhileInFlight) {
            missedWhileInFlight = false;
            _request(_missedOriginTx, _missedOriginBlock);
        } else if (more) {
            // One callback pays a bounded number of requests; keep attributing the loop to the event that began it.
            _request(log_.topic1, originBlock);
        }
    }

    function _request(uint256 originTxHash, uint256 originBlock) private {
        inFlight = true;
        inFlightSince = block.timestamp;
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: ORIGIN_CHAIN_ID,
                recipient: callbackContract,
                gasLimit: CALLBACK_GAS_LIMIT,
                payload: abi.encodeWithSignature("settle(address,uint256,uint256,uint256)", address(0), originTxHash, originBlock, MAX_ITEMS)
            })
        );
        emit CallbackRequested(originTxHash, originBlock);
    }

    // --------------------------------------------------------- subscriptions

    function _addBorrower(address borrower) private {
        if (borrower == address(0)) revert ZeroAddress();
        isBorrower[borrower] = true;
        _borrowers.push(borrower);
        if (active) _subscribeBorrower(borrower, true);
        emit BorrowerApproved(borrower, true);
    }

    /// @dev Exact match on market, caller and borrower for repayments; market and borrower for liquidations.
    /// Subscribe and unsubscribe use the same arguments, which `unsubscribe` requires.
    function _subscribeBorrower(address borrower, bool on) private {
        uint256 who = uint256(uint160(borrower));
        if (on) {
            SYSTEM.subscribe(ORIGIN_CHAIN_ID, MORPHO, REPAY_TOPIC, MARKET_ID, who, who);
            SYSTEM.subscribe(ORIGIN_CHAIN_ID, MORPHO, LIQUIDATE_TOPIC, MARKET_ID, REACTIVE_IGNORE, who);
        } else {
            SYSTEM.unsubscribe(ORIGIN_CHAIN_ID, MORPHO, REPAY_TOPIC, MARKET_ID, who, who);
            SYSTEM.unsubscribe(ORIGIN_CHAIN_ID, MORPHO, LIQUIDATE_TOPIC, MARKET_ID, REACTIVE_IGNORE, who);
        }
    }

    function _subscribeLoopClosed(bool on) private {
        if (on) {
            SYSTEM.subscribe(ORIGIN_CHAIN_ID, callbackContract, LOOP_CLOSED_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        } else {
            SYSTEM.unsubscribe(ORIGIN_CHAIN_ID, callbackContract, LOOP_CLOSED_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        }
    }
}
