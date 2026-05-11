// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title Escrow — per-job USDC escrow for agent payments to compute providers
/// @notice An MPP intent-receipt hash is stored on-chain when a job opens. The
///         provider settles for ≤ the funded amount, signed over (jobId, final).
///         Anything left over refunds to the payer. Anyone can force-refund
///         after `deadline` if the provider never settles.
contract Escrow {
    using SafeERC20 for IERC20;

    enum JobStatus {
        None,
        Open,
        Settled,
        Refunded
    }

    struct Job {
        address payer;
        address provider;
        uint96 amount;
        uint64 deadline;
        JobStatus status;
        bytes32 intentHash;
        bytes32 taskId;
    }

    IERC20 public immutable usdc;
    uint256 public nextJobId = 1;
    mapping(uint256 jobId => Job) public jobs;

    event JobOpened(
        uint256 indexed jobId,
        address indexed payer,
        address indexed provider,
        uint96 amount,
        uint64 deadline,
        bytes32 intentHash,
        bytes32 taskId
    );
    event JobMetered(uint256 indexed jobId, uint16 progressBps, uint96 consumed);
    event JobSettled(uint256 indexed jobId, uint96 finalAmount, uint96 refunded);
    event JobRefunded(uint256 indexed jobId, uint96 refunded);

    error WrongStatus();
    error ZeroAmount();
    error DeadlineInPast();
    error FinalExceedsAmount();
    error NotProvider();
    error NotPayer();
    error BadProviderSignature();
    error NotYetExpired();
    error UsedIntent();

    /// @dev Replay protection: each intentHash may open at most one job.
    mapping(bytes32 intentHash => bool) public intentUsed;

    constructor(IERC20 usdc_) {
        usdc = usdc_;
    }

    /// @notice Open a job: pulls `amount` USDC from caller into escrow.
    /// @dev Caller must `approve` `amount` to this contract first.
    function openJob(
        address provider,
        uint96 amount,
        uint64 deadline,
        bytes32 intentHash,
        bytes32 taskId
    ) external returns (uint256 jobId) {
        if (amount == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert DeadlineInPast();
        if (intentUsed[intentHash]) revert UsedIntent();
        intentUsed[intentHash] = true;

        jobId = nextJobId++;
        jobs[jobId] = Job({
            payer: msg.sender,
            provider: provider,
            amount: amount,
            deadline: deadline,
            status: JobStatus.Open,
            intentHash: intentHash,
            taskId: taskId
        });

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit JobOpened(jobId, msg.sender, provider, amount, deadline, intentHash, taskId);
    }

    /// @notice Provider-callable advisory metering. Doesn't move funds.
    function meter(uint256 jobId, uint16 progressBps, uint96 consumed) external {
        Job storage j = jobs[jobId];
        if (j.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != j.provider) revert NotProvider();
        emit JobMetered(jobId, progressBps, consumed);
    }

    /// @notice Settle the job. The provider's signature authorizes a final amount
    ///         ≤ the funded `amount`; remainder refunds to the payer.
    function settle(uint256 jobId, uint96 finalAmount, bytes calldata providerSig) external {
        Job storage j = jobs[jobId];
        if (j.status != JobStatus.Open) revert WrongStatus();
        if (finalAmount > j.amount) revert FinalExceedsAmount();

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encodePacked(address(this), jobId, finalAmount))
        );
        if (ECDSA.recover(digest, providerSig) != j.provider) revert BadProviderSignature();

        j.status = JobStatus.Settled;

        uint96 refund = j.amount - finalAmount;
        if (finalAmount > 0) usdc.safeTransfer(j.provider, finalAmount);
        if (refund > 0) usdc.safeTransfer(j.payer, refund);

        emit JobSettled(jobId, finalAmount, refund);
    }

    /// @notice After `deadline`, anyone can trigger a full refund to the payer.
    function refund(uint256 jobId) external {
        Job storage j = jobs[jobId];
        if (j.status != JobStatus.Open) revert WrongStatus();
        if (block.timestamp < j.deadline) revert NotYetExpired();

        j.status = JobStatus.Refunded;
        uint96 amount = j.amount;
        usdc.safeTransfer(j.payer, amount);
        emit JobRefunded(jobId, amount);
    }
}
