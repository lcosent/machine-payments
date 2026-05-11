import { createPublicClient, http, type Address } from 'viem';
import { baseSepolia } from 'viem/chains';

export interface ChainConfig {
  rpcUrl: string;
  usdc: Address;
  escrow: Address;
  creditLine: Address;
}

export const readChainConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): ChainConfig => {
  const required = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`missing env var: ${k}`);
    return v;
  };
  const asAddr = (k: string): Address => {
    const v = required(k);
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`env ${k} is not a 0x address`);
    return v as Address;
  };
  return {
    rpcUrl: required('BASE_SEPOLIA_RPC'),
    usdc: asAddr('USDC_ADDRESS'),
    escrow: asAddr('ESCROW_ADDRESS'),
    creditLine: asAddr('CREDIT_LINE_ADDRESS'),
  };
};

export const makePublicClient = (rpcUrl: string) =>
  createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });

export type AutoComputePublicClient = ReturnType<typeof makePublicClient>;
