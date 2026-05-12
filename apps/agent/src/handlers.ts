import { ulid } from 'ulidx';
import type { AgentId, DelegationScope, Jwt, Logger, MerchantId, TaskId } from '@autocompute/types';
import type { MppPort } from '@autocompute/mpp-sim';
import { computeIntentHash } from '@autocompute/onchain';
import { checkSpend, type GuardrailContext, type SpendHistoryEntry } from './guardrails.js';
import type {
  DrawCreditInput,
  PayUsdcEscrowInput,
  PayVisaCardInput,
  QuoteProvidersInput,
  RepayCreditInput,
  ReportStatusInput,
  SettleTaskInput,
  ToolInput,
} from './tools.js';

export interface ProviderQuoteOut {
  merchant: MerchantId;
  rail: 'visa_card' | 'usdc_escrow';
  estimated_usd: number;
  estimated_seconds: number;
  quote_id: string;
  expires_at: string;
}

export interface ProviderPort {
  quote(input: QuoteProvidersInput): Promise<ReadonlyArray<ProviderQuoteOut>>;
  startUsdcJob(input: {
    merchant: MerchantId;
    quote_id?: string;
    amount_usd: number;
    intent_hash: `0x${string}`;
    task_id: TaskId;
  }): Promise<{ job_id: string; onchain_tx_hash?: string }>;
  chargeCard(input: {
    merchant: MerchantId;
    amount_usd: number;
    task_id: TaskId;
  }): Promise<{ authorization_id: string }>;
  finalSettlement(input: {
    job_id: string;
    final_amount_usd: number;
  }): Promise<{ merchant_signature: string }>;
}

export interface CreditPort {
  draw(amount_usd: number): Promise<{ onchain_tx_hash?: string }>;
  repay(amount_usd: number): Promise<{ onchain_tx_hash?: string }>;
}

export interface HandlerDeps {
  agent: AgentId;
  scope: DelegationScope;
  delegationJwt: Jwt;
  mpp: MppPort;
  providers: ProviderPort;
  credit: CreditPort;
  now: () => number;
  logger: Logger;
  cooldown_seconds_between_large_spends: number;
  large_spend_threshold_usd: number;
}

export interface AgentRunState {
  history: SpendHistoryEntry[];
  open_intents: Map<string, { task_id: TaskId; amount_ceiling_usd: number; jwt: Jwt }>;
}

export const makeInitialState = (): AgentRunState => ({
  history: [],
  open_intents: new Map(),
});

const ctx = (deps: HandlerDeps, state: AgentRunState): GuardrailContext => ({
  scope: deps.scope,
  history: state.history,
  now_unix_sec: deps.now(),
  cooldown_seconds_between_large_spends: deps.cooldown_seconds_between_large_spends,
  large_spend_threshold_usd: deps.large_spend_threshold_usd,
});

const recordSpend = (
  state: AgentRunState,
  merchant: MerchantId,
  amount_usd: number,
  at_unix_sec: number,
): void => {
  state.history.push({ amount_usd, at_unix_sec, merchant });
};

const guardrailRejection = (reason: string, requires_hitl = false): GuardrailRejectionResult => ({
  ok: false,
  kind: 'guardrail_rejected',
  reason,
  requires_hitl,
});

interface GuardrailRejectionResult {
  ok: false;
  kind: 'guardrail_rejected';
  reason: string;
  requires_hitl: boolean;
}

interface OkResult<T> {
  ok: true;
  result: T;
}

export type HandlerResult<T> = OkResult<T> | GuardrailRejectionResult;

export const dispatchTool = async (
  call: ToolInput,
  deps: HandlerDeps,
  state: AgentRunState,
): Promise<HandlerResult<unknown>> => {
  switch (call.name) {
    case 'quote_providers':
      return handleQuoteProviders(call.input, deps);
    case 'pay_usdc_escrow':
      return handlePayUsdcEscrow(call.input, deps, state);
    case 'pay_visa_card':
      return handlePayVisaCard(call.input, deps, state);
    case 'draw_credit':
      return handleDrawCredit(call.input, deps, state);
    case 'repay_credit':
      return handleRepayCredit(call.input, deps);
    case 'settle_task':
      return handleSettleTask(call.input, deps, state);
    case 'report_status':
      return handleReportStatus(call.input, deps);
  }
};

