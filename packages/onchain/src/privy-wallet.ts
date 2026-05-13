import { createWalletClient, http, type Address } from 'viem';
import { sepolia } from 'viem/chains';
import type { AgentWallet } from './wallet.js';

/// Subset of @privy-io/server-auth we lean on. Defined as a port so tests can
/// inject a mock and so a minor SDK version bump doesn't ripple beyond this
/// file. Real implementation: see `loadPrivyClientFromEnv` below.
export interface PrivyClientLike {
  walletApi: {
    createWallet(input: { chainType: 'ethereum' }): Promise<{ id: string; address: Address }>;
    getWallet(input: { id: string }): Promise<{ id: string; address: Address } | null>;
  };
  /// Privy ships `createViemAccount({ walletId, address, privy })` from
  /// `@privy-io/server-auth/viem`. We accept the produced viem `Account`
  /// here so this wrapper stays agnostic of which helper minted it.
}

export interface PrivyViemAccountFactory {
  /// Mirrors @privy-io/server-auth/viem `createViemAccount({...})`. Returns
  /// a viem `Account` that signs via Privy's HSM-managed wallet.
  createViemAccount(input: { walletId: string; address: Address }): Promise<{
    address: Address;
    signMessage: (params: {
      message: string | { raw: `0x${string}` | Uint8Array };
    }) => Promise<`0x${string}`>;
    type: 'local';
  }>;
}

export interface PrivyWalletConfig {
  rpcUrl: string;
  walletId: string;
  address: Address;
  /// Injected so tests don't need a live Privy app. In production this comes
  /// from `loadPrivyClientFromEnv()`.
  accountFactory: PrivyViemAccountFactory;
}

/// Build an AgentWallet backed by a Privy server-controlled wallet. The
/// wallet must already exist (use `scripts/provision-wallet.ts` to mint one);
/// this wrapper just attaches signing + transport.
export const makePrivyWallet = async (cfg: PrivyWalletConfig): Promise<AgentWallet> => {
  const account = await cfg.accountFactory.createViemAccount({
    walletId: cfg.walletId,
    address: cfg.address,
  });
  const client = createWalletClient({
    // viem's Account discriminates by `type`; Privy's account is `local`.
    account: account as unknown as Parameters<typeof createWalletClient>[0]['account'],
    chain: sepolia,
    transport: http(cfg.rpcUrl),
  });
  return {
    address: cfg.address,
    signMessage: (message) => account.signMessage({ message }),
    raw: () => client,
  };
};

export interface PrivyEnvConfig {
  appId: string;
  appSecret: string;
  /// Optional wallet authorization key — needed when Privy app is configured
  /// to require client-side authorization signatures. Most demo apps don't
  /// need it, but we forward it through when present.
  walletAuthorizationPrivateKey?: string;
}

export const readPrivyEnv = (
  env: Record<string, string | undefined> = process.env,
): PrivyEnvConfig | null => {
  const appId = env['PRIVY_APP_ID'];
  const appSecret = env['PRIVY_APP_SECRET'];
  if (!appId || !appSecret) return null;
  const out: PrivyEnvConfig = { appId, appSecret };
  const auth = env['PRIVY_WALLET_AUTHORIZATION_PRIVATE_KEY'];
  if (auth) out.walletAuthorizationPrivateKey = auth;
  return out;
};

/// Lazy-loads @privy-io/server-auth so the dependency is only needed by
/// callers that actually opt in. Throws a useful error when the package
/// isn't installed.
export const loadPrivyClient = async (
  cfg: PrivyEnvConfig,
): Promise<{ client: PrivyClientLike; accountFactory: PrivyViemAccountFactory }> => {
  let sdk: typeof import('@privy-io/server-auth');
  let viemHelper: typeof import('@privy-io/server-auth/viem');
  try {
    sdk = await import('@privy-io/server-auth');
    viemHelper = await import('@privy-io/server-auth/viem');
  } catch (e) {
    throw new Error(
      '@privy-io/server-auth is not installed. Run `pnpm add -w @privy-io/server-auth` (the dependency is opt-in).\n' +
        `Underlying error: ${(e as Error).message}`,
    );
  }

  const PrivyClient = sdk.PrivyClient;
  const privy = cfg.walletAuthorizationPrivateKey
    ? new PrivyClient(cfg.appId, cfg.appSecret, {
        walletApi: { authorizationPrivateKey: cfg.walletAuthorizationPrivateKey },
      })
    : new PrivyClient(cfg.appId, cfg.appSecret);

  const client: PrivyClientLike = {
    walletApi: {
      createWallet: ({ chainType }) =>
        privy.walletApi.createWallet({ chainType }) as Promise<{ id: string; address: Address }>,
      getWallet: ({ id }) =>
        privy.walletApi.getWallet({ id }).catch(() => null) as Promise<{
          id: string;
          address: Address;
        } | null>,
    },
  };
  // Privy's @privy-io/server-auth/viem sub-export carries its own copy of
  // the PrivyClient declarations, which trips a TS2719 "Two different types
  // with this name exist" against the root import. We trust the runtime
  // shape and cast at the boundary; the structural call is correct.
  type CreateViemAccountFn = (input: {
    walletId: string;
    address: Address;
    privy: unknown;
  }) => Promise<{
    address: Address;
    signMessage: (params: {
      message: string | { raw: `0x${string}` | Uint8Array };
    }) => Promise<`0x${string}`>;
    type: 'local';
  }>;
  const createViemAccount = viemHelper.createViemAccount as unknown as CreateViemAccountFn;
  const accountFactory: PrivyViemAccountFactory = {
    createViemAccount: ({ walletId, address }) => createViemAccount({ walletId, address, privy }),
  };
  return { client, accountFactory };
};
