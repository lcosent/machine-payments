# contracts

Foundry workspace for AutoCompute's onchain primitives.

## Setup (first time)

```bash
cd contracts
forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git
forge install foundry-rs/forge-std --no-git
forge build
forge test
```

## Contracts

- `src/Escrow.sol` — per-job USDC escrow. Job is opened with a max amount and
  an MPP intent-receipt hash; provider settles for ≤ max with a signature
  over `(jobId, finalAmount)`; remainder refunds to wallet on settle, anyone
  can refund the full amount after `deadline`.
- `src/CreditLine.sol` — minimal overcollateralized USDC credit line.
  Principal deposits collateral, the agent's smart wallet borrows up to LTV,
  simple interest accrues on borrowed balance, anyone can liquidate when LTV
  is breached.

## Deploy (Base Sepolia)

```bash
forge script script/Deploy.s.sol:Deploy \
  --rpc-url $BASE_SEPOLIA_RPC \
  --broadcast \
  --private-key $DEPLOYER_PRIVATE_KEY
```

Addresses are emitted to stdout; copy them into the root `.env`.
