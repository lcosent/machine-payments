import type { Address, Hex } from 'viem';
import { CREDIT_LINE_ABI, USDC_ABI } from './abis.js';
import type { AutoComputePublicClient } from './client.js';
import { usdToUsdc6 } from './escrow.js';
import type { AgentWallet } from './wallet.js';

export const drawCredit = async (input: {
  creditLine: Address;
  wallet: AgentWallet;
  amountUsd: number;
}): Promise<Hex> => {
  const client = input.wallet.raw();
  return client.writeContract({
    account: input.wallet.address,
    chain: client.chain!,
    address: input.creditLine,
    abi: CREDIT_LINE_ABI,
    functionName: 'borrow',
    args: [usdToUsdc6(input.amountUsd)],
  });
};

export const repayCredit = async (input: {
  creditLine: Address;
  usdc: Address;
  wallet: AgentWallet;
  amountUsd: number;
}): Promise<{ approveTx: Hex; repayTx: Hex }> => {
  const amount = usdToUsdc6(input.amountUsd);
  const client = input.wallet.raw();

  const approveTx = await client.writeContract({
    account: input.wallet.address,
    chain: client.chain!,
    address: input.usdc,
    abi: USDC_ABI,
    functionName: 'approve',
    args: [input.creditLine, amount],
  });
  const repayTx = await client.writeContract({
    account: input.wallet.address,
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
