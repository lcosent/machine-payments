import { describe, expect, it } from 'vitest';
import type { DelegationScope, MerchantId, TaskId } from '@autocompute/types';
import { checkSpend, type GuardrailContext, type SpendAttempt } from './guardrails.js';

const HYPERSCALER: MerchantId = 'merchant:hyperscaler-mock';
const DCOMP: MerchantId = 'merchant:dcomp-mock';
const TASK: TaskId = 'task_01J0000000000000000000000A' as TaskId;
const NOW = 1_700_000_000;

const scope: DelegationScope = {
  rails: ['usdc_escrow', 'credit_line', 'visa_card'],
  caps: { per_tx_usd: 250, daily_usd: 1000, weekly_usd: 5000 },
  allowlist: [HYPERSCALER, DCOMP],
  hitl_threshold_usd: 200,
};

const ctx = (overrides: Partial<GuardrailContext> = {}): GuardrailContext => ({
  scope,
  history: [],
  now_unix_sec: NOW,
  cooldown_seconds_between_large_spends: 60,
  large_spend_threshold_usd: 150,
  ...overrides,
});

const attempt = (overrides: Partial<SpendAttempt> = {}): SpendAttempt => ({
  task_id: TASK,
  merchant: DCOMP,
  rail: 'usdc_escrow',
  amount_usd: 80,
  at_unix_sec: NOW,
  ...overrides,
});

describe('checkSpend', () => {
  it('allows a normal spend below the HITL threshold', () => {
    expect(checkSpend(attempt(), ctx())).toEqual({ allow: true, requires_hitl: false });
  });

  it('flags HITL for spends at or above the threshold', () => {
    expect(checkSpend(attempt({ amount_usd: 200 }), ctx())).toEqual({
      allow: true,
      requires_hitl: true,
    });
  });

  it('rejects non-positive amounts', () => {
    expect(checkSpend(attempt({ amount_usd: 0 }), ctx())).toEqual({
      allow: false,
      reason: 'non_positive_amount',
    });
  });

  it('rejects out-of-scope rails', () => {
    const restrictedScope: DelegationScope = { ...scope, rails: ['usdc_escrow'] };
    expect(checkSpend(attempt({ rail: 'visa_card' }), ctx({ scope: restrictedScope }))).toEqual({
      allow: false,
      reason: 'rail_not_in_scope',
    });
  });

  it('rejects merchants not in the allowlist', () => {
    expect(checkSpend(attempt({ merchant: 'merchant:unknown' as MerchantId }), ctx())).toEqual({
      allow: false,
      reason: 'merchant_not_in_allowlist',
    });
  });

  it('rejects when per-tx cap exceeded', () => {
    expect(checkSpend(attempt({ amount_usd: 251 }), ctx())).toEqual({
      allow: false,
      reason: 'per_tx_cap_exceeded',
    });
  });

  it('rejects when daily cumulative cap would be exceeded', () => {
    const history = [
      { amount_usd: 500, at_unix_sec: NOW - 3600, merchant: DCOMP },
      { amount_usd: 450, at_unix_sec: NOW - 7200, merchant: DCOMP },
    ];
    expect(checkSpend(attempt({ amount_usd: 100 }), ctx({ history }))).toEqual({
      allow: false,
      reason: 'daily_cap_exceeded',
    });
  });

  it('ignores spends outside the daily window when computing daily total', () => {
    const history = [{ amount_usd: 900, at_unix_sec: NOW - 26 * 3600, merchant: DCOMP }];
    expect(checkSpend(attempt({ amount_usd: 80 }), ctx({ history }))).toEqual({
      allow: true,
      requires_hitl: false,
    });
  });

  it('rejects when weekly cumulative cap would be exceeded', () => {
    // Six historical spends, each 36+ hours apart starting yesterday, so none
    // fall in the daily window but all fall in the weekly window.
    const history = Array.from({ length: 6 }, (_, i) => ({
      amount_usd: 900,
      at_unix_sec: NOW - (36 + i * 24) * 3600,
      merchant: DCOMP,
    }));
    expect(checkSpend(attempt({ amount_usd: 80 }), ctx({ history }))).toEqual({
      allow: false,
      reason: 'weekly_cap_exceeded',
    });
  });

  it('enforces cooldown between large spends', () => {
    const history = [{ amount_usd: 200, at_unix_sec: NOW - 30, merchant: DCOMP }];
    expect(checkSpend(attempt({ amount_usd: 200 }), ctx({ history }))).toEqual({
      allow: false,
      reason: 'cooldown_active',
    });
  });

  it('does not enforce cooldown for spends below the large-spend threshold', () => {
    const history = [{ amount_usd: 200, at_unix_sec: NOW - 30, merchant: DCOMP }];
    expect(checkSpend(attempt({ amount_usd: 80 }), ctx({ history }))).toEqual({
      allow: true,
      requires_hitl: false,
    });
  });

  it('allows a large spend once cooldown has elapsed', () => {
    const history = [{ amount_usd: 200, at_unix_sec: NOW - 120, merchant: DCOMP }];
    expect(checkSpend(attempt({ amount_usd: 200 }), ctx({ history }))).toEqual({
      allow: true,
      requires_hitl: true,
    });
  });
});
