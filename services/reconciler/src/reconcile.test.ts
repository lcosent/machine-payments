import { describe, expect, it } from 'vitest';
import type { AgentId, MerchantId, TaskId } from '@autocompute/types';
import { reconcile } from './reconcile.js';
import type { CardChargeRow, MppReceiptRow, OnchainEventRow } from './types.js';

const TASK_A = 'task_01J0000000000000000000000A' as TaskId;
const TASK_B = 'task_01J0000000000000000000000B' as TaskId;
const AGENT: AgentId = 'agent:autocompute-test';
const DCOMP: MerchantId = 'merchant:dcomp-mock';
const HYPER: MerchantId = 'merchant:hyperscaler-mock';
const H = (s: string): `0x${string}` => `0x${s.padEnd(64, '0').slice(0, 64)}` as `0x${string}`;

const intent = (over: Partial<MppReceiptRow>): MppReceiptRow => ({
  jti: 'i-1',
  kind: 'intent',
  task_id: TASK_A,
  agent_id: AGENT,
  rail: 'usdc_escrow',
  merchant: DCOMP,
  amount_ceiling_usd: 80,
  final_amount_usd: null,
  intent_jti: null,
  intent_hash: H('a'),
  ...over,
});

const settle = (over: Partial<MppReceiptRow>): MppReceiptRow => ({
  jti: 's-1',
  kind: 'settlement',
  task_id: TASK_A,
  agent_id: AGENT,
  rail: 'usdc_escrow',
  merchant: DCOMP,
  amount_ceiling_usd: null,
  final_amount_usd: 78,
  intent_jti: 'i-1',
  intent_hash: null,
  ...over,
});

const escrowSettled = (over: Partial<OnchainEventRow>): OnchainEventRow => ({
  id: 'oe-1',
  kind: 'escrow_settled',
  task_id: TASK_A,
  tx_hash: H('aa'),
  log_index: 0,
  job_id: 'job_1',
  intent_hash: H('a'),
  amount_usd: null,
  final_amount_usd: 78,
  refunded_usd: null,
  account: null,
  ...over,
});

