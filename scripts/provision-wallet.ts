import { writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPrivyClient, readPrivyEnv } from '@autocompute/onchain';
import { makeLogger } from '@autocompute/types';

/// One-shot helper that mints a Privy server wallet for the agent, prints
/// its address so you can drip ETH + USDC into it, and persists the wallet
/// id so subsequent `pnpm script:agent` runs reuse the same wallet (and
/// therefore the same funded balance).
///
/// Reads PRIVY_APP_ID + PRIVY_APP_SECRET (+ optional
/// PRIVY_WALLET_AUTHORIZATION_PRIVATE_KEY) from env. Writes
/// PRIVY_WALLET_ID + PRIVY_WALLET_ADDRESS into .env (creating the file if
/// needed) and prints them to stdout.

const log = makeLogger('script.provision-wallet');

const main = async (): Promise<void> => {
  const cfg = readPrivyEnv();
  if (!cfg) {
    log.error('PRIVY_APP_ID and PRIVY_APP_SECRET must be set (see .env.example)');
    process.exit(1);
  }

  const envPath = resolve(process.cwd(), '.env');
  const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';

  const existingId = matchEnv(existing, 'PRIVY_WALLET_ID');
  if (existingId) {
    log.warn('PRIVY_WALLET_ID already set in .env; nothing to do', {
      wallet_id: existingId,
      wallet_address: matchEnv(existing, 'PRIVY_WALLET_ADDRESS'),
    });
    log.info(
      'To mint a fresh wallet, remove PRIVY_WALLET_ID + PRIVY_WALLET_ADDRESS from .env and re-run.',
    );
    return;
  }

  log.info('minting Privy server wallet for the agent...');
  const { client } = await loadPrivyClient(cfg);
  const wallet = await client.walletApi.createWallet({ chainType: 'ethereum' });
  log.info('wallet minted', { wallet_id: wallet.id, address: wallet.address });

  const newLines = [
    '',
    '# Auto-written by scripts/provision-wallet.ts. Treat the wallet id as a',
    '# pointer to the Privy-custodied key; never share or commit it.',
    `PRIVY_WALLET_ID=${wallet.id}`,
    `PRIVY_WALLET_ADDRESS=${wallet.address}`,
    '',
  ].join('\n');
  if (existing) appendFileSync(envPath, newLines);
  else writeFileSync(envPath, newLines.trimStart());

  log.info('persisted to .env', { path: envPath });
  log.info('next step: fund this address with Base Sepolia ETH + USDC', {
    address: wallet.address,
    eth_faucet: 'https://docs.base.org/docs/tools/network-faucets',
    usdc_faucet: 'https://faucet.circle.com',
  });
  log.info(
    'when funded, set ESCROW_ADDRESS + CREDIT_LINE_ADDRESS (from ./scripts/deploy.sh) and run `pnpm script:agent`',
  );
};

const matchEnv = (contents: string, key: string): string | null => {
  const re = new RegExp(`^${key}=(.+)$`, 'm');
  const m = contents.match(re);
  return m && m[1] ? m[1].trim() : null;
};

main().catch((e) => {
  log.error('provision-wallet failed', { err: (e as Error).message });
  process.exit(1);
});
