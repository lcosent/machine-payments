import type { AgentId, MerchantId, Rail, TaskId } from '@autocompute/types';

export interface MppReceiptRow {
  jti: string;
  kind: 'delegation' | 'intent' | 'settlement';
  task_id: TaskId | null;
  agent_id: AgentId;
  rail: Rail | null;
  merchant: MerchantId | null;
  amount_ceiling_usd: number | null;
  final_amount_usd: number | null;
  intent_jti: string | null;
  intent_hash: `0x${string}` | null;
}

export interface OnchainEventRow {
  id: string;
  kind:
    | 'escrow_opened'
    | 'escrow_metered'
    | 'escrow_settled'
    | 'escrow_refunded'
    | 'credit_borrowed'
    | 'credit_repaid'
    | 'credit_liquidated';
  task_id: TaskId | null;
  tx_hash: `0x${string}`;
  log_index: number;
  job_id: string | null;
  intent_hash: `0x${string}` | null;
  amount_usd: number | null;
  final_amount_usd: number | null;
  refunded_usd: number | null;
  account: string | null;
}

export interface CardChargeRow {
  authorization_id: string;
  task_id: TaskId | null;
  agent_id: AgentId;
  merchant: MerchantId;
  amount_usd: number;
  intent_hash: `0x${string}` | null;
  status: 'authorized' | 'captured' | 'voided' | 'disputed';
  intent_jti: string | null;
}

export type AnomalyKind =
  | 'intent_without_settlement'
  | 'settlement_without_intent'
  | 'final_exceeds_intent_ceiling'
  | 'onchain_amount_mismatch'
  | 'orphan_onchain_event'
  | 'duplicate_settlement';

export interface Anomaly {
  task_id: TaskId | null;
  kind: AnomalyKind;
  detail: Record<string, unknown>;
}

export interface UnifiedStatementRow {
  task_id: TaskId;
  rail: Rail;
  mpp_settled_usd: number;
  mpp_intent_ceiling_usd: number;
  intent_count: number;
  settlement_count: number;
  escrow_settled_usd: number;
  escrow_refunded_usd: number;
  credit_drawn_usd: number;
  credit_repaid_usd: number;
  card_charged_usd: number;
  anomalies: ReadonlyArray<AnomalyKind>;
}
