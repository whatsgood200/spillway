// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @notice Millisecond wall clock. Base produces a block every 200 ms while `block.timestamp` stays in whole
/// seconds, so latency is recorded from the BaseTime predeploy. On chains without it this falls back to seconds.
library MsClock {
    address internal constant BASE_TIME = 0x4200000000000000000000000000000000000030;

    function nowMs() internal view returns (uint256) {
        (bool ok, bytes memory out) = BASE_TIME.staticcall(abi.encodeWithSignature("timestampMs()"));
        if (ok && out.length == 32) {
            uint256 ms = abi.decode(out, (uint256));
            if (ms != 0) return ms;
        }
        return block.timestamp * 1000;
    }
}
