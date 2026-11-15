// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketParams, Market, Position, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {SharesMathLib} from "morpho-blue/libraries/SharesMathLib.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";

/// @notice 6 decimal test dollar with a blocklist, to exercise payouts that cannot be delivered.
contract MockUSDC is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Mock USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to] && !blocked[from], "blocked");
        super._update(from, to, value);
    }
}

/// @notice The slice of Morpho Blue the vault uses, with the same share math, events and revert string.
/// Borrowing skips collateral checks: these tests are about liquidity, not solvency.
/// The fork tests run the same flows against the deployed Morpho Blue.
contract MockMorpho {
    using MarketParamsLib for MarketParams;
    using SharesMathLib for uint256;

    mapping(Id => Market) internal _market;
    mapping(Id => mapping(address => Position)) internal _position;

    event Supply(Id indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares);
    event Repay(Id indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares);

    function createMarket(MarketParams memory params) external {
        _market[params.id()].lastUpdate = uint128(block.timestamp);
    }

    function market(Id id) external view returns (Market memory) {
        return _market[id];
    }

    function position(Id id, address user) external view returns (Position memory) {
        return _position[id][user];
    }

    function accrueInterest(MarketParams memory) external {}

    /// @dev Test hook standing in for interest: borrowers owe more and suppliers are owed more.
    function addInterest(MarketParams memory params, uint128 interest) external {
        Market storage m = _market[params.id()];
        m.totalBorrowAssets += interest;
        m.totalSupplyAssets += interest;
    }

    function supply(MarketParams memory params, uint256 assets, uint256, address onBehalf, bytes memory)
        external
        returns (uint256, uint256 shares)
    {
        Id id = params.id();
        Market storage m = _market[id];
        shares = assets.toSharesDown(m.totalSupplyAssets, m.totalSupplyShares);
        _position[id][onBehalf].supplyShares += shares;
        m.totalSupplyShares += uint128(shares);
        m.totalSupplyAssets += uint128(assets);
        emit Supply(id, msg.sender, onBehalf, assets, shares);
        IERC20(params.loanToken).transferFrom(msg.sender, address(this), assets);
        return (assets, shares);
    }

    function withdraw(MarketParams memory params, uint256 assets, uint256, address onBehalf, address receiver)
        external
        returns (uint256, uint256 shares)
    {
        require(onBehalf == msg.sender, "unauthorized");
        Id id = params.id();
        Market storage m = _market[id];
        shares = assets.toSharesUp(m.totalSupplyAssets, m.totalSupplyShares);
        _position[id][onBehalf].supplyShares -= shares;
        m.totalSupplyShares -= uint128(shares);
        m.totalSupplyAssets -= uint128(assets);
        require(m.totalBorrowAssets <= m.totalSupplyAssets, "insufficient liquidity");
        IERC20(params.loanToken).transfer(receiver, assets);
        return (assets, shares);
    }

    function borrow(MarketParams memory params, uint256 assets, uint256, address onBehalf, address receiver)
        external
        returns (uint256, uint256 shares)
    {
        Id id = params.id();
        Market storage m = _market[id];
        shares = assets.toSharesUp(m.totalBorrowAssets, m.totalBorrowShares);
        _position[id][onBehalf].borrowShares += uint128(shares);
        m.totalBorrowShares += uint128(shares);
        m.totalBorrowAssets += uint128(assets);
        require(m.totalBorrowAssets <= m.totalSupplyAssets, "insufficient liquidity");
        IERC20(params.loanToken).transfer(receiver, assets);
        return (assets, shares);
    }

    function repay(MarketParams memory params, uint256 assets, uint256, address onBehalf, bytes memory)
        external
        returns (uint256, uint256 shares)
    {
        Id id = params.id();
        Market storage m = _market[id];
        shares = assets.toSharesDown(m.totalBorrowAssets, m.totalBorrowShares);
        _position[id][onBehalf].borrowShares -= uint128(shares);
        m.totalBorrowShares -= uint128(shares);
        m.totalBorrowAssets -= uint128(assets);
        emit Repay(id, msg.sender, onBehalf, assets, shares);
        IERC20(params.loanToken).transferFrom(msg.sender, address(this), assets);
        return (assets, shares);
    }
}

/// @notice Stands in for Reactive Network's system contract. Records subscriptions and callback requests.
contract MockSystem {
    struct Subscription {
        uint256 chainId;
        address contractAddress;
        uint256 topic0;
        uint256 topic1;
    }

    Subscription[] public subscriptions;
    ISystemContract.CallbackConfiguration_V_1_0[] internal _callbacks;

    receive() external payable {}

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    function subscribe(uint256 chainId, address contractAddress, uint256 topic0, uint256 topic1, uint256, uint256) external {
        subscriptions.push(Subscription(chainId, contractAddress, topic0, topic1));
    }

    // forge-lint: disable-next-line(mixed-case-function)
    function requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0 memory config) external {
        _callbacks.push(config);
    }

    function subscriptionCount() external view returns (uint256) {
        return subscriptions.length;
    }

    function callbackCount() external view returns (uint256) {
        return _callbacks.length;
    }

    function callbackAt(uint256 index) external view returns (ISystemContract.CallbackConfiguration_V_1_0 memory) {
        return _callbacks[index];
    }
}

/// @notice Stands in for the destination chain's callback proxy: it overwrites the first argument of the payload
/// with the reactive contract's address, then calls the recipient, as the real proxy does.
contract MockCallbackProxy {
    receive() external payable {}

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    function deliver(address reactive, address recipient, bytes memory payload) external returns (bool ok, bytes memory out) {
        assembly {
            mstore(add(payload, 36), reactive)
        }
        (ok, out) = recipient.call(payload);
    }
}
