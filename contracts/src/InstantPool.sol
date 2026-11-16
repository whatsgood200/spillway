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
/// @dev The fee has two parts. One rises as the pool's cash drains, the shape Sanctum uses for instant unstake.
/// The other rises with how much is queued ahead of the place, because a longer line means a longer wait for the
/// pool's money. New deposits are locked for an hour, so nobody can join just before a sale and leave just after.
/// Unaudited. Testnet use only.
contract InstantPool is ERC4626, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MIN_FEE_BPS = 8;
    /// @notice Most the drain part of the fee can reach.
    uint256 public constant MAX_DRAIN_BPS = 300;
    /// @notice Most the wait part of the fee can reach.
    uint256 public constant MAX_WAIT_BPS = 200;
    /// @notice Most the whole fee can reach.
    uint256 public constant MAX_FEE_BPS = MAX_DRAIN_BPS + MAX_WAIT_BPS;
    /// @notice How long new pool shares stay locked before they can be withdrawn.
    uint256 public constant DEPOSIT_LOCK = 1 hours;
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
    /// @notice When each account's pool shares can next be withdrawn.
    mapping(address account => uint256) public unlocksAt;

    event ClaimBought(uint256 indexed requestId, address indexed seller, uint256 assets, uint256 paid, uint256 fee);
    event PassedThrough(address indexed seller, uint256 assets);

    error ReceiveBelowMinimum(uint256 receiveAmount, uint256 minimum);
    error NotEnoughCash(uint256 needed, uint256 idle);
    error NotClaimOwner();
    error SharesLocked(uint256 unlocksAt);

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

    /// @notice Fee for a place worth `assets` with `ahead` assets queued in front of it, given the pool as it is.
    function feeBps(uint256 assets, uint256 ahead) public view returns (uint256) {
        return _feeBps(assets, ahead, idle(), totalAssets());
    }

    /// @notice What a seller would get for a new place worth `assets`, which joins the back of the line.
    function quote(uint256 assets) public view returns (uint256 receiveAmount, uint256 fee, uint256 bps, bool available) {
        return _quote(assets, VAULT.queuedAssets());
    }

    /// @notice What the owner of an existing place would get for it. Everything queued except the place itself is
    /// counted as ahead of it, an upper bound that keeps the price on the pool's side.
    function quoteClaim(uint256 requestId) public view returns (uint256 receiveAmount, uint256 fee, uint256 bps, bool available) {
        uint256 owed = VAULT.stillOwed(requestId);
        return _quote(owed, VAULT.queuedAssets() - owed);
    }

    function _quote(uint256 assets, uint256 ahead) private view returns (uint256 receiveAmount, uint256 fee, uint256 bps, bool available) {
        bps = feeBps(assets, ahead);
        fee = (assets * bps) / BPS;
        receiveAmount = assets - fee;
        available = idle() >= receiveAmount;
    }

    /// @dev Drain part: grows as this sale would empty the pool. Wait part: grows with the line ahead, relative to
    /// the pool's size. Each part is capped, so the whole fee never exceeds MAX_FEE_BPS.
    function _feeBps(uint256 assets, uint256 ahead, uint256 cash, uint256 total) private pure returns (uint256) {
        uint256 drain = MAX_DRAIN_BPS;
        if (total != 0 && cash > assets) {
            uint256 drainedBps = BPS - ((cash - assets) * BPS) / total;
            drain = MIN_FEE_BPS + ((MAX_DRAIN_BPS - MIN_FEE_BPS) * drainedBps) / BPS;
        }
        uint256 wait = ahead + total == 0 ? 0 : (MAX_WAIT_BPS * ahead) / (ahead + total);
        return drain + wait;
    }

    /// @dev Providers can only take out cash, and only once their deposit lock has passed.
    function maxWithdraw(address owner) public view override returns (uint256) {
        if (block.timestamp < unlocksAt[owner]) return 0;
        uint256 owned = super.maxWithdraw(owner);
        uint256 cash = idle();
        return owned < cash ? owned : cash;
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        if (block.timestamp < unlocksAt[owner]) return 0;
        uint256 owned = super.maxRedeem(owner);
        uint256 cashShares = convertToShares(idle());
        return owned < cashShares ? owned : cashShares;
    }

    // -------------------------------------------------------------- providers

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        unlocksAt[receiver] = block.timestamp + DEPOSIT_LOCK;
        super._deposit(caller, receiver, assets, shares);
    }

    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares) internal override {
        if (block.timestamp < unlocksAt[owner]) revert SharesLocked(unlocksAt[owner]);
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    /// @dev The lock travels with the shares, so sending fresh shares to another address does not dodge it.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && unlocksAt[from] > unlocksAt[to]) {
            unlocksAt[to] = unlocksAt[from];
        }
        super._update(from, to, value);
    }

    // ---------------------------------------------------------------- selling

    /// @notice One step exit: takes the caller's vault shares, queues them in the pool's name and pays the caller
    /// now. If the vault can pay at once there is no queue and no fee, and the full amount is passed through.
    /// @param shares Vault shares to exit. The caller must have approved the pool for them.
    /// @param minReceive Reverts if the caller would get less than this.
    function cashOut(uint256 shares, uint256 minReceive, address receiver) external nonReentrant returns (uint256 received) {
        IERC20(address(VAULT)).safeTransferFrom(msg.sender, address(this), shares);
        uint256 cashBefore = idle();
        uint256 totalBefore = totalAssets();
        uint256 aheadBefore = VAULT.queuedAssets();
        (uint256 requestId, uint256 assets, bool paidAtOnce) = VAULT.requestRedeem(shares, address(this));

        if (paidAtOnce) {
            received = assets;
            emit PassedThrough(msg.sender, assets);
        } else {
            received = _pay(requestId, assets, aheadBefore, cashBefore, totalBefore);
        }
        if (received < minReceive) revert ReceiveBelowMinimum(received, minReceive);
        IERC20(asset()).safeTransfer(receiver, received);
    }

    /// @notice Buys a place the caller already holds in the queue, for what it is still owed. The caller must
    /// first approve the pool with `QueueVault.approveClaim`.
    function buyClaim(uint256 requestId, uint256 minReceive, address receiver) external nonReentrant returns (uint256 received) {
        (address owner,,,,,,,) = VAULT.requests(requestId);
        if (owner != msg.sender) revert NotClaimOwner();
        uint256 owed = VAULT.stillOwed(requestId);
        uint256 cashBefore = idle();
        uint256 totalBefore = totalAssets();
        uint256 aheadBefore = VAULT.queuedAssets() - owed;
        VAULT.transferClaim(requestId, address(this));

        received = _pay(requestId, owed, aheadBefore, cashBefore, totalBefore);
        if (received < minReceive) revert ReceiveBelowMinimum(received, minReceive);
        IERC20(asset()).safeTransfer(receiver, received);
    }

    /// @dev Prices the place against the pool and the line as they stood before the place was added.
    function _pay(uint256 requestId, uint256 assets, uint256 ahead, uint256 cashBefore, uint256 totalBefore)
        private
        returns (uint256 received)
    {
        uint256 fee = (assets * _feeBps(assets, ahead, cashBefore, totalBefore)) / BPS;
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
