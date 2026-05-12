import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { ulid } from 'ulidx';
import {
  HttpProviderPort,
  type CreditPort,
  type HandlerDeps,
  makeInitialState,
  makeLlmFromEnv,
  runAgent,
} from '@autocompute/agent';
import { MppSimAdapter } from '@autocompute/mpp-sim';
import { makeLogger, type DelegationScope, type MerchantId, type TaskId } from '@autocompute/types';

const log = makeLogger('script.agent');

const PRINCIPAL = 'ent:acme-corp' as const;
const AGENT = 'agent:autocompute-demo' as const;
const HYPERSCALER: MerchantId = 'merchant:hyperscaler-mock';
const DCOMP: MerchantId = 'merchant:dcomp-mock';

const SCOPE: DelegationScope = {
  rails: ['usdc_escrow', 'credit_line', 'visa_card'],
  caps: { per_tx_usd: 250, daily_usd: 1000, weekly_usd: 5000 },
  allowlist: [HYPERSCALER, DCOMP],
  hitl_threshold_usd: 200,
};

const env = process.env;
const DCOMP_BASE = env['DCOMP_BASE_URL'] ?? 'http://localhost:3000/api/providers/dcomp';
const HYPER_BASE = env['HYPERSCALER_BASE_URL'] ?? 'http://localhost:3000/api/providers/hyperscaler';
const TASK_DESC = env['TASK_DESCRIPTION'] ?? 'render 60s of 4K video, deadline 2h';
const BUDGET_USD = Number(env['TASK_BUDGET_USD'] ?? '200');

const inMemoryCredit = (
  initialAvailableUsd = 500,
): CreditPort & {
  state(): { available_usd: number; principal_usd: number };
} => {
  let available = initialAvailableUsd;
  let principal = 0;
  return {
    async draw(amount_usd: number) {
      if (amount_usd > available) throw new Error('credit pool dry');
      available -= amount_usd;
      principal += amount_usd;
      return { onchain_tx_hash: `0xinmem${ulid().slice(0, 8).toLowerCase()}` };
    },
    async repay(amount_usd: number) {
      const paid = Math.min(amount_usd, principal);
      principal -= paid;
      available += paid;
      return { onchain_tx_hash: `0xinmem${ulid().slice(0, 8).toLowerCase()}` };
    },
    state() {
      return { available_usd: available, principal_usd: principal };
    },
  };
};

const main = async () => {
  log.info('boot', {
    dcomp: DCOMP_BASE,
    hyperscaler: HYPER_BASE,
    task: TASK_DESC,
    budget_usd: BUDGET_USD,
  });

  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const mpp = new MppSimAdapter({
    issuerId: 'mpp-sim://demo/issuer',
    privateKeyPkcs8Pem: await exportPKCS8(privateKey),
    publicKeySpkiPem: await exportSPKI(publicKey),
    alg: 'EdDSA',
  });

  const { jwt: delegationJwt, claims: delegation } = await mpp.issueDelegation({
    principal: PRINCIPAL,
    agent: AGENT,
    audience: [HYPERSCALER, DCOMP],
    scope: SCOPE,
    key_binding: 'did:key:z6Mkdemo',
    ttl_seconds: 3600,
  });
  log.info('delegation issued', { jti: delegation.jti });

  const providers = new HttpProviderPort({
    dcompBaseUrl: DCOMP_BASE,
    hyperscalerBaseUrl: HYPER_BASE,
  });
  const credit = inMemoryCredit(500);

  let llm;
  try {
    llm = makeLlmFromEnv();
  } catch (e) {
    log.error(
      'unable to build LLM port — set LLM_BACKEND + the relevant API key / model id (see .env.example)',
      { err: (e as Error).message },
    );
    process.exit(1);
  }
  log.info('llm', { backend: llm.name, model: llm.model });

  const deps: HandlerDeps = {
    agent: AGENT,
    scope: SCOPE,
    delegationJwt,
    mpp,
    providers,
    credit,
    now: () => Math.floor(Date.now() / 1000),
    logger: log.child('agent'),
    cooldown_seconds_between_large_spends: 60,
    large_spend_threshold_usd: 150,
  };

  const state = makeInitialState();
  const task = {
    task_id: `task_${ulid()}` as TaskId,
    description: TASK_DESC,
    budget_ceiling_usd: BUDGET_USD,
    deadline_iso: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  };
  log.info('task submitted', task);

  const result = await runAgent(llm, deps, state, task);

  log.info('agent finished', {
    iterations: result.iterations,
    stop_reason: result.stop_reason,
    tokens: {
      input: result.total_input_tokens,
      output: result.total_output_tokens,
      cache_read: result.total_cache_read_tokens,
      cache_create: result.total_cache_creation_tokens,
    },
    spends: state.history.length,
    open_intents: state.open_intents.size,
    credit: credit.state(),
  });

  if (state.history.length > 0) {
    log.info('spend history', {
      entries: state.history.map((h) => ({
        merchant: h.merchant,
        amount_usd: h.amount_usd,
        at: new Date(h.at_unix_sec * 1000).toISOString(),
      })),
      total_spent_usd: state.history.reduce((acc, h) => acc + h.amount_usd, 0),
    });
  }
};

main().catch((e) => {
  log.error('script:agent failed', { err: (e as Error).message, stack: (e as Error).stack });
  process.exit(1);
});
