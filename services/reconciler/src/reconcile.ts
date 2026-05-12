import type { Rail, TaskId } from '@autocompute/types';
import type {
  Anomaly,
  CardChargeRow,
  MppReceiptRow,
  OnchainEventRow,
  UnifiedStatementRow,
} from './types.js';

export interface ReconcileInput {
  mpp_receipts: ReadonlyArray<MppReceiptRow>;
  onchain_events: ReadonlyArray<OnchainEventRow>;
  card_charges: ReadonlyArray<CardChargeRow>;
}

export interface ReconcileOutput {
  statement: ReadonlyArray<UnifiedStatementRow>;
  anomalies: ReadonlyArray<Anomaly>;
}

/// Pure reconciliation: joins MPP receipts, onchain events, and card charges
/// by task_id (+ rail for MPP) and emits one statement row per (task, rail)
/// plus a list of detected anomalies. Mirrors the semantics of the
/// `unified_statement` view in supabase/migrations/0001_init.sql but runs
/// in-process so the demo, scripts, and tests don't need a live database.
export const reconcile = (input: ReconcileInput): ReconcileOutput => {
  const anomalies: Anomaly[] = [];
  const intentsByJti = new Map<string, MppReceiptRow>();
  const settlementsByIntentJti = new Map<string, MppReceiptRow[]>();

  for (const r of input.mpp_receipts) {
    if (r.kind === 'intent') intentsByJti.set(r.jti, r);
    if (r.kind === 'settlement' && r.intent_jti) {
      const arr = settlementsByIntentJti.get(r.intent_jti) ?? [];
      arr.push(r);
      settlementsByIntentJti.set(r.intent_jti, arr);
    }
  }

  // Anomaly: intent without settlement (and not still in flight beyond a window — we
  // don't have time here, so we flag any intent with no settlement at all).
  for (const intent of intentsByJti.values()) {
    const settlements = settlementsByIntentJti.get(intent.jti) ?? [];
    if (settlements.length === 0) {
      anomalies.push({
        task_id: intent.task_id,
        kind: 'intent_without_settlement',
        detail: { intent_jti: intent.jti, rail: intent.rail, merchant: intent.merchant },
      });
    } else if (settlements.length > 1) {
      anomalies.push({
        task_id: intent.task_id,
        kind: 'duplicate_settlement',
        detail: { intent_jti: intent.jti, count: settlements.length },
      });
    }
    for (const s of settlements) {
      if (
        intent.amount_ceiling_usd !== null &&
        s.final_amount_usd !== null &&
        s.final_amount_usd > intent.amount_ceiling_usd
      ) {
        anomalies.push({
          task_id: s.task_id,
          kind: 'final_exceeds_intent_ceiling',
          detail: {
            intent_jti: intent.jti,
            ceiling_usd: intent.amount_ceiling_usd,
            final_usd: s.final_amount_usd,
          },
        });
      }
    }
  }

  // Anomaly: settlement without intent.
  for (const r of input.mpp_receipts) {
    if (r.kind === 'settlement' && r.intent_jti && !intentsByJti.has(r.intent_jti)) {
      anomalies.push({
        task_id: r.task_id,
        kind: 'settlement_without_intent',
        detail: { settlement_jti: r.jti, intent_jti: r.intent_jti },
      });
    }
  }

  // Onchain anomaly checks: amount mismatch and orphan events.
  const escrowSettledByIntentHash = new Map<string, OnchainEventRow>();
  for (const e of input.onchain_events) {
    if (e.kind === 'escrow_settled' && e.intent_hash) {
      escrowSettledByIntentHash.set(e.intent_hash, e);
    }
  }
  const intentHashesFromMpp = new Set(
    input.mpp_receipts.map((r) => r.intent_hash).filter((h): h is `0x${string}` => h !== null),
  );

  for (const e of input.onchain_events) {
    if (e.kind === 'escrow_settled' && e.intent_hash && !intentHashesFromMpp.has(e.intent_hash)) {
      anomalies.push({
        task_id: e.task_id,
        kind: 'orphan_onchain_event',
        detail: { tx_hash: e.tx_hash, intent_hash: e.intent_hash },
      });
    }
  }

  for (const intent of intentsByJti.values()) {
    if (!intent.intent_hash) continue;
    const onchain = escrowSettledByIntentHash.get(intent.intent_hash);
    const offchain = (settlementsByIntentJti.get(intent.jti) ?? [])[0];
    if (
      onchain &&
      offchain &&
      onchain.final_amount_usd !== null &&
      offchain.final_amount_usd !== null &&
      Math.abs(onchain.final_amount_usd - offchain.final_amount_usd) > 0.005
    ) {
      anomalies.push({
        task_id: intent.task_id,
        kind: 'onchain_amount_mismatch',
        detail: {
          intent_jti: intent.jti,
          mpp_usd: offchain.final_amount_usd,
          onchain_usd: onchain.final_amount_usd,
        },
      });
    }
  }

  // Build the statement: one row per (task_id, rail). MPP receipts drive the
  // rail breakdown; card charges are exclusively visa_card; onchain events
  // collapse to a per-task aggregate split between usdc_escrow and credit_line.
  type Key = `${TaskId}|${Rail}`;
  const make = (task_id: TaskId, rail: Rail): UnifiedStatementRow => ({
    task_id,
    rail,
    mpp_settled_usd: 0,
    mpp_intent_ceiling_usd: 0,
    intent_count: 0,
    settlement_count: 0,
    escrow_settled_usd: 0,
    escrow_refunded_usd: 0,
    credit_drawn_usd: 0,
    credit_repaid_usd: 0,
    card_charged_usd: 0,
    anomalies: [],
  });
  const rows = new Map<Key, UnifiedStatementRow>();
  const ensure = (task_id: TaskId, rail: Rail): UnifiedStatementRow => {
    const key: Key = `${task_id}|${rail}`;
    let row = rows.get(key);
    if (!row) {
      row = make(task_id, rail);
      rows.set(key, row);
    }
    return row;
  };

  for (const r of input.mpp_receipts) {
    if (!r.task_id || !r.rail) continue;
    const row = ensure(r.task_id, r.rail);
    if (r.kind === 'intent') {
      row.intent_count += 1;
      row.mpp_intent_ceiling_usd += r.amount_ceiling_usd ?? 0;
    } else if (r.kind === 'settlement') {
      row.settlement_count += 1;
      row.mpp_settled_usd += r.final_amount_usd ?? 0;
    }
  }

  for (const e of input.onchain_events) {
    if (!e.task_id) continue;
    if (e.kind === 'escrow_settled') {
      ensure(e.task_id, 'usdc_escrow').escrow_settled_usd += e.final_amount_usd ?? 0;
    } else if (e.kind === 'escrow_refunded') {
      ensure(e.task_id, 'usdc_escrow').escrow_refunded_usd += e.refunded_usd ?? 0;
    } else if (e.kind === 'credit_borrowed') {
      ensure(e.task_id, 'credit_line').credit_drawn_usd += e.amount_usd ?? 0;
    } else if (e.kind === 'credit_repaid') {
      ensure(e.task_id, 'credit_line').credit_repaid_usd += e.amount_usd ?? 0;
    }
  }

  for (const c of input.card_charges) {
    if (!c.task_id) continue;
    if (c.status === 'voided' || c.status === 'disputed') continue;
    ensure(c.task_id, 'visa_card').card_charged_usd += c.amount_usd;
  }

  // Attach unresolved anomalies to the matching rows. Anomalies without a
  // task_id are returned separately but not folded into any statement row.
  const anomaliesByTask = new Map<TaskId, Set<Anomaly['kind']>>();
  for (const a of anomalies) {
    if (!a.task_id) continue;
    const set = anomaliesByTask.get(a.task_id) ?? new Set();
    set.add(a.kind);
    anomaliesByTask.set(a.task_id, set);
  }
  for (const row of rows.values()) {
    const kinds = anomaliesByTask.get(row.task_id);
    if (kinds) row.anomalies = Array.from(kinds);
  }

  return {
    statement: Array.from(rows.values()).sort((a, b) =>
      a.task_id === b.task_id ? a.rail.localeCompare(b.rail) : a.task_id.localeCompare(b.task_id),
    ),
    anomalies,
  };
};
