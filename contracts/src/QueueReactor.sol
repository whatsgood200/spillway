// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractReactive} from "@reactive/src/base/AbstractReactive.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";

/// @title QueueReactor
/// @notice Lives on Reactive Network. It listens to the Morpho Blue market the vault lends on and to the vault's
/// own queue events. When liquidity arrives while someone is waiting, it asks for a callback that pays the queue.
/// @dev It keeps its own count of waiting requests so an idle vault costs nothing: liquidity events with an empty
/// queue are ignored. The count is advisory; a wrong count can only cause a wasted or missed callback, never a
/// wrong payment, because the vault checks everything itself and `settle` is open to anyone.
contract QueueReactor is AbstractReactive {
    uint256 public constant REPAY_TOPIC = uint256(keccak256("Repay(bytes32,address,address,uint256,uint256)"));
    uint256 public constant SUPPLY_TOPIC = uint256(keccak256("Supply(bytes32,address,address,uint256,uint256)"));
    uint256 public constant LIQUIDATE_TOPIC =
        uint256(keccak256("Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)"));
    uint256 public constant QUEUED_TOPIC = uint256(keccak256("RedeemQueued(uint256,address,uint256)"));
    uint256 public constant SETTLED_TOPIC = uint256(keccak256("RedeemSettled(uint256,address,uint256)"));
    uint256 public constant LOOP_CLOSED_TOPIC = uint256(keccak256("LoopClosed(uint256,uint256,uint256,uint256,bool)"));

    uint256 public immutable ORIGIN_CHAIN_ID;
    address public immutable MORPHO;
    uint256 public immutable MARKET_ID;
    address public immutable VAULT;
    uint64 public immutable CALLBACK_GAS_LIMIT;
    uint256 public immutable MAX_ITEMS;
    address public immutable DEPLOYER;

    /// @notice The contract on the origin chain that receives callbacks. Set once, after it is deployed.
    address public callbackContract;
    /// @notice Requests this contract believes are waiting in the vault's queue.
    uint256 public waiting;

    event CallbackRequested(uint256 indexed originTxHash, uint256 originBlock, uint256 waiting);

    error NotDeployer();
    error CallbackAlreadySet();
    error ZeroAddress();

    constructor(
        uint256 originChainId_,
        address morpho_,
        bytes32 marketId_,
        address vault_,
        uint64 callbackGasLimit_,
        uint256 maxItems_
    ) payable {
        ORIGIN_CHAIN_ID = originChainId_;
        MORPHO = morpho_;
        MARKET_ID = uint256(marketId_);
        VAULT = vault_;
        CALLBACK_GAS_LIMIT = callbackGasLimit_;
        MAX_ITEMS = maxItems_;
        DEPLOYER = msg.sender;

        // Liquidity can return three ways. Each is filtered to this one market by its indexed id.
        SYSTEM.subscribe(originChainId_, morpho_, REPAY_TOPIC, MARKET_ID, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(originChainId_, morpho_, SUPPLY_TOPIC, MARKET_ID, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(originChainId_, morpho_, LIQUIDATE_TOPIC, MARKET_ID, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(originChainId_, vault_, QUEUED_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(originChainId_, vault_, SETTLED_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    /// @notice Points this contract at the callback receiver. The receiver needs this contract's address in its
    /// constructor, so it is deployed second and wired here once.
    function setCallbackContract(address callbackContract_) external {
        if (msg.sender != DEPLOYER) revert NotDeployer();
        if (callbackContract != address(0)) revert CallbackAlreadySet();
        if (callbackContract_ == address(0)) revert ZeroAddress();
        callbackContract = callbackContract_;
        SYSTEM.subscribe(ORIGIN_CHAIN_ID, callbackContract_, LOOP_CLOSED_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    /// @inheritdoc IReactive
    function react(LogRecord calldata log_) external onlySystem {
        if (log_.chainId != ORIGIN_CHAIN_ID) return;

        if (log_.contractAddress == VAULT) {
            if (log_.topic0 == QUEUED_TOPIC) {
                waiting++;
            } else if (log_.topic0 == SETTLED_TOPIC && waiting > 0) {
                waiting--;
            }
            return;
        }

        if (waiting == 0 || callbackContract == address(0)) return;

        bool liquidityArrived = log_.contractAddress == MORPHO && log_.topic1 == MARKET_ID
            && (log_.topic0 == REPAY_TOPIC || log_.topic0 == SUPPLY_TOPIC || log_.topic0 == LIQUIDATE_TOPIC);

        // One callback pays a bounded number of requests. If the vault says more can be paid, ask again.
        bool continueSettling = log_.contractAddress == callbackContract && log_.topic0 == LOOP_CLOSED_TOPIC
            && _moreFlag(log_.data);

        if (liquidityArrived || continueSettling) {
            // For a continuation, keep attributing the loop to the event that started it.
            uint256 originTxHash = continueSettling ? log_.topic1 : log_.txHash;
            uint256 originBlock = continueSettling ? _originBlock(log_.data) : log_.blockNumber;
            SYSTEM.requestCallbackV_1_0(
                ISystemContract.CallbackConfiguration_V_1_0({
                    chainId: ORIGIN_CHAIN_ID,
                    recipient: callbackContract,
                    gasLimit: CALLBACK_GAS_LIMIT,
                    payload: abi.encodeWithSignature(
                        "settle(address,uint256,uint256,uint256)", address(0), originTxHash, originBlock, MAX_ITEMS
                    )
                })
            );
            emit CallbackRequested(originTxHash, originBlock, waiting);
        }
    }

    /// @notice Settles any debt to the system contract from this contract's balance. Anyone can fund and call it.
    function coverDebt() external {
        _coverDebt();
    }

    /// @notice Returns unused gas money to the deployer. This contract never holds user funds.
    function withdrawGasFunds(uint256 amount) external {
        if (msg.sender != DEPLOYER) revert NotDeployer();
        _pay(payable(DEPLOYER), amount);
    }

    /// @dev LoopClosed data is (originBlock, settled, paidAtMs, more).
    function _moreFlag(bytes calldata data_) private pure returns (bool more) {
        if (data_.length < 128) return false;
        (,,, more) = abi.decode(data_, (uint256, uint256, uint256, bool));
    }

    function _originBlock(bytes calldata data_) private pure returns (uint256 originBlock) {
        (originBlock,,,) = abi.decode(data_, (uint256, uint256, uint256, bool));
    }
}
