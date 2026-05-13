import { ulid } from 'ulidx';
import type { AgentId, DelegationScope, Jwt, Logger, MerchantId, TaskId } from '@autocompute/types';
import type { MppPort } from '@autocompute/mpp-sim';
import { computeIntentHash } from '@autocompute/onchain';
import type { LedgerSink } from '@autocompute/reconciler';
import type { EscrowPort } from './escrow-port.js';
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
    /// Tier 3: triggers a real ECDSA signature over the Escrow digest.
    escrow_address?: `0x${string}`;
    job_id_uint?: string;
  }): Promise<{ merchant_signature: `0x${string}` }>;
  /// Returns the on-chain identity of the merchant, used when opening an
  /// onchain escrow so the provider's signature can later satisfy settle().
  /// Returns null on Tier 1/2 (no onchain identity needed).
  getProviderAddress?(merchant: MerchantId): Promise<`0x${string}` | null>;
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
  /// Required for pay_usdc_escrow + settle_task usdc-rail paths. Either an
  /// InMemoryEscrowPort (sandbox/demo) or an OnchainEscrowPort (Base Sepolia).
  escrow: EscrowPort;
  /// Tier 3 only. When set, settle_task asks the provider to sign over this
  /// address + the uint256 jobId + final amount, producing a signature that
  /// Escrow.sol's settle() will recover correctly.
  escrowAddress?: `0x${string}`;
  now: () => number;
  logger: Logger;
  cooldown_seconds_between_large_spends: number;
  large_spend_threshold_usd: number;
  /// Optional. Card charges and credit draws/repays are written here so the
  /// reconciler sees the same view of the world the MPP sink sees.
  ledgerSink?: LedgerSink;
}

export interface AgentRunState {
  history: SpendHistoryEntry[];
  open_intents: Map<string, { task_id: TaskId; amount_ceiling_usd: number; jwt: Jwt }>;
  /// Maps an open intent's jti to the escrow job_id opened against it. Used
  /// when settle_task fires so we can call EscrowPort.settle with the right
  /// onchain handle.
  escrow_jobs_by_intent: Map<string, string>;
  /// Maps an open intent's jti to the provider-side (dcomp) job id. The
  /// provider has its own internal job id distinct from the on-chain
  /// Escrow.openJob return; both are needed at settle time — the on-chain
  /// id goes into Escrow.settle, the provider id goes into the HTTP /settle
  /// call to pull a real ECDSA signature.
  provider_jobs_by_intent: Map<string, string>;
}

