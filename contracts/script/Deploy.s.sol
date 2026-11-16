// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {IOracle} from "morpho-blue/interfaces/IOracle.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {QueueVault} from "../src/QueueVault.sol";
import {InstantPool} from "../src/InstantPool.sol";
import {QueueReactor} from "../src/QueueReactor.sol";
import {SpillwayCallback} from "../src/SpillwayCallback.sol";
import {RestrictedCollateral} from "../src/RestrictedCollateral.sol";

/// @notice Fixed price oracle for the demo market: 1 sdCOL (18 decimals) = 2,000 USDC (6 decimals).
/// Safe here because only approved borrowers can hold the collateral it prices.
contract DemoOracle is IOracle {
    uint256 public constant price = 2000 * 1e6 * 1e36 / 1e18;
}

/// The approved borrowers: the deployer and the demo account the web app signs with. Override with BORROWERS.
abstract contract Borrowers is Script {
    address internal constant DEMO_ACCOUNT = 0x030ACe00e679c850cF01c6eE596bbFbf157fB931;

    function _borrowers(address deployer) internal view returns (address[] memory list) {
        address[] memory fromEnv = vm.envOr("BORROWERS", ",", new address[](0));
        if (fromEnv.length > 0) return fromEnv;
        list = new address[](2);
        list[0] = deployer;
        list[1] = DEMO_ACCOUNT;
    }
}

/// Deployment runs in four steps across two chains. Each step prints the addresses the next one needs.
/// The deployer key comes from an encrypted Foundry keystore (--account), never from a file or the environment.
///
/// 1. Base Sepolia:   forge script script/Deploy.s.sol:DeployOrigin   --rpc-url base_sepolia --account spillway --broadcast
/// 2. Reactive Lasna: MARKET_ID=0x.. forge script script/Deploy.s.sol:DeployReactor --rpc-url lasna --account spillway --broadcast
/// 3. Base Sepolia:   VAULT=0x.. REACTOR=0x.. forge script script/Deploy.s.sol:DeployCallback --rpc-url base_sepolia --account spillway --broadcast
/// 4. Reactive Lasna: REACTOR=0x.. CALLBACK=0x.. forge script script/Deploy.s.sol:WireReactor --rpc-url lasna --account spillway --broadcast
contract DeployOrigin is Borrowers {
    using MarketParamsLib for MarketParams;

    IMorpho internal constant MORPHO = IMorpho(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    address internal constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address internal constant ADAPTIVE_CURVE_IRM = 0x46415998764C29aB2a25CbeA6254146D50D22687;

    function run() external {
        require(block.chainid == 84532, "run on Base Sepolia");
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        RestrictedCollateral collateral = new RestrictedCollateral(deployer, address(MORPHO), _borrowers(deployer));
        DemoOracle oracle = new DemoOracle();
        MarketParams memory params = MarketParams({
            loanToken: USDC,
            collateralToken: address(collateral),
            oracle: address(oracle),
            irm: ADAPTIVE_CURVE_IRM,
            lltv: 0.86e18
        });
        MORPHO.createMarket(params);
        QueueVault vault = new QueueVault(IERC20(USDC), MORPHO, params, "Spillway USDC", "spUSDC");
        InstantPool pool = new InstantPool(vault, "Spillway Pool", "spPOOL");
        vm.stopBroadcast();

        console2.log("RestrictedCollateral", address(collateral));
        console2.log("DemoOracle          ", address(oracle));
        console2.log("QueueVault          ", address(vault));
        console2.log("InstantPool         ", address(pool));
        console2.log("MARKET_ID:");
        console2.logBytes32(Id.unwrap(params.id()));
    }
}

contract DeployReactor is Borrowers {
    address internal constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    uint256 internal constant BASE_SEPOLIA = 84532;

    function run() external {
        require(block.chainid == 5318007, "run on Reactive Lasna");
        bytes32 marketId = vm.envBytes32("MARKET_ID");
        uint256 funding = vm.envOr("REACTOR_FUNDING_WEI", uint256(2 ether));
        uint64 gasLimit = uint64(vm.envOr("CALLBACK_GAS_LIMIT", uint256(1_000_000)));
        uint256 maxItems = vm.envOr("MAX_ITEMS", uint256(4));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        QueueReactor reactor = new QueueReactor{value: funding}(BASE_SEPOLIA, MORPHO, marketId, _borrowers(deployer), gasLimit, maxItems);
        vm.stopBroadcast();
        console2.log("QueueReactor", address(reactor));
    }
}

contract DeployCallback is Script {
    address payable internal constant CALLBACK_PROXY = payable(0x476F44b11F5C942c58f4c8E3d0300E5710743585);

    function run() external {
        require(block.chainid == 84532, "run on Base Sepolia");
        address vault = vm.envAddress("VAULT");
        address reactor = vm.envAddress("REACTOR");
        uint256 funding = vm.envOr("CALLBACK_FUNDING_WEI", uint256(0.01 ether));

        vm.startBroadcast();
        SpillwayCallback callback = new SpillwayCallback{value: funding}(IPayable(CALLBACK_PROXY), reactor, QueueVault(vault));
        vm.stopBroadcast();
        console2.log("SpillwayCallback", address(callback));
    }
}

contract WireReactor is Script {
    function run() external {
        require(block.chainid == 5318007, "run on Reactive Lasna");
        address payable reactor = payable(vm.envAddress("REACTOR"));
        address callback = vm.envAddress("CALLBACK");
        vm.startBroadcast();
        QueueReactor(reactor).setCallbackContract(callback);
        vm.stopBroadcast();
        console2.log("Reactor wired to callback", callback);
    }
}
