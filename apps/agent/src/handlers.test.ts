import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { ulid } from 'ulidx';
import { MppSimAdapter } from '@autocompute/mpp-sim';
import { makeLogger, type DelegationScope, type MerchantId, type TaskId } from '@autocompute/types';
import {
  dispatchTool,
  makeInitialState,
  renderToolResultJson,
  type AgentRunState,
  type CreditPort,
  type HandlerDeps,
  type ProviderPort,
} from './handlers.js';

const ISSUER_ID = 'mpp-sim://test/agent-handlers';
const PRINCIPAL = 'ent:acme-corp';
const AGENT = 'agent:autocompute-handler-test';
const DCOMP: MerchantId = 'merchant:dcomp-mock';
const HYPERSCALER: MerchantId = 'merchant:hyperscaler-mock';
const TASK = `task_${ulid()}` as TaskId;
const NOW = 1_700_000_000;

const SCOPE: DelegationScope = {
  rails: ['usdc_escrow', 'credit_line', 'visa_card'],
  caps: { per_tx_usd: 250, daily_usd: 1000, weekly_usd: 5000 },
  allowlist: [DCOMP, HYPERSCALER],
  hitl_threshold_usd: 200,
};

const mockProviders = (): ProviderPort => ({
  quote: async () => [
    {
      merchant: DCOMP,
      rail: 'usdc_escrow',
      estimated_usd: 80,
      estimated_seconds: 300,
      quote_id: 'q-1',
      expires_at: new Date(NOW * 1000 + 60_000).toISOString(),
    },
    {
      merchant: HYPERSCALER,
      rail: 'visa_card',
      estimated_usd: 140,
      estimated_seconds: 600,
      quote_id: 'q-2',
      expires_at: new Date(NOW * 1000 + 60_000).toISOString(),
    },
  ],
  startUsdcJob: async () => ({ job_id: 'job-1', onchain_tx_hash: '0xdeadbeef' }),
  chargeCard: async () => ({ authorization_id: 'auth-1' }),
  finalSettlement: async () => ({ merchant_signature: '0xmerchsig' }),
});

const mockCredit = (): CreditPort => ({
  draw: async () => ({ onchain_tx_hash: '0xcreditdraw' }),
  repay: async () => ({ onchain_tx_hash: '0xcreditrepay' }),
});

const makeAdapter = async (): Promise<MppSimAdapter> => {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  return new MppSimAdapter({
    issuerId: ISSUER_ID,
    privateKeyPkcs8Pem: await exportPKCS8(privateKey),
    publicKeySpkiPem: await exportSPKI(publicKey),
    alg: 'EdDSA',
    now: () => NOW,
  });
};

const makeDeps = async (overrides: Partial<HandlerDeps> = {}): Promise<HandlerDeps> => {
  const mpp = overrides.mpp ?? (await makeAdapter());
  const { jwt } = await mpp.issueDelegation({
    principal: PRINCIPAL,
    agent: AGENT,
    audience: [DCOMP, HYPERSCALER],
    scope: SCOPE,
    key_binding: 'did:key:z6Mktest',
    ttl_seconds: 3600,
  });
  return {
    agent: AGENT,
    scope: SCOPE,
    delegationJwt: jwt,
    mpp,
    providers: mockProviders(),
    credit: mockCredit(),
    now: () => NOW,
    logger: makeLogger('test'),
    cooldown_seconds_between_large_spends: 60,
    large_spend_threshold_usd: 150,
    ...overrides,
  };
};

