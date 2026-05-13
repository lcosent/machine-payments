import type { Address, Hex } from 'viem';
import { CREDIT_LINE_ABI, USDC_ABI } from './abis.js';
import { makePublicClient, type AutoComputePublicClient } from './client.js';
import { usdToUsdc6 } from './escrow.js';
import type { AgentWallet } from './wallet.js';

/// Borrow USDC from CreditLine, automatically posting collateral first when
/// the account is under-collateralized. The contract enforces `principal *
/// 10_000 <= collateral * ltvBps`, so we deposit enough collateral to make
/// the post-borrow position healthy. Collateral and debt are both USDC in
/// this PoC, so the wallet must hold ≥ `requiredCollateral` USDC before the
/// call (the agent funds this from its own balance).
export const drawCredit = async (input: {
  creditLine: Address;
  usdc: Address;
  wallet: AgentWallet;
  amountUsd: number;
  publicClient?: AutoComputePublicClient;
}): Promise<{ depositTx: Hex | null; approveTx: Hex | null; borrowTx: Hex }> => {
  const client = input.wallet.raw();
  const reader = input.publicClient ?? defaultReader(client);

  const amount = usdToUsdc6(input.amountUsd);
  const account = await readCreditAccount(reader, input.creditLine, input.wallet.address);
  const ltvBps = (await reader.readContract({
    address: input.creditLine,
    abi: CREDIT_LINE_ABI,
    functionName: 'ltvBps',
  })) as number;

  const BPS = 10_000n;
  const newPrincipal = account.principal + amount;
  // collateralNeeded such that newPrincipal * BPS <= collateralNeeded * ltvBps
  const collateralNeeded = (newPrincipal * BPS + BigInt(ltvBps) - 1n) / BigInt(ltvBps);
  let depositTx: Hex | null = null;
  let approveTx: Hex | null = null;
  if (account.collateral < collateralNeeded) {
    const delta = collateralNeeded - account.collateral;
    approveTx = await client.writeContract({
      account: client.account!,
      chain: client.chain!,
      address: input.usdc,
      abi: USDC_ABI,
      functionName: 'approve',
      args: [input.creditLine, delta],
    });
    // Allowance must be visible before depositCollateral's transferFrom runs.
    await reader.waitForTransactionReceipt({ hash: approveTx });
    depositTx = await client.writeContract({
      account: client.account!,
      chain: client.chain!,
      address: input.creditLine,
      abi: CREDIT_LINE_ABI,
      functionName: 'depositCollateral',
      args: [delta],
    });
    await reader.waitForTransactionReceipt({ hash: depositTx });
  }

  const borrowTx = await client.writeContract({
    account: client.account!,
    chain: client.chain!,
    address: input.creditLine,
    abi: CREDIT_LINE_ABI,
    functionName: 'borrow',
    args: [amount],
  });
  // Wait for the borrow to mine so a subsequent repay sees non-zero principal.
  await reader.waitForTransactionReceipt({ hash: borrowTx });
  return { depositTx, approveTx, borrowTx };
};

const defaultReader = (walletClient: ReturnType<AgentWallet['raw']>): AutoComputePublicClient => {
  const url = (walletClient.transport as { url?: string }).url;
  if (!url) throw new Error('cannot build default reader: wallet transport has no url');
  return makePublicClient(url);
};

export const repayCredit = async (input: {
  creditLine: Address;
  usdc: Address;
  wallet: AgentWallet;
  amountUsd: number;
  publicClient?: AutoComputePublicClient;
}): Promise<{ approveTx: Hex; repayTx: Hex }> => {
  const amount = usdToUsdc6(input.amountUsd);
  const client = input.wallet.raw();
  const reader = input.publicClient ?? defaultReader(client);

  const approveTx = await client.writeContract({
    account: client.account!,
    chain: client.chain!,
    address: input.usdc,
    abi: USDC_ABI,
    functionName: 'approve',
    args: [input.creditLine, amount],
  });
  // Allowance must be visible before repay's transferFrom runs.
  await reader.waitForTransactionReceipt({ hash: approveTx });
  const repayTx = await client.writeContract({
    account: client.account!,
    chain: client.chain!,
    address: input.creditLine,
    abi: CREDIT_LINE_ABI,
    functionName: 'repay',
    args: [amount],
  });
  return { approveTx, repayTx };
};

export const readCreditAccount = async (
  client: AutoComputePublicClient,
  creditLine: Address,
  account: Address,
): Promise<{ collateral: bigint; principal: bigint; lastAccrual: bigint }> => {
  const result = (await client.readContract({
    address: creditLine,
    abi: CREDIT_LINE_ABI,
    functionName: 'accounts',
    args: [account],
  })) as readonly [bigint, bigint, bigint];
  return { collateral: result[0], principal: result[1], lastAccrual: result[2] };
};
