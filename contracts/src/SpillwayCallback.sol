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
    address public immutable DEPLOYER;

    /// @dev One record per callback that paid someone (in full or in part). The origin block's own timestamp is not available on
    /// chain here; latency is `paidAtMs` minus the origin block's millisecond timestamp, read from the RPC.
    struct Loop {
        uint256 originTxHash;
        uint64 originBlock;
        uint64 payoutBlock;
        uint64 paidAtMs;
        uint32 settled;
        uint256 assets;
    }

    Loop[] public loops;

    error NotDeployer();

    /// @param originTxHash The transaction on the origin chain whose event started this loop.
    /// @param originBlock The origin block number, used with its millisecond timestamp to measure latency.
    /// @param settled Requests completed by this callback.
    /// @param paidAtMs Millisecond timestamp of this callback's block.
    /// @param more True when the next request could also be paid; the reactive contract asks again.
    event LoopClosed(uint256 indexed originTxHash, uint256 originBlock, uint256 settled, uint256 paidAtMs, bool more);

    constructor(IPayable callbackProxy_, address reactive_, QueueVault vault_) payable AbstractCallback(callbackProxy_, reactive_) {
        VAULT = vault_;
        DEPLOYER = msg.sender;
    }

    function loopCount() external view returns (uint256) {
        return loops.length;
    }

    /// @notice A page of the recorded loops, oldest first.
    function loopsSlice(uint256 offset, uint256 limit) external view returns (Loop[] memory page) {
        uint256 available = offset >= loops.length ? 0 : loops.length - offset;
        uint256 count = available < limit ? available : limit;
        page = new Loop[](count);
        for (uint256 i; i < count; i++) {
            page[i] = loops[offset + i];
        }
    }

    /// @param reactive_ Overwritten by the callback proxy with the reactive contract that requested the callback.
    function settle(address reactive_, uint256 originTxHash, uint256 originBlock, uint256 maxItems)
        external
        onlyServiceProvider
        onlyCallbackSender(reactive_)
    {
        (uint256 settled, bool more, uint256 paid) = VAULT.settle(maxItems);
        uint256 paidAtMs = MsClock.nowMs();
        // A loop is any callback that paid someone, including a part paid to an incomplete front request.
        if (paid > 0) {
            loops.push(
                Loop({
                    originTxHash: originTxHash,
                    originBlock: uint64(originBlock),
                    payoutBlock: uint64(block.number),
                    paidAtMs: uint64(paidAtMs),
                    settled: uint32(settled),
                    assets: paid
                })
            );
        }
        emit LoopClosed(originTxHash, originBlock, settled, paidAtMs, more);
    }

    /// @notice Settles any debt to the callback proxy from this contract's balance. Anyone can fund and call it.
    function coverDebt() external {
        _coverDebt();
    }

    /// @notice Returns unused callback gas money to the deployer. This contract never holds user funds.
    function withdrawGasFunds(uint256 amount) external {
        if (msg.sender != DEPLOYER) revert NotDeployer();
        _pay(payable(DEPLOYER), amount);
    }
}
