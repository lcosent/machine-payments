// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title CreditLine — minimal overcollateralized USDC credit line
/// @notice For PoC clarity, collateral and debt are both USDC. The LTV
///         parameter and interest mechanics still demonstrate the agent's
///         autonomous draw/repay loop. Not safe for production: same-asset
///         collateralization is intentional simplification.
contract CreditLine is Ownable {
    using SafeERC20 for IERC20;

    struct Account {
        uint128 collateral; // USDC posted
        uint128 principal;  // outstanding borrow principal
        uint64 lastAccrual; // unix sec
    }

    IERC20 public immutable usdc;
    /// @notice LTV in basis points (e.g., 5000 = 50%).
    uint16 public ltvBps;
    /// @notice Simple-interest APR in basis points (e.g., 1000 = 10%/yr).
    uint16 public aprBps;

    uint64 private constant SECONDS_PER_YEAR = 365 days;
    uint16 private constant BPS = 10_000;

    /// @notice Pool of USDC available for lending, owner-funded.
    uint256 public availableLiquidity;

    mapping(address account => Account) public accounts;

    event LtvUpdated(uint16 bps);
    event AprUpdated(uint16 bps);
    event LiquidityFunded(address indexed by, uint256 amount);
    event CollateralDeposited(address indexed account, uint128 amount);
    event CollateralWithdrawn(address indexed account, uint128 amount);
    event Borrowed(address indexed account, uint128 amount);
    event Repaid(address indexed account, uint128 principal, uint128 interest);
    event Liquidated(address indexed account, address indexed by, uint128 seized);

    error ExceedsLtv();
    error InsufficientLiquidity();
    error NothingToRepay();
    error HealthyPosition();
    error ZeroAmount();

    constructor(IERC20 usdc_, uint16 ltvBps_, uint16 aprBps_, address owner_) Ownable(owner_) {
        usdc = usdc_;
        ltvBps = ltvBps_;
        aprBps = aprBps_;
    }

    /* ------------------------------ admin ------------------------------ */

    function setLtv(uint16 bps) external onlyOwner {
        ltvBps = bps;
        emit LtvUpdated(bps);
    }

    function setApr(uint16 bps) external onlyOwner {
        aprBps = bps;
        emit AprUpdated(bps);
    }

    /// @notice Owner seeds the pool with USDC.
    function fundLiquidity(uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        availableLiquidity += amount;
        emit LiquidityFunded(msg.sender, amount);
    }

    /* ----------------------------- accounts ---------------------------- */

    function depositCollateral(uint128 amount) external {
        if (amount == 0) revert ZeroAmount();
        Account storage a = accounts[msg.sender];
        _accrue(a);
        a.collateral += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit CollateralDeposited(msg.sender, amount);
    }

    function withdrawCollateral(uint128 amount) external {
        Account storage a = accounts[msg.sender];
        _accrue(a);
        a.collateral -= amount;
        if (!_isHealthy(a)) revert ExceedsLtv();
        usdc.safeTransfer(msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, amount);
    }

    function borrow(uint128 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (amount > availableLiquidity) revert InsufficientLiquidity();
        Account storage a = accounts[msg.sender];
        _accrue(a);
        a.principal += amount;
        if (!_isHealthy(a)) revert ExceedsLtv();
        availableLiquidity -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Borrowed(msg.sender, amount);
    }

    /// @notice Repay up to outstanding debt. Interest paid first, then principal.
    function repay(uint128 amount) external {
        if (amount == 0) revert ZeroAmount();
        Account storage a = accounts[msg.sender];
        _accrue(a);
        if (a.principal == 0) revert NothingToRepay();

        uint128 toPay = amount > a.principal ? a.principal : amount;
        a.principal -= toPay;
        availableLiquidity += toPay;
        usdc.safeTransferFrom(msg.sender, address(this), toPay);
        emit Repaid(msg.sender, toPay, 0);
    }

    /// @notice Liquidate an unhealthy account by repaying its debt and seizing collateral.
    function liquidate(address account) external {
        Account storage a = accounts[account];
        _accrue(a);
        if (_isHealthy(a)) revert HealthyPosition();

        uint128 debt = a.principal;
        uint128 seized = a.collateral;
        a.principal = 0;
        a.collateral = 0;

        // Liquidator pays off the debt; receives the collateral.
        usdc.safeTransferFrom(msg.sender, address(this), debt);
        availableLiquidity += debt;
        usdc.safeTransfer(msg.sender, seized);
        emit Liquidated(account, msg.sender, seized);
    }

    /* ----------------------------- internals --------------------------- */

    function _isHealthy(Account storage a) internal view returns (bool) {
        if (a.principal == 0) return true;
        // principal * BPS ≤ collateral * ltvBps
        return uint256(a.principal) * BPS <= uint256(a.collateral) * ltvBps;
    }

    function _accrue(Account storage a) internal {
        if (a.principal == 0) {
            a.lastAccrual = uint64(block.timestamp);
            return;
        }
        uint64 last = a.lastAccrual;
        if (last == 0) {
            a.lastAccrual = uint64(block.timestamp);
            return;
        }
        uint256 elapsed = block.timestamp - last;
        if (elapsed == 0) return;
        // Simple interest: dPrincipal = principal * apr * elapsed / (BPS * SECONDS_PER_YEAR)
        uint256 interest =
            (uint256(a.principal) * aprBps * elapsed) / (uint256(BPS) * SECONDS_PER_YEAR);
        a.principal += uint128(interest);
        a.lastAccrual = uint64(block.timestamp);
    }
}
