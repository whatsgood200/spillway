// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ERC4626, ERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IMorpho, MarketParams, Market, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {SharesMathLib} from "morpho-blue/libraries/SharesMathLib.sol";
import {MsClock} from "./libraries/MsClock.sol";

/// @title QueueVault
/// @notice A USDC vault that lends on one Morpho Blue market. When the market cannot release cash, withdrawals
/// join a first in, first out queue. Anyone can call `settle`, which pays the queue from the front for as far
/// as the market's liquidity goes. A reactive contract calls it the moment a repayment lands.
/// @dev Deposits follow ERC-4626. Synchronous `withdraw` and `redeem` are disabled; exits go through
/// `requestRedeem`. A queued request is fixed in assets at the time it is made and stops earning interest.
/// Unaudited. Testnet use only.
contract QueueVault is ERC4626, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using MarketParamsLib for MarketParams;
    using SharesMathLib for uint256;

    /// @dev Requests are kept after they are paid, so the full history can be read from the contract itself
    /// with no indexer. `settledAtMs` is zero while the request is still waiting.
    struct Request {
        address owner;
        address requester;
        uint256 assets;
        uint64 queuedAtMs;
        uint64 queuedBlock;
        uint64 settledAtMs;
        uint64 settledBlock;
    }

    /// @notice Smallest request the queue accepts, so the queue cannot be filled with dust.
    uint256 public constant MIN_REQUEST = 1e6;

    IMorpho public immutable MORPHO;
    Id public immutable MARKET_ID;
    address private immutable _COLLATERAL;
    address private immutable _ORACLE;
    address private immutable _IRM;
    uint256 private immutable _LLTV;

    /// @notice Requests by id. The queue is the id range [head, nextRequestId).
    mapping(uint256 requestId => Request) public requests;
    mapping(uint256 requestId => address) public claimApproval;
    uint256 public head = 1;
    uint256 public nextRequestId = 1;

    /// @notice Assets owed to queued requests. Excluded from the share price.
    uint256 public queuedAssets;
    /// @notice Assets owed to each owner across all of their queued requests.
    mapping(address owner => uint256) public pendingAssets;
    /// @notice Payouts that could not be delivered (for example to a blocked address), held for the owner to pull.
    mapping(address owner => uint256) public unpaid;

    event RedeemQueued(uint256 indexed requestId, address indexed owner, uint256 assets);
    event RedeemSettled(uint256 indexed requestId, address indexed owner, uint256 assets);
    event RedeemPaidAtOnce(address indexed owner, address indexed receiver, uint256 assets);
    event ClaimTransferred(uint256 indexed requestId, address indexed from, address indexed to, uint256 assets);
    event ClaimApproved(uint256 indexed requestId, address indexed owner, address indexed spender);
    event PayoutHeld(address indexed owner, uint256 assets);

    error SynchronousExitDisabled();
    error RequestTooSmall(uint256 assets, uint256 minimum);
    error NotClaimOwnerOrApproved();
    error UnknownRequest();
    error AlreadySettled();
    error ZeroAddress();
    error NothingUnpaid();

    constructor(IERC20 asset_, IMorpho morpho_, MarketParams memory params_, string memory name_, string memory symbol_)
        ERC4626(asset_)
        ERC20(name_, symbol_)
    {
        require(params_.loanToken == address(asset_), "loan token mismatch");
        MORPHO = morpho_;
        MARKET_ID = params_.id();
        _COLLATERAL = params_.collateralToken;
        _ORACLE = params_.oracle;
        _IRM = params_.irm;
        _LLTV = params_.lltv;
        asset_.forceApprove(address(morpho_), type(uint256).max);
    }

    // ------------------------------------------------------------------ views

    function marketParams() public view returns (MarketParams memory) {
        return MarketParams({loanToken: asset(), collateralToken: _COLLATERAL, oracle: _ORACLE, irm: _IRM, lltv: _LLTV});
    }

    /// @notice Assets the vault has supplied to Morpho, as of the market's last interest accrual.
    function suppliedAssets() public view returns (uint256) {
        Market memory m = MORPHO.market(MARKET_ID);
        return MORPHO.position(MARKET_ID, address(this)).supplyShares.toAssetsDown(m.totalSupplyAssets, m.totalSupplyShares);
    }

    /// @notice Cash the vault could pull from Morpho right now.
    function withdrawable() public view returns (uint256) {
        Market memory m = MORPHO.market(MARKET_ID);
        uint256 liquidity = m.totalSupplyAssets - m.totalBorrowAssets;
        uint256 supplied = suppliedAssets();
        return liquidity < supplied ? liquidity : supplied;
    }

    /// @dev Queued requests are liabilities, so they do not count towards the share price.
    function totalAssets() public view override returns (uint256) {
        uint256 supplied = suppliedAssets();
        return supplied > queuedAssets ? supplied - queuedAssets : 0;
    }

    function queueLength() public view returns (uint256) {
        return nextRequestId - head;
    }

    /// @notice A page of every request ever made, waiting or paid, starting at `firstId`.
    function requestsSlice(uint256 firstId, uint256 limit) external view returns (Request[] memory page) {
        if (firstId == 0) firstId = 1;
        uint256 available = firstId >= nextRequestId ? 0 : nextRequestId - firstId;
        uint256 count = available < limit ? available : limit;
        page = new Request[](count);
        for (uint256 i; i < count; i++) {
            page[i] = requests[firstId + i];
        }
    }

    /// @notice A page of the queue, front first.
    function queueSlice(uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, address[] memory owners, uint256[] memory amounts)
    {
        uint256 length = queueLength();
        uint256 count = offset >= length ? 0 : (length - offset < limit ? length - offset : limit);
        ids = new uint256[](count);
        owners = new address[](count);
        amounts = new uint256[](count);
        for (uint256 i; i < count; i++) {
            uint256 id = head + offset + i;
            ids[i] = id;
            owners[i] = requests[id].owner;
            amounts[i] = requests[id].assets;
        }
    }

    function maxWithdraw(address) public pure override returns (uint256) {
        return 0;
    }

    function maxRedeem(address) public pure override returns (uint256) {
        return 0;
    }

    // --------------------------------------------------------------- deposits

    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        MORPHO.accrueInterest(marketParams());
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        MORPHO.accrueInterest(marketParams());
        return super.mint(shares, receiver);
    }

    /// @dev Every deposit goes straight to Morpho. Its `Supply` event is what tells the reactive contract that
    /// liquidity arrived, so a deposit pays waiting withdrawals the same way a repayment does.
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        super._deposit(caller, receiver, assets, shares);
        MORPHO.supply(marketParams(), assets, 0, address(this), "");
    }

    function withdraw(uint256, address, address) public pure override returns (uint256) {
        revert SynchronousExitDisabled();
    }

    function redeem(uint256, address, address) public pure override returns (uint256) {
        revert SynchronousExitDisabled();
    }

    // ------------------------------------------------------------------ exits

    /// @notice Burns `shares` and pays `receiver` their value. Paid at once when nobody is waiting and the market
    /// has the cash; otherwise the request joins the back of the queue, owned by `receiver`.
    /// @return requestId The queue id, or 0 when paid at once.
    /// @return assets The USDC value fixed for this request.
    /// @return paidAtOnce True when `receiver` already has the USDC.
    function requestRedeem(uint256 shares, address receiver)
        external
        nonReentrant
        returns (uint256 requestId, uint256 assets, bool paidAtOnce)
    {
        if (receiver == address(0)) revert ZeroAddress();
        MarketParams memory params = marketParams();
        MORPHO.accrueInterest(params);

        assets = previewRedeem(shares);
        if (assets < MIN_REQUEST) revert RequestTooSmall(assets, MIN_REQUEST);
        _burn(msg.sender, shares);

        // Nobody may jump the line: while anyone is waiting, every new request joins the back.
        if (queueLength() == 0 && withdrawable() >= assets) {
            MORPHO.withdraw(params, assets, 0, address(this), receiver);
            emit RedeemPaidAtOnce(msg.sender, receiver, assets);
            return (0, assets, true);
        }

        requestId = nextRequestId++;
        requests[requestId] = Request({
            owner: receiver,
            requester: msg.sender,
            assets: assets,
            queuedAtMs: uint64(MsClock.nowMs()),
            queuedBlock: uint64(block.number),
            settledAtMs: 0,
            settledBlock: 0
        });
        queuedAssets += assets;
        pendingAssets[receiver] += assets;
        emit RedeemQueued(requestId, receiver, assets);
    }

    /// @notice Pays the queue from the front, in order, while the market has cash for the next request.
    /// Open to anyone; it can only ever pay the people who are owed.
    /// @param maxItems Upper bound on requests paid in this call, to bound gas.
    /// @return settled Requests paid in this call.
    /// @return more True when the next request could also be paid right now.
    function settle(uint256 maxItems) external nonReentrant returns (uint256 settled, bool more) {
        MarketParams memory params = marketParams();
        MORPHO.accrueInterest(params);

        while (head < nextRequestId) {
            Request memory request = requests[head];
            if (request.assets > withdrawable()) break;
            if (settled == maxItems) return (settled, true);

            requests[head].settledAtMs = uint64(MsClock.nowMs());
            requests[head].settledBlock = uint64(block.number);
            delete claimApproval[head];
            queuedAssets -= request.assets;
            pendingAssets[request.owner] -= request.assets;
            emit RedeemSettled(head, request.owner, request.assets);
            head++;
            settled++;

            MORPHO.withdraw(params, request.assets, 0, address(this), address(this));
            _payOut(request.owner, request.assets);
        }
    }

    /// @dev A payout that fails (a blocked or reverting receiver) must not stall everyone behind it.
    function _payOut(address owner, uint256 assets) private {
        if (!IERC20(asset()).trySafeTransfer(owner, assets)) {
            unpaid[owner] += assets;
            emit PayoutHeld(owner, assets);
        }
    }

    /// @notice Collects payouts that could not be delivered during `settle`.
    function claimUnpaid(address to) external nonReentrant returns (uint256 assets) {
        assets = unpaid[msg.sender];
        if (assets == 0) revert NothingUnpaid();
        unpaid[msg.sender] = 0;
        IERC20(asset()).safeTransfer(to, assets);
    }

    // ----------------------------------------------------------------- claims

    function approveClaim(uint256 requestId, address spender) external {
        if (requests[requestId].owner != msg.sender) revert NotClaimOwnerOrApproved();
        claimApproval[requestId] = spender;
        emit ClaimApproved(requestId, msg.sender, spender);
    }

    /// @notice Hands a place in the queue to `to`. The place keeps its position and amount.
    function transferClaim(uint256 requestId, address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        Request storage request = requests[requestId];
        address from = request.owner;
        if (from == address(0)) revert UnknownRequest();
        if (requestId < head) revert AlreadySettled();
        if (msg.sender != from && msg.sender != claimApproval[requestId]) revert NotClaimOwnerOrApproved();

        delete claimApproval[requestId];
        request.owner = to;
        pendingAssets[from] -= request.assets;
        pendingAssets[to] += request.assets;
        emit ClaimTransferred(requestId, from, to, request.assets);
    }

    /// @dev Matches Morpho's own offset so the first depositor cannot inflate the share price.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }
}
