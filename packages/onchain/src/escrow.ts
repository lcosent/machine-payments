import type { Address, Hex } from 'viem';
import { ESCROW_ABI, USDC_ABI } from './abis.js';
import type { AutoComputePublicClient } from './client.js';
import type { AgentWallet } from './wallet.js';

const USDC_DECIMALS = 6n;

export const usdToUsdc6 = (usd: number): bigint => {
  if (!Number.isFinite(usd) || usd < 0) throw new Error('usd must be a non-negative finite number');
  const cents = Math.round(usd * 100);
  return BigInt(cents) * 10n ** (USDC_DECIMALS - 2n);
};

export interface OpenJobInput {
  escrow: Address;
  usdc: Address;
  wallet: AgentWallet;
  provider: Address;
  amountUsd: number;
  deadlineUnixSec: number;
  intentHash: Hex;
  taskIdBytes32: Hex;
}

/// Approve + openJob in two transactions for clarity. A smart-wallet impl can
/// batch these into a single user-op when ERC-4337 wiring lands.
export const openEscrowJob = async (
  input: OpenJobInput,
): Promise<{ approveTx: Hex; openTx: Hex }> => {
  const amount = usdToUsdc6(input.amountUsd);
  const client = input.wallet.raw();
  const account = input.wallet.address;

  const approveTx = await client.writeContract({
    account,
    chain: client.chain!,
    address: input.usdc,
    abi: USDC_ABI,
    functionName: 'approve',
    args: [input.escrow, amount],
  });

  const openTx = await client.writeContract({
    account,
    chain: client.chain!,
    address: input.escrow,
    abi: ESCROW_ABI,
    functionName: 'openJob',
    args: [
      input.provider,
      amount,
      BigInt(input.deadlineUnixSec),
      input.intentHash,
      input.taskIdBytes32,
    ],
  });

  return { approveTx, openTx };
};

export const settleEscrowJob = async (input: {
  escrow: Address;
  wallet: AgentWallet;
  jobId: bigint;
  finalAmountUsd: number;
  providerSig: Hex;
}): Promise<Hex> => {
  const amount = usdToUsdc6(input.finalAmountUsd);
  const client = input.wallet.raw();
  return client.writeContract({
    account: input.wallet.address,
    chain: client.chain!,
    address: input.escrow,
    abi: ESCROW_ABI,
    functionName: 'settle',
    args: [input.jobId, amount, input.providerSig],
  });
};

export const readUsdcBalance = (
  client: AutoComputePublicClient,
  usdc: Address,
  account: Address,
): Promise<bigint> =>
  client.readContract({
    address: usdc,
    abi: USDC_ABI,
    functionName: 'balanceOf',
    args: [account],
  });