export const makeInitialState = (): AgentRunState => ({
  history: [],
  open_intents: new Map(),
  escrow_jobs_by_intent: new Map(),
  provider_jobs_by_intent: new Map(),
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

  // 1. Open the on-chain escrow (or in-memory analogue) — this is where the
  //    intent_hash is committed and the escrow_opened row hits the ledger.
  //    On Tier 3 we look up the provider's on-chain EOA so Escrow.openJob
  //    records the address whose signature settle() will later check.
  const providerAddress = deps.providers.getProviderAddress
    ? await deps.providers.getProviderAddress(input.merchant)
    : null;
  const openInput: Parameters<typeof deps.escrow.openJob>[0] = {
    task_id: input.task_id,
    amount_usd: input.amount_usd,
    intent_hash: intentHash,
    deadline_unix_sec: at + 60 * 60,
  };
  if (providerAddress) openInput.provider_address = providerAddress;
  const escrow = await deps.escrow.openJob(openInput);

  // 2. Tell the provider its job has started so it can begin metering.
  //    Capture the provider's internal job_id; it's distinct from the
  //    on-chain Escrow.openJob return and is what dcomp's /settle endpoint
  //    keys off when producing the merchant signature.
  const providerJob = await deps.providers.startUsdcJob({
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
  state.escrow_jobs_by_intent.set(intent.jti, escrow.job_id);
  state.provider_jobs_by_intent.set(intent.jti, providerJob.job_id);
  recordSpend(state, input.merchant, input.amount_usd, at);

  deps.logger.info('pay_usdc_escrow ok', {
    task_id: input.task_id,
    intent_jti: intent.jti,
    escrow_job_id: escrow.job_id,
    onchain_tx_hash: escrow.onchain_tx_hash,
  });

  return {
    ok: true,
    result: {
      intent_jti: intent.jti,
      intent_hash: intentHash,
      job_id: escrow.job_id,
      onchain_tx_hash: escrow.onchain_tx_hash ?? undefined,
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

  if (deps.ledgerSink) {
    await deps.ledgerSink.recordCardCharge({
      authorization_id,
      task_id: input.task_id,
      agent_id: deps.agent,
      merchant: input.merchant,
      amount_usd: input.amount_usd,
      intent_hash: intentHash,
      status: 'authorized',
      intent_jti: intent.jti,
    });
  }

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
  if (deps.ledgerSink && onchain_tx_hash) {
    await deps.ledgerSink.recordOnchainEvent({
      id: ulid(),
      kind: 'credit_borrowed',
      task_id: input.task_id,
      tx_hash: onchain_tx_hash as `0x${string}`,
      log_index: 0,
      job_id: null,
      intent_hash: null,
      amount_usd: input.amount_usd,
      final_amount_usd: null,
      refunded_usd: null,
      account: deps.agent,
    });
  }
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
  if (deps.ledgerSink && onchain_tx_hash) {
    await deps.ledgerSink.recordOnchainEvent({
      id: ulid(),
      kind: 'credit_repaid',
      task_id: input.task_id,
      tx_hash: onchain_tx_hash as `0x${string}`,
      log_index: 0,
      job_id: null,
      intent_hash: null,
      amount_usd: input.amount_usd,
      final_amount_usd: null,
      refunded_usd: null,
      account: deps.agent,
    });
  }
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
  // If this intent had an open escrow, fetch the real merchant signature
  // from the provider before countersigning. On Tier 3 the signature must
  // be a valid ECDSA recovery for Escrow.sol's settle() check; on Tier 1/2
  // any signature (including the LLM-supplied one) works because the
  // in-memory escrow port doesn't verify.
  //
  // The provider keys its store by its own job_id (issued at startUsdcJob),
  // so we look that up — distinct from the on-chain Escrow.openJob id, which
  // we still pass via escrow_address + job_id_uint so the signature recovers
  // against the right (escrowAddress, jobId, finalAmount) digest.
  const escrowJobId = state.escrow_jobs_by_intent.get(input.intent_jti);
  const providerJobId =
    state.provider_jobs_by_intent.get(input.intent_jti) ?? escrowJobId;
  let merchantSignature = input.merchant_signature;
  if (escrowJobId && providerJobId) {
    try {
      const fetchInput: Parameters<typeof deps.providers.finalSettlement>[0] = {
        job_id: providerJobId,
        final_amount_usd: input.final_amount_usd,
      };
      if (deps.escrowAddress && /^\d+$/.test(escrowJobId)) {
        fetchInput.escrow_address = deps.escrowAddress;
        fetchInput.job_id_uint = escrowJobId;
      }
      const fetched = await deps.providers.finalSettlement(fetchInput);
      merchantSignature = fetched.merchant_signature;
    } catch (e) {
      deps.logger.warn('finalSettlement fetch failed, using LLM-supplied signature', {
        task_id: input.task_id,
        err: (e as Error).message,
      });
    }
  }

  const { claims } = await deps.mpp.countersignSettlement({
    intent_jwt: open.jwt,
    final_amount_usd: input.final_amount_usd,
    merchant_signature: merchantSignature,
  });

  if (escrowJobId) {
    try {
      await deps.escrow.settle({
        task_id: input.task_id,
        job_id: escrowJobId,
        final_amount_usd: input.final_amount_usd,
        provider_signature: merchantSignature as `0x${string}`,
      });
    } catch (e) {
      deps.logger.warn('escrow settle failed (continuing with MPP-only settlement)', {
        task_id: input.task_id,
        err: (e as Error).message,
      });
    }
    state.escrow_jobs_by_intent.delete(input.intent_jti);
  }

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
