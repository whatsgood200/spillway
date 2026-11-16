import { parseAbi } from "viem";

/** Deployed addresses, recorded in deployments.md. Base Sepolia unless noted. */
export const ADDRESSES = {
  vault: "0x8a430D6472Fbf703233BA5083e134B490d2f60F6",
  pool: "0x13d683F223E908A7BA615e4498fa5b4E392D3334",
  callback: "0x6C78012f837B5A4602c9098D68e95F070018823D",
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  collateral: "0x5Cab8749ec7F208e19211381FD185dC6e448D857",
  /** Reactive Lasna */
  reactor: "0x943d4252c759249D24D375E855B0a3caf13DB874",
} as const;

export const MARKET_ID = "0xf292f6924b2a0311cd8530d19d6d0edd9b7447a5bab1c1bd1663d49a14d6000c" as const;

export const BASE_SEPOLIA_ID = 84532;
export const BASE_SEPOLIA_RPC = process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
export const LASNA_RPC = "https://lasna-rpc.rnk.dev/";
export const BLOCKSCOUT_API = "https://base-sepolia.blockscout.com/api";

/** First blocks worth scanning: just before our deployments. */
export const BASE_DEPLOY_BLOCK = 59_642_300;
export const LASNA_DEPLOY_BLOCK = 8_506_700;

export const EXPLORER = {
  "base-sepolia": "https://sepolia.basescan.org/tx/",
  lasna: "https://lasna.reactscan.net/tx/",
} as const;

export const vaultAbi = parseAbi([
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function requestRedeem(uint256 shares, address receiver) returns (uint256 requestId, uint256 assets, bool paidAtOnce)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approveClaim(uint256 requestId, address spender)",
  "function balanceOf(address owner) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function suppliedAssets() view returns (uint256)",
  "function withdrawable() view returns (uint256)",
  "function queueLength() view returns (uint256)",
  "function queuedAssets() view returns (uint256)",
  "function pendingAssets(address owner) view returns (uint256)",
  "function queueSlice(uint256 offset, uint256 limit) view returns (uint256[] ids, address[] owners, uint256[] amounts)",
  "function nextRequestId() view returns (uint256)",
  "struct Request { address owner; address requester; uint256 assets; uint256 paid; uint64 queuedAtMs; uint64 queuedBlock; uint64 settledAtMs; uint64 settledBlock; }",
  "function stillOwed(uint256 requestId) view returns (uint256)",
  "function requestsSlice(uint256 firstId, uint256 limit) view returns (Request[] page)",
  "event RedeemQueued(uint256 indexed requestId, address indexed owner, uint256 assets)",
  "event RedeemSettled(uint256 indexed requestId, address indexed owner, uint256 assets)",
  "event RedeemPaidAtOnce(address indexed owner, address indexed receiver, uint256 assets)",
  "event RedeemPartlyPaid(uint256 indexed requestId, address indexed owner, uint256 part, uint256 stillOwed)",
  "event ClaimTransferred(uint256 indexed requestId, address indexed from, address indexed to, uint256 stillOwed)",
  "error RequestTooSmall(uint256 assets, uint256 minimum)",
  "error NotClaimOwnerOrApproved()",
  "error UnknownRequest()",
]);

export const poolAbi = parseAbi([
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function idle() view returns (uint256)",
  "function feeBps(uint256 assets, uint256 ahead) view returns (uint256)",
  "function quoteClaim(uint256 requestId) view returns (uint256 receiveAmount, uint256 fee, uint256 bps, bool available)",
  "function unlocksAt(address account) view returns (uint256)",
  "function quote(uint256 assets) view returns (uint256 receiveAmount, uint256 fee, uint256 bps, bool available)",
  "function cashOut(uint256 shares, uint256 minReceive, address receiver) returns (uint256)",
  "function buyClaim(uint256 requestId, uint256 minReceive, address receiver) returns (uint256)",
  "function sales(uint256 requestId) view returns (address seller, uint256 assets, uint256 paid, uint256 fee, uint64 atMs, uint64 atBlock)",
  "function feesCharged() view returns (uint256)",
  "event ClaimBought(uint256 indexed requestId, address indexed seller, uint256 assets, uint256 paid, uint256 fee)",
  "event PassedThrough(address indexed seller, uint256 assets)",
  "error ReceiveBelowMinimum(uint256 receiveAmount, uint256 minimum)",
  "error NotEnoughCash(uint256 needed, uint256 idle)",
  "error NotClaimOwner()",
]);

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 value) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function mint(address to, uint256 amount)",
]);

export const callbackAbi = parseAbi([
  "event LoopClosed(uint256 indexed originTxHash, uint256 originBlock, uint256 settled, uint256 paidAtMs, bool more)",
  "struct Loop { uint256 originTxHash; uint64 originBlock; uint64 payoutBlock; uint64 paidAtMs; uint32 settled; uint256 assets; }",
  "function loopCount() view returns (uint256)",
  "function loopsSlice(uint256 offset, uint256 limit) view returns (Loop[] page)",
]);

export const reactorAbi = parseAbi(["event CallbackRequested(uint256 indexed originTxHash, uint256 originBlock)"]);

export const morphoAbi = parseAbi([
  "struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }",
  "function idToMarketParams(bytes32 id) view returns (MarketParams)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function supplyCollateral(MarketParams marketParams, uint256 assets, address onBehalf, bytes data)",
  "function borrow(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)",
  "function repay(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)",
]);
