// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ERC4626, ERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {QueueVault} from "./QueueVault.sol";
import {MsClock} from "./libraries/MsClock.sol";

/// @title InstantPool
/// @notice Buys places in the QueueVault withdrawal queue for cash now, at a fee. When the vault pays a place,
/// the pool receives the full amount; the fee is the liquidity providers' income.
/// @dev The fee rises linearly as the pool's cash drains, the shape Sanctum uses for instant unstake.
/// Queue places are valued at par, so providers carry the risk that the vault never pays them.
/// Unaudited. Testnet use only.
contract InstantPool is ERC4626, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MIN_FEE_BPS = 8;
    uint256 public constant MAX_FEE_BPS = 300;
    uint256 private constant BPS = 10_000;

    QueueVault public immutable VAULT;

    /// @dev One record per place bought, kept so the history can be read from the contract with no indexer.
    struct Sale {
        address seller;
        uint256 assets;
        uint256 paid;
        uint256 fee;
        uint64 atMs;
        uint64 atBlock;
    }

    mapping(uint256 requestId => Sale) public sales;
    /// @notice Total fees charged on places bought so far.
    uint256 public feesCharged;

    event ClaimBought(uint256 indexed requestId, address indexed seller, uint256 assets, uint256 paid, uint256 fee);
    event PassedThrough(address indexed seller, uint256 assets);

    error ReceiveBelowMinimum(uint256 receiveAmount, uint256 minimum);
    error NotEnoughCash(uint256 needed, uint256 idle);
    error NotClaimOwner();

    constructor(QueueVault vault_, string memory name_, string memory symbol_)
        ERC4626(IERC20(vault_.asset()))
        ERC20(name_, symbol_)
    {
        VAULT = vault_;
    }

    // ------------------------------------------------------------------ views

    /// @notice Cash the pool holds, ready to buy places or be withdrawn.
    function idle() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    /// @dev Cash, plus the places the pool is waiting on, plus any payout the vault is holding for the pool.
    function totalAssets() public view override returns (uint256) {
        return idle() + VAULT.pendingAssets(address(this)) + VAULT.unpaid(address(this));
    }

    /// @notice Fee, in basis points, for buying a place worth `assets` right now.
    function feeBps(uint256 assets) public view returns (uint256) {
        uint256 total = totalAssets();
        uint256 cash = idle();
        if (total == 0 || cash <= assets) return MAX_FEE_BPS;
        uint256 drainedBps = BPS - ((cash - assets) * BPS) / total;
        return MIN_FEE_BPS + ((MAX_FEE_BPS - MIN_FEE_BPS) * drainedBps) / BPS;
    }

    /// @notice What a seller would get for a place worth `assets`.
    function quote(uint256 assets) public view returns (uint256 receiveAmount, uint256 fee, uint256 bps, bool available) {
        bps = feeBps(assets);
        fee = (assets * bps) / BPS;
        receiveAmount = assets - fee;
        available = idle() >= receiveAmount;
    }

    /// @dev Providers can only take out cash; places come back as cash when the vault pays them.
    function maxWithdraw(address owner) public view override returns (uint256) {
        uint256 owned = super.maxWithdraw(owner);
        uint256 cash = idle();
        return owned < cash ? owned : cash;
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        uint256 owned = super.maxRedeem(owner);
        uint256 cashShares = convertToShares(idle());
        return owned < cashShares ? owned : cashShares;
    }

    // ---------------------------------------------------------------- selling

    /// @notice One step exit: takes the caller's vault shares, queues them in the pool's name and pays the caller
    /// now. If the vault can pay at once there is no queue and no fee, and the full amount is passed through.
    /// @param shares Vault shares to exit. The caller must have approved the pool for them.
    /// @param minReceive Reverts if the caller would get less than this.
    function cashOut(uint256 shares, uint256 minReceive, address receiver)
        external
        nonReentrant
        returns (uint256 received)
    {
        IERC20(address(VAULT)).safeTransferFrom(msg.sender, address(this), shares);
        uint256 cashBefore = idle();
        uint256 totalBefore = totalAssets();
        (uint256 requestId, uint256 assets, bool paidAtOnce) = VAULT.requestRedeem(shares, address(this));

        if (paidAtOnce) {
            received = assets;
            emit PassedThrough(msg.sender, assets);
        } else {
            received = _pay(requestId, assets, cashBefore, totalBefore);
        }
        if (received < minReceive) revert ReceiveBelowMinimum(received, minReceive);
        IERC20(asset()).safeTransfer(receiver, received);
    }

    /// @notice Buys a place the caller already holds in the queue. The caller must first approve the pool with
    /// `QueueVault.approveClaim`.
    function buyClaim(uint256 requestId, uint256 minReceive, address receiver)
        external
        nonReentrant
        returns (uint256 received)
    {
        (address owner,, uint256 assets,,,,) = VAULT.requests(requestId);
        if (owner != msg.sender) revert NotClaimOwner();
        uint256 cashBefore = idle();
        uint256 totalBefore = totalAssets();
        VAULT.transferClaim(requestId, address(this));

        received = _pay(requestId, assets, cashBefore, totalBefore);
        if (received < minReceive) revert ReceiveBelowMinimum(received, minReceive);
        IERC20(asset()).safeTransfer(receiver, received);
    }

    /// @dev Prices the place against the pool as it stood before the place was added.
    function _pay(uint256 requestId, uint256 assets, uint256 cashBefore, uint256 totalBefore)
        private
        returns (uint256 received)
    {
        uint256 bps = MAX_FEE_BPS;
        if (totalBefore != 0 && cashBefore > assets) {
            uint256 drainedBps = BPS - ((cashBefore - assets) * BPS) / totalBefore;
            bps = MIN_FEE_BPS + ((MAX_FEE_BPS - MIN_FEE_BPS) * drainedBps) / BPS;
        }
        uint256 fee = (assets * bps) / BPS;
        received = assets - fee;
        if (cashBefore < received) revert NotEnoughCash(received, cashBefore);
        sales[requestId] = Sale({
            seller: msg.sender,
            assets: assets,
            paid: received,
            fee: fee,
            atMs: uint64(MsClock.nowMs()),
            atBlock: uint64(block.number)
        });
        feesCharged += fee;
        emit ClaimBought(requestId, msg.sender, assets, received, fee);
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }
}
