/// Third defence-in-depth layer below MPP scope and agent-loop guardrails.
/// Inspired by ERC-4337 smart-wallet session keys: the agent's wallet
/// signing key is only allowed to call a fixed set of contracts and only
/// under per-call and cumulative amount caps. Pure function; the
/// OnchainCreditPort + the smart-wallet adapter call it before broadcasting.

export interface SessionKeyPolicyConfig {
  /// Hard cap on a single onchain action (USDC).
  per_call_cap_usd: number;
  /// Rolling cap over the policy's lookback window (USDC).
  rolling_cap_usd: number;
  rolling_window_seconds: number;
  /// Maximum number of calls per rolling window. 0 disables.
  rolling_call_limit: number;
}

export interface SessionKeyCall {
  kind: 'escrow_open' | 'escrow_settle' | 'draw' | 'repay';
  amount_usd: number;
  at_unix_sec: number;
}

export interface SessionKeyState {
  history: ReadonlyArray<SessionKeyCall>;
}

export type SessionKeyDecision =
  | { allow: true }
  | {
      allow: false;
      reason:
        | 'per_call_cap_exceeded'
        | 'rolling_cap_exceeded'
        | 'rolling_call_limit_exceeded'
        | 'non_positive_amount';
    };

export const evaluateSessionKey = (
  call: SessionKeyCall,
  state: SessionKeyState,
  cfg: SessionKeyPolicyConfig,
): SessionKeyDecision => {
  if (call.amount_usd <= 0) return { allow: false, reason: 'non_positive_amount' };
  if (call.amount_usd > cfg.per_call_cap_usd) {
    return { allow: false, reason: 'per_call_cap_exceeded' };
  }
  const windowStart = call.at_unix_sec - cfg.rolling_window_seconds;
  const inWindow = state.history.filter((h) => h.at_unix_sec >= windowStart);
  const rollingTotal = inWindow.reduce((acc, h) => acc + h.amount_usd, 0);
  if (rollingTotal + call.amount_usd > cfg.rolling_cap_usd) {
    return { allow: false, reason: 'rolling_cap_exceeded' };
  }
  if (cfg.rolling_call_limit > 0 && inWindow.length + 1 > cfg.rolling_call_limit) {
    return { allow: false, reason: 'rolling_call_limit_exceeded' };
  }
  return { allow: true };
};
