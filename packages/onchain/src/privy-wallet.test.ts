import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { makePrivyWallet, readPrivyEnv, type PrivyViemAccountFactory } from './privy-wallet.js';

const ADDR = '0x1111111111111111111111111111111111111111' as Address;
const SIG =
  '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef1c' as `0x${string}`;

const makeFactory = (
  overrides: Partial<{ signResult: `0x${string}` }> = {},
): PrivyViemAccountFactory => ({
  createViemAccount: vi.fn(async ({ address }) => ({
    address,
    type: 'local' as const,
    signMessage: vi.fn(async () => overrides.signResult ?? SIG),
  })),
});

describe('makePrivyWallet', () => {
  it('exposes the wallet address provided by Privy', async () => {
    const factory = makeFactory();
    const wallet = await makePrivyWallet({
      rpcUrl: 'https://sepolia.base.org',
      walletId: 'wallet_abc',
      address: ADDR,
      accountFactory: factory,
    });
    expect(wallet.address).toBe(ADDR);
    expect(factory.createViemAccount).toHaveBeenCalledWith({
      walletId: 'wallet_abc',
      address: ADDR,
    });
  });

  it('signMessage forwards through to the Privy account', async () => {
    const factory = makeFactory();
    const wallet = await makePrivyWallet({
      rpcUrl: 'https://sepolia.base.org',
      walletId: 'wallet_abc',
      address: ADDR,
      accountFactory: factory,
    });
    const sig = await wallet.signMessage('hello');
    expect(sig).toBe(SIG);
  });

  it('raw() returns a viem WalletClient configured for the Privy account', async () => {
    const factory = makeFactory();
    const wallet = await makePrivyWallet({
      rpcUrl: 'https://sepolia.base.org',
      walletId: 'wallet_abc',
      address: ADDR,
      accountFactory: factory,
    });
    const client = wallet.raw();
    expect(client.chain?.id).toBe(84532); // baseSepolia
    expect(client.account?.address).toBe(ADDR);
  });
});

describe('readPrivyEnv', () => {
  it('returns null when neither id nor secret is set', () => {
    expect(readPrivyEnv({})).toBeNull();
    expect(readPrivyEnv({ PRIVY_APP_ID: 'x' })).toBeNull();
    expect(readPrivyEnv({ PRIVY_APP_SECRET: 'y' })).toBeNull();
  });

  it('returns the parsed config when id and secret are set', () => {
    const cfg = readPrivyEnv({ PRIVY_APP_ID: 'app_1', PRIVY_APP_SECRET: 'secret' });
    expect(cfg).toEqual({ appId: 'app_1', appSecret: 'secret' });
  });

  it('threads the optional wallet authorization key through', () => {
    const cfg = readPrivyEnv({
      PRIVY_APP_ID: 'app_1',
      PRIVY_APP_SECRET: 'secret',
      PRIVY_WALLET_AUTHORIZATION_PRIVATE_KEY: '0xabc',
    });
    expect(cfg?.walletAuthorizationPrivateKey).toBe('0xabc');
  });
});
