// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {QueueVault} from "./QueueVault.sol";
import {MsClock} from "./libraries/MsClock.sol";

/// @title SpillwayCallback
/// @notice The destination side of the reactive loop. Reactive Network's callback proxy calls `settle` here after
/// the reactive contract sees liquidity arrive; this contract pays the vault's queue and records when it did.
/// @dev It holds the ETH that pays for callback delivery, so the vault itself never has to. It has no privilege
/// over the vault: `QueueVault.settle` is open to anyone.
contract SpillwayCallback is AbstractCallback {
    QueueVault public immutable VAULT;

    /// @param originTxHash The transaction on the origin chain whose event started this loop.
    /// @param originBlock The origin block number, used with its millisecond timestamp to measure latency.
    /// @param settled Requests paid by this callback.
    /// @param paidAtMs Millisecond timestamp of this callback's block.
    /// @param more True when the next request could also be paid; the reactive contract asks again.
    event LoopClosed(uint256 indexed originTxHash, uint256 originBlock, uint256 settled, uint256 paidAtMs, bool more);

    constructor(IPayable callbackProxy_, address reactive_, QueueVault vault_) payable AbstractCallback(callbackProxy_, reactive_) {
        VAULT = vault_;
    }

    /// @param reactive_ Overwritten by the callback proxy with the reactive contract that requested the callback.
    function settle(address reactive_, uint256 originTxHash, uint256 originBlock, uint256 maxItems)
        external
        onlyServiceProvider
        onlyCallbackSender(reactive_)
    {
        (uint256 settled, bool more) = VAULT.settle(maxItems);
        emit LoopClosed(originTxHash, originBlock, settled, MsClock.nowMs(), more);
    }

    /// @notice Settles any debt to the callback proxy from this contract's balance. Anyone can fund and call it.
    function coverDebt() external {
        _coverDebt();
    }
}
