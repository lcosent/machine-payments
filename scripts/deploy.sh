#!/usr/bin/env bash
# Deploy Escrow.sol + CreditLine.sol to Base Sepolia and (optionally) seed
# the CreditLine with USDC. Run locally — forge isn't in this sandbox.
#
# Required env:
#   BASE_SEPOLIA_RPC          e.g. https://sepolia.base.org
#   DEPLOYER_PRIVATE_KEY      raw 0x-hex
#   USDC_ADDRESS              Base Sepolia USDC: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
#
# Optional:
#   CREDIT_LINE_SEED_USDC6    USDC (6dp) to deposit into the pool at deploy time
#                              (default 0). Deployer must hold + approve this amount.

set -euo pipefail

: "${BASE_SEPOLIA_RPC:?missing BASE_SEPOLIA_RPC}"
: "${DEPLOYER_PRIVATE_KEY:?missing DEPLOYER_PRIVATE_KEY}"
: "${USDC_ADDRESS:?missing USDC_ADDRESS}"

cd "$(dirname "$0")/../contracts"

if [ ! -d "lib/forge-std" ] || [ ! -d "lib/openzeppelin-contracts" ]; then
  echo "==> installing Foundry deps (one-time)"
  forge install --no-git foundry-rs/forge-std
  forge install --no-git OpenZeppelin/openzeppelin-contracts@v5.1.0
fi

echo "==> forge build"
forge build

echo "==> deploy to Base Sepolia"
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$BASE_SEPOLIA_RPC" \
  --broadcast \
  --private-key "$DEPLOYER_PRIVATE_KEY"

echo
echo "==> copy the printed ESCROW_ADDRESS / CREDIT_LINE_ADDRESS values into your .env"
