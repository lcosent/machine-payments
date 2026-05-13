import {
  createWalletClient,
  http,
  type Account,
  type Address,
  type Hex,
  type WalletClient,
} from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

/// The agent's transaction surface. Today: an EOA via viem. Tomorrow: an
/// ERC-4337 smart wallet via the same interface. Anything that spends money
/// must go through this port so the swap is mechanical.
export interface AgentWallet {
  readonly address: Address;
  signMessage(message: string): Promise<Hex>;
  /// Returns the inner viem client for contract writes. A smart-wallet impl
  /// will wrap user-op submission behind the same shape.
  raw(): WalletClient;
}

export const makeEoaWallet = (privateKey: Hex, rpcUrl: string): AgentWallet => {
  const account: Account = privateKeyToAccount(privateKey);
  const client = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) });
  return {
    address: account.address,
    signMessage: (message) => client.signMessage({ message }),
    raw: () => client,
  };
};
