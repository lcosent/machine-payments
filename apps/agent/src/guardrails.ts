import type { DelegationScope, MerchantId, Rail, TaskId } from '@autocompute/types';

export interface SpendAttempt {
  task_id: TaskId;
  merchant: MerchantId;
  rail: Rail;
  amount_usd: number;
  at_unix_sec: number;
}

export interface SpendHistoryEntry {
  amount_usd: number;
  at_unix_sec: number;
  merchant: MerchantId;
}

export interface GuardrailContext {
  scope: DelegationScope;
  history: ReadonlyArray<SpendHistoryEntry>;
  now_unix_sec: number;
  cooldown_seconds_between_large_spends: number;
  large_spend_threshold_usd: number;
}

export type GuardrailDecision =
  | { allow: true; requires_hitl: boolean }
  | { allow: false; reason: GuardrailRejection };

export type GuardrailRejection =
  | 'rail_not_in_scope'
  | 'merchant_not_in_allowlist'
  | 'per_tx_cap_exceeded'
  | 'daily_cap_exceeded'
  | 'weekly_cap_exceeded'
  | 'cooldown_active'
  | 'non_positive_amount';

const ONE_DAY = 24 * 60 * 60;
const ONE_WEEK = 7 * ONE_DAY;

const sumSince = (
  history: ReadonlyArray<SpendHistoryEntry>,
  windowStart: number,
): number =>
  history.reduce((acc, h) => (h.at_unix_sec >= windowStart ? acc + h.amount_usd : acc), 0);

export const checkSpend = (
  attempt: SpendAttempt,
  ctx: GuardrailContext,
): GuardrailDecision => {
  if (attempt.amount_usd <= 0) {
    return { allow: false, reason: 'non_positive_amount' };
  }
  if (!ctx.scope.rails.includes(attempt.rail)) {
    return { allow: false, reason: 'rail_not_in_scope' };
  }
  if (!ctx.scope.allowlist.includes(attempt.merchant)) {
    return { allow: false, reason: 'merchant_not_in_allowlist' };
  }
  if (attempt.amount_usd > ctx.scope.caps.per_tx_usd) {
    return { allow: false, reason: 'per_tx_cap_exceeded' };
  }

  const dailyWindow = ctx.now_unix_sec - ONE_DAY;
  const weeklyWindow = ctx.now_unix_sec - ONE_WEEK;
  const spentToday = sumSince(ctx.history, dailyWindow);
  const spentThisWeek = sumSince(ctx.history, weeklyWindow);

  if (spentToday + attempt.amount_usd > ctx.scope.caps.daily_usd) {
    return { allow: false, reason: 'daily_cap_exceeded' };
  }
  if (spentThisWeek + attempt.amount_usd > ctx.scope.caps.weekly_usd) {
    return { allow: false, reason: 'weekly_cap_exceeded' };
  }

  if (attempt.amount_usd >= ctx.large_spend_threshold_usd) {
    const cooldownStart = ctx.now_unix_sec - ctx.cooldown_seconds_between_large_spends;
    const recentLarge = ctx.history.find(
      (h) => h.at_unix_sec >= cooldownStart && h.amount_usd >= ctx.large_spend_threshold_usd,
    );
    if (recentLarge) {
      return { allow: false, reason: 'cooldown_active' };
    }
  }

  const requires_hitl = attempt.amount_usd >= ctx.scope.hitl_threshold_usd;
  return { allow: true, requires_hitl };
};