describe('reconcile', () => {
  it('produces a clean per-rail row when MPP receipts match onchain events', () => {
    const out = reconcile({
      mpp_receipts: [intent({}), settle({})],
      onchain_events: [escrowSettled({})],
      card_charges: [],
    });
    expect(out.anomalies).toEqual([]);
    expect(out.statement).toHaveLength(1);
    const row = out.statement[0]!;
    expect(row.task_id).toBe(TASK_A);
    expect(row.rail).toBe('usdc_escrow');
    expect(row.intent_count).toBe(1);
    expect(row.settlement_count).toBe(1);
    expect(row.mpp_settled_usd).toBe(78);
    expect(row.escrow_settled_usd).toBe(78);
    expect(row.anomalies).toEqual([]);
  });

  it('flags settlement_without_intent and tags the corresponding row', () => {
    const out = reconcile({
      mpp_receipts: [settle({ jti: 's-orphan', intent_jti: 'i-missing' })],
      onchain_events: [],
      card_charges: [],
    });
    expect(out.anomalies.map((a) => a.kind)).toEqual(['settlement_without_intent']);
    expect(out.statement[0]!.anomalies).toEqual(['settlement_without_intent']);
  });

  it('flags intent_without_settlement when no settlement exists for an intent', () => {
    const out = reconcile({
      mpp_receipts: [intent({ jti: 'i-orphan' })],
      onchain_events: [],
      card_charges: [],
    });
    expect(out.anomalies.map((a) => a.kind)).toEqual(['intent_without_settlement']);
  });

  it('flags final_exceeds_intent_ceiling when settlement amount > intent ceiling', () => {
    const out = reconcile({
      mpp_receipts: [intent({ amount_ceiling_usd: 50 }), settle({ final_amount_usd: 51 })],
      onchain_events: [],
      card_charges: [],
    });
    expect(out.anomalies.map((a) => a.kind)).toContain('final_exceeds_intent_ceiling');
  });

  it('flags duplicate_settlement when one intent has multiple settlements', () => {
    const out = reconcile({
      mpp_receipts: [intent({}), settle({ jti: 's-1' }), settle({ jti: 's-2' })],
      onchain_events: [],
      card_charges: [],
    });
    expect(out.anomalies.map((a) => a.kind)).toContain('duplicate_settlement');
  });

  it('flags onchain_amount_mismatch when MPP settlement and escrow settled disagree', () => {
    const out = reconcile({
      mpp_receipts: [intent({}), settle({ final_amount_usd: 78 })],
      onchain_events: [escrowSettled({ final_amount_usd: 90 })],
      card_charges: [],
    });
    expect(out.anomalies.map((a) => a.kind)).toContain('onchain_amount_mismatch');
  });

  it('flags orphan_onchain_event when an escrow settlement has no MPP intent hash', () => {
    const out = reconcile({
      mpp_receipts: [],
      onchain_events: [escrowSettled({ intent_hash: H('beef') })],
      card_charges: [],
    });
    expect(out.anomalies.map((a) => a.kind)).toContain('orphan_onchain_event');
  });

  it('aggregates credit draws and repays into the credit_line row', () => {
    const out = reconcile({
      mpp_receipts: [],
      onchain_events: [
        {
          id: 'oe-d',
          kind: 'credit_borrowed',
          task_id: TASK_A,
          tx_hash: H('bb'),
          log_index: 0,
          job_id: null,
          intent_hash: null,
          amount_usd: 50,
          final_amount_usd: null,
          refunded_usd: null,
          account: '0xagent',
        },
        {
          id: 'oe-r',
          kind: 'credit_repaid',
          task_id: TASK_A,
          tx_hash: H('cc'),
          log_index: 0,
          job_id: null,
          intent_hash: null,
          amount_usd: 30,
          final_amount_usd: null,
          refunded_usd: null,
          account: '0xagent',
        },
      ],
      card_charges: [],
    });
    const credit = out.statement.find((r) => r.rail === 'credit_line');
    expect(credit).toBeDefined();
    expect(credit!.credit_drawn_usd).toBe(50);
    expect(credit!.credit_repaid_usd).toBe(30);
  });

  it('counts active card charges and ignores voided/disputed', () => {
    const charges: CardChargeRow[] = [
      {
        authorization_id: 'auth_1',
        task_id: TASK_A,
        agent_id: AGENT,
        merchant: HYPER,
        amount_usd: 140,
        intent_hash: null,
        status: 'authorized',
        intent_jti: null,
      },
      {
        authorization_id: 'auth_2',
        task_id: TASK_A,
        agent_id: AGENT,
        merchant: HYPER,
        amount_usd: 50,
        intent_hash: null,
        status: 'voided',
        intent_jti: null,
      },
    ];
    const out = reconcile({
      mpp_receipts: [],
      onchain_events: [],
      card_charges: charges,
    });
    const card = out.statement.find((r) => r.rail === 'visa_card');
    expect(card).toBeDefined();
    expect(card!.card_charged_usd).toBe(140);
  });

  it('groups rows by (task_id, rail) and stable-sorts the output', () => {
    const out = reconcile({
      mpp_receipts: [
        intent({ task_id: TASK_B, jti: 'i-b1', rail: 'visa_card', merchant: HYPER }),
        settle({
          task_id: TASK_B,
          jti: 's-b1',
          intent_jti: 'i-b1',
          rail: 'visa_card',
          merchant: HYPER,
          final_amount_usd: 30,
        }),
        intent({ task_id: TASK_A, jti: 'i-a1' }),
        settle({ task_id: TASK_A, jti: 's-a1', intent_jti: 'i-a1' }),
      ],
      onchain_events: [escrowSettled({ task_id: TASK_A })],
      card_charges: [],
    });
    expect(out.statement.map((r) => `${r.task_id}|${r.rail}`)).toEqual([
      `${TASK_A}|usdc_escrow`,
      `${TASK_B}|visa_card`,
    ]);
  });
});