const handleQuoteProviders = async (
  input: QuoteProvidersInput,
  deps: HandlerDeps,
): Promise<HandlerResult<{ quotes: ReadonlyArray<ProviderQuoteOut> }>> => {
  const quotes = await deps.providers.quote(input);
  deps.logger.info('quote_providers', { task_id: input.task_id, count: quotes.length });
  return { ok: true, result: { quotes } };
};

const handlePayUsdcEscrow = async (
  input: PayUsdcEscrowInput,
  deps: HandlerDeps,
  state: AgentRunState,
): Promise<
  HandlerResult<{
    intent_jti: string;
    intent_hash: `0x${string}`;
    job_id: string;
    onchain_tx_hash: string | undefined;
    requires_hitl: boolean;
  }>
> => {
  const at = deps.now();
  const decision = checkSpend(
    {
      task_id: input.task_id,
      merchant: input.merchant,
      rail: 'usdc_escrow',
      amount_usd: input.amount_usd,
      at_unix_sec: at,
    },
    ctx(deps, state),
  );
  if (!decision.allow) {
    deps.logger.warn('guardrail blocked pay_usdc_escrow', {
      task_id: input.task_id,
      reason: decision.reason,
    });
    return guardrailRejection(decision.reason);
  }

  const intentHash = computeIntentHash({
    agent_id: deps.agent,
    task_id: input.task_id,
    merchant: input.merchant,
    amount_ceiling_usdc6: BigInt(Math.round(input.amount_usd * 1_000_000)),
    expires_at_unix_sec: at + 600,
    nonce: ulid(),
  });

  const { jwt: intentJwt, claims: intent } = await deps.mpp.issueIntent({
    delegation_jwt: deps.delegationJwt,
    task_id: input.task_id,
    rail: 'usdc_escrow',
    merchant: input.merchant,
    amount_ceiling_usd: input.amount_usd,
    intent_hash: intentHash,
    ttl_seconds: 600,
  });

  const { job_id, onchain_tx_hash } = await deps.providers.startUsdcJob({
    merchant: input.merchant,
    amount_usd: input.amount_usd,
    intent_hash: intentHash,
    task_id: input.task_id,
  });

  state.open_intents.set(intent.jti, {
    task_id: input.task_id,
    amount_ceiling_usd: input.amount_usd,
    jwt: intentJwt,
  });
  recordSpend(state, input.merchant, input.amount_usd, at);

  deps.logger.info('pay_usdc_escrow ok', {
    task_id: input.task_id,
    intent_jti: intent.jti,
    job_id,
  });

  return {
    ok: true,
    result: {
      intent_jti: intent.jti,
      intent_hash: intentHash,
      job_id,
      onchain_tx_hash,
      requires_hitl: decision.requires_hitl,
    },
  };
};

const handlePayVisaCard = async (
  input: PayVisaCardInput,
  deps: HandlerDeps,
  state: AgentRunState,
): Promise<
  HandlerResult<{ intent_jti: string; authorization_id: string; requires_hitl: boolean }>
> => {
  const at = deps.now();
  const decision = checkSpend(
    {
      task_id: input.task_id,
      merchant: input.merchant,
      rail: 'visa_card',
      amount_usd: input.amount_usd,
      at_unix_sec: at,
    },
    ctx(deps, state),
  );
  if (!decision.allow) {
    deps.logger.warn('guardrail blocked pay_visa_card', {
      task_id: input.task_id,
      reason: decision.reason,
    });
    return guardrailRejection(decision.reason);
  }

  const intentHash = computeIntentHash({
    agent_id: deps.agent,
    task_id: input.task_id,
    merchant: input.merchant,
    amount_ceiling_usdc6: BigInt(Math.round(input.amount_usd * 1_000_000)),
    expires_at_unix_sec: at + 600,
    nonce: ulid(),
  });

  const { jwt: intentJwt, claims: intent } = await deps.mpp.issueIntent({
    delegation_jwt: deps.delegationJwt,
    task_id: input.task_id,
    rail: 'visa_card',
    merchant: input.merchant,
    amount_ceiling_usd: input.amount_usd,
    intent_hash: intentHash,
    ttl_seconds: 600,
  });

  const { authorization_id } = await deps.providers.chargeCard({
    merchant: input.merchant,
    amount_usd: input.amount_usd,
    task_id: input.task_id,
  });

  state.open_intents.set(intent.jti, {
    task_id: input.task_id,
    amount_ceiling_usd: input.amount_usd,
    jwt: intentJwt,
  });
  recordSpend(state, input.merchant, input.amount_usd, at);

  deps.logger.info('pay_visa_card ok', {
    task_id: input.task_id,
    intent_jti: intent.jti,
    authorization_id,
  });

  return {
    ok: true,
    result: { intent_jti: intent.jti, authorization_id, requires_hitl: decision.requires_hitl },
  };
};