describe('dispatchTool', () => {
  let state: AgentRunState;

  beforeEach(() => {
    state = makeInitialState();
  });

  it('returns quotes from the provider port', async () => {
    const deps = await makeDeps();
    const r = await dispatchTool(
      {
        name: 'quote_providers',
        input: { task_id: TASK, description: 'render video', budget_ceiling_usd: 200 },
      },
      deps,
      state,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = r.result as { quotes: ReadonlyArray<{ merchant: MerchantId }> };
      expect(result.quotes).toHaveLength(2);
    }
  });

  it('issues an MPP intent on a within-cap pay_usdc_escrow and records the spend', async () => {
    const deps = await makeDeps();
    const r = await dispatchTool(
      {
        name: 'pay_usdc_escrow',
        input: {
          task_id: TASK,
          merchant: DCOMP,
          amount_usd: 80,
          rationale: 'cheaper than hyperscaler, faster',
        },
      },
      deps,
      state,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = r.result as { intent_jti: string; job_id: string };
      expect(out.intent_jti).toBeTruthy();
      expect(out.job_id).toBe('job-1');
      expect(state.open_intents.has(out.intent_jti)).toBe(true);
    }
    expect(state.history).toHaveLength(1);
    expect(state.history[0]?.amount_usd).toBe(80);
  });

  it('blocks pay_usdc_escrow when amount exceeds per-tx cap', async () => {
    const deps = await makeDeps();
    const r = await dispatchTool(
      {
        name: 'pay_usdc_escrow',
        input: {
          task_id: TASK,
          merchant: DCOMP,
          amount_usd: 300,
          rationale: 'oops',
        },
      },
      deps,
      state,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('per_tx_cap_exceeded');
    expect(state.history).toHaveLength(0);
    expect(state.open_intents.size).toBe(0);
  });

  it('blocks pay_visa_card for an off-allowlist merchant', async () => {
    const deps = await makeDeps();
    const r = await dispatchTool(
      {
        name: 'pay_visa_card',
        input: {
          task_id: TASK,
          merchant: 'merchant:rando' as MerchantId,
          amount_usd: 50,
          rationale: 'no',
        },
      },
      deps,
      state,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('merchant_not_in_allowlist');
  });

  it('allows draw_credit even though merchant:credit-pool is not in the principal allowlist', async () => {
    const deps = await makeDeps();
    const r = await dispatchTool(
      {
        name: 'draw_credit',
        input: { task_id: TASK, amount_usd: 50, rationale: 'topup' },
      },
      deps,
      state,
    );
    expect(r.ok).toBe(true);
  });

  it('round-trips a settle_task against an open intent and clears it', async () => {
    const deps = await makeDeps();
    const pay = await dispatchTool(
      {
        name: 'pay_usdc_escrow',
        input: { task_id: TASK, merchant: DCOMP, amount_usd: 80, rationale: 'ok' },
      },
      deps,
      state,
    );
    expect(pay.ok).toBe(true);
    if (!pay.ok) throw new Error('precondition: pay should have succeeded');
    const { intent_jti } = pay.result as { intent_jti: string };

    const settle = await dispatchTool(
      {
        name: 'settle_task',
        input: {
          task_id: TASK,
          intent_jti,
          final_amount_usd: 78,
          merchant_signature: '0xmerch',
        },
      },
      deps,
      state,
    );
    expect(settle.ok).toBe(true);
    expect(state.open_intents.has(intent_jti)).toBe(false);
  });

  it('rejects settle_task when final exceeds the open intent ceiling', async () => {
    const deps = await makeDeps();
    const pay = await dispatchTool(
      {
        name: 'pay_usdc_escrow',
        input: { task_id: TASK, merchant: DCOMP, amount_usd: 80, rationale: 'ok' },
      },
      deps,
      state,
    );
    if (!pay.ok) throw new Error('precondition');
    const { intent_jti } = pay.result as { intent_jti: string };

    const settle = await dispatchTool(
      {
        name: 'settle_task',
        input: {
          task_id: TASK,
          intent_jti,
          final_amount_usd: 200,
          merchant_signature: '0xmerch',
        },
      },
      deps,
      state,
    );
    expect(settle.ok).toBe(false);
    if (!settle.ok) expect(settle.reason).toBe('final_exceeds_ceiling');
  });

  it('flags requires_hitl on a within-cap spend at or above the hitl threshold', async () => {
    const deps = await makeDeps();
    const r = await dispatchTool(
      {
        name: 'pay_visa_card',
        input: {
          task_id: TASK,
          merchant: HYPERSCALER,
          amount_usd: 220,
          rationale: 'large but in-scope',
        },
      },
      deps,
      state,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = r.result as { requires_hitl: boolean };
      expect(out.requires_hitl).toBe(true);
    }
  });

  it('renders tool results as JSON the LLM can consume', async () => {
    const deps = await makeDeps();
    const r = await dispatchTool(
      {
        name: 'pay_usdc_escrow',
        input: { task_id: TASK, merchant: DCOMP, amount_usd: 80, rationale: 'ok' },
      },
      deps,
      state,
    );
    const json = renderToolResultJson(r);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(typeof parsed['intent_jti']).toBe('string');
  });
});
