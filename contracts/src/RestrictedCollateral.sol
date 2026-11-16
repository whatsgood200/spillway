// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title RestrictedCollateral
/// @notice Collateral for the demo market. Only addresses the owner approves can mint it, and only they can
/// receive it, so only approved borrowers can borrow from the market. A stranger can neither mint it nor be sent
/// any to borrow against.
contract RestrictedCollateral is ERC20, Ownable {
    mapping(address account => bool) public approved;

    event Approved(address indexed account, bool isApproved);

    error NotApproved(address account);

    /// @param morpho_ The lending market contract, which must be able to hold the collateral it secures.
    constructor(address owner_, address morpho_, address[] memory approved_) ERC20("Spillway Demo Collateral", "sdCOL") Ownable(owner_) {
        _setApproved(morpho_, true);
        for (uint256 i; i < approved_.length; i++) {
            _setApproved(approved_[i], true);
        }
    }

    function setApproved(address account, bool isApproved) external onlyOwner {
        _setApproved(account, isApproved);
    }

    function mint(address to, uint256 amount) external {
        if (!approved[msg.sender]) revert NotApproved(msg.sender);
        _mint(to, amount);
    }

    /// @dev Every holder must be approved, so collateral cannot be passed to a stranger to borrow with.
    function _update(address from, address to, uint256 value) internal override {
        if (to != address(0) && !approved[to]) revert NotApproved(to);
        super._update(from, to, value);
    }

    function _setApproved(address account, bool isApproved) private {
        approved[account] = isApproved;
        emit Approved(account, isApproved);
    }
}
