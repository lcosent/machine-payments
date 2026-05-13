import { decodeEventLog, type Address, type Hex } from 'viem';
import { ESCROW_ABI, USDC_ABI } from './abis.js';
import type { AutoComputePublicClient } from './client.js';
import { makePublicClient } from './client.js';
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
  /// Optional reader for `waitForTransactionReceipt`. Defaults to a public
  /// client built from the wallet's RPC URL. Pass an existing client to
  /// share connection pooling across many opens.
  publicClient?: AutoComputePublicClient;
}

/// Approve + openJob in two transactions for clarity. A smart-wallet impl can
/// batch these into a single user-op when ERC-4337 wiring lands.
///
/// Returns the on-chain `jobId` (uint256 from `Escrow.JobOpened`) so callers
/// can later call `settle(jobId, ...)`. Resolving the jobId requires waiting
/// for the openJob tx to be mined and decoding the emitted event.
export interface OpenJobOutput {
  approveTx: Hex;
  openTx: Hex;
  jobId: bigint;
}

export const openEscrowJob = async (input: OpenJobInput): Promise<OpenJobOutput> => {
  const amount = usdToUsdc6(input.amountUsd);
  const client = input.wallet.raw();
  // Use the wallet's bound local Account, not the address. Passing an address
  // string makes viem dispatch to eth_sendTransaction (json-rpc account), which
  // public RPCs reject with "unknown account". The local Account triggers
  // eth_sendRawTransaction with a client-side signature.
  const account = client.account!;

  const approveTx = await client.writeContract({
    account,
    chain: client.chain!,
    address: input.usdc,
    abi: USDC_ABI,
    functionName: 'approve',
    args: [input.escrow, amount],
  });
  // Wait for the approve to be mined so openJob's transferFrom sees the
  // allowance. Without this, on networks with non-trivial block time the
  // openJob tx lands before the allowance is observable and reverts with
  // ERC20: transfer amount exceeds allowance.
  const earlyReader = input.publicClient ?? defaultReader(client);
  await earlyReader.waitForTransactionReceipt({ hash: approveTx });

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

  const reader = input.publicClient ?? defaultReader(client);
  const receipt = await reader.waitForTransactionReceipt({ hash: openTx });
  const jobId = decodeJobOpenedJobId(receipt.logs, input.escrow);
  if (jobId === null) {
    throw new Error(
      `openJob tx ${openTx} mined but no Escrow.JobOpened event found for ${input.escrow}`,
    );
  }
  return { approveTx, openTx, jobId };
};

/// Decode the JobOpened.jobId from a tx's logs. Exported for tests +
/// fallback callers that already have a receipt in hand.
export const decodeJobOpenedJobId = (
  logs: ReadonlyArray<{ address: Address; topics: ReadonlyArray<Hex>; data: Hex }>,
  escrow: Address,
): bigint | null => {
  for (const log of logs) {
    if (log.address.toLowerCase() !== escrow.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: ESCROW_ABI,
        data: log.data,
        topics: [...log.topics] as [Hex, ...Hex[]],
      });
      if (decoded.eventName === 'JobOpened') {
        const args = decoded.args as { jobId: bigint };
        return args.jobId;
      }
    } catch {
      // Not a JobOpened log — keep scanning.
    }
  }
  return null;
};

const defaultReader = (walletClient: ReturnType<AgentWallet['raw']>): AutoComputePublicClient => {
  const url = (walletClient.transport as { url?: string }).url;
  if (!url) throw new Error('cannot build default reader: wallet transport has no url');
  return makePublicClient(url);
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
    account: client.account!,
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