const handleDrawCredit = async (
  input: DrawCreditInput,
  deps: HandlerDeps,
  state: AgentRunState,
): Promise<HandlerResult<{ onchain_tx_hash: string | undefined; requires_hitl: boolean }>> => {
  const at = deps.now();
  const decision = checkSpend(
    {
      task_id: input.task_id,
      merchant: 'merchant:credit-pool' as MerchantId,
      rail: 'credit_line',
      amount_usd: input.amount_usd,
      at_unix_sec: at,
    },
    {
      ...ctx(deps, state),
      scope: {
        ...deps.scope,
        // Credit draws are scoped by daily/weekly cap but not by merchant allowlist.
        allowlist: [...deps.scope.allowlist, 'merchant:credit-pool' as MerchantId],
      },
    },
  );
  if (!decision.allow) {
    deps.logger.warn('guardrail blocked draw_credit', {
      task_id: input.task_id,
      reason: decision.reason,
    });
    return guardrailRejection(decision.reason);
  }
  const { onchain_tx_hash } = await deps.credit.draw(input.amount_usd);
  recordSpend(state, 'merchant:credit-pool' as MerchantId, input.amount_usd, at);
  deps.logger.info('draw_credit ok', {
    task_id: input.task_id,
    amount_usd: input.amount_usd,
  });
  return { ok: true, result: { onchain_tx_hash, requires_hitl: decision.requires_hitl } };
};

const handleRepayCredit = async (
  input: RepayCreditInput,
  deps: HandlerDeps,
): Promise<HandlerResult<{ onchain_tx_hash: string | undefined }>> => {
  const { onchain_tx_hash } = await deps.credit.repay(input.amount_usd);
  deps.logger.info('repay_credit ok', { task_id: input.task_id, amount_usd: input.amount_usd });
  return { ok: true, result: { onchain_tx_hash } };
};

const handleSettleTask = async (
  input: SettleTaskInput,
  deps: HandlerDeps,
  state: AgentRunState,
): Promise<HandlerResult<{ settlement_jti: string }>> => {
  const open = state.open_intents.get(input.intent_jti);
  if (!open) {
    return {
      ok: false,
      kind: 'guardrail_rejected',
      reason: 'unknown_intent_jti',
      requires_hitl: false,
    };
  }
  if (input.final_amount_usd > open.amount_ceiling_usd) {
    return {
      ok: false,
      kind: 'guardrail_rejected',
      reason: 'final_exceeds_ceiling',
      requires_hitl: false,
    };
  }
  const { claims } = await deps.mpp.countersignSettlement({
    intent_jwt: open.jwt,
    final_amount_usd: input.final_amount_usd,
    merchant_signature: input.merchant_signature,
  });
  state.open_intents.delete(input.intent_jti);
  deps.logger.info('settle_task ok', {
    task_id: input.task_id,
    settlement_jti: claims.jti,
    final_amount_usd: input.final_amount_usd,
  });
  return { ok: true, result: { settlement_jti: claims.jti } };
};

const handleReportStatus = async (
  input: ReportStatusInput,
  deps: HandlerDeps,
): Promise<HandlerResult<{ acknowledged: true }>> => {
  deps.logger.info('report_status', {
    task_id: input.task_id,
    status: input.status,
    message: input.message,
  });
  return { ok: true, result: { acknowledged: true } };
};

export const renderToolResultJson = (r: HandlerResult<unknown>): string => {
  if (r.ok) return JSON.stringify({ ok: true, ...(r.result as Record<string, unknown>) });
  return JSON.stringify({
    ok: false,
    error: 'guardrail_rejected',
    reason: r.reason,
    requires_hitl: r.requires_hitl,
  });
};
