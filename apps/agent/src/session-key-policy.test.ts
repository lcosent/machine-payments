import { describe, expect, it } from 'vitest';
import {
  evaluateSessionKey,
  type SessionKeyCall,
  type SessionKeyPolicyConfig,
  type SessionKeyState,
} from './session-key-policy.js';

const NOW = 1_700_000_000;
const cfg: SessionKeyPolicyConfig = {
  per_call_cap_usd: 100,
  rolling_cap_usd: 250,
  rolling_window_seconds: 3600,
  rolling_call_limit: 5,
};

const call = (over: Partial<SessionKeyCall> = {}): SessionKeyCall => ({
  kind: 'draw',
  amount_usd: 50,
  at_unix_sec: NOW,
  ...over,
});
const state = (history: ReadonlyArray<SessionKeyCall> = []): SessionKeyState => ({ history });

describe('evaluateSessionKey', () => {
  it('allows a small call against an empty history', () => {
    expect(evaluateSessionKey(call(), state(), cfg)).toEqual({ allow: true });
  });

  it('rejects non-positive amounts', () => {
    expect(evaluateSessionKey(call({ amount_usd: 0 }), state(), cfg)).toEqual({
      allow: false,
      reason: 'non_positive_amount',
    });
  });

  it('rejects when amount exceeds per_call_cap', () => {
    expect(evaluateSessionKey(call({ amount_usd: 101 }), state(), cfg)).toEqual({
      allow: false,
      reason: 'per_call_cap_exceeded',
    });
  });

  it('rejects when rolling total + this call exceeds rolling_cap', () => {
    const history: SessionKeyCall[] = [
      { kind: 'draw', amount_usd: 100, at_unix_sec: NOW - 100 },
      { kind: 'draw', amount_usd: 100, at_unix_sec: NOW - 200 },
    ];
    expect(evaluateSessionKey(call({ amount_usd: 60 }), state(history), cfg)).toEqual({
      allow: false,
      reason: 'rolling_cap_exceeded',
    });
  });

  it('does not count history older than the rolling window', () => {
    const history: SessionKeyCall[] = [
      { kind: 'draw', amount_usd: 100, at_unix_sec: NOW - cfg.rolling_window_seconds - 1 },
    ];
    expect(evaluateSessionKey(call({ amount_usd: 60 }), state(history), cfg)).toEqual({
      allow: true,
    });
  });

  it('rejects when rolling_call_limit would be exceeded', () => {
    const history: SessionKeyCall[] = Array.from({ length: 5 }, (_, i) => ({
      kind: 'draw' as const,
      amount_usd: 10,
      at_unix_sec: NOW - i - 1,
    }));
    expect(evaluateSessionKey(call({ amount_usd: 10 }), state(history), cfg)).toEqual({
      allow: false,
      reason: 'rolling_call_limit_exceeded',
    });
  });

  it('treats rolling_call_limit=0 as disabled', () => {
    const noLimitCfg = { ...cfg, rolling_call_limit: 0 };
    const history: SessionKeyCall[] = Array.from({ length: 50 }, (_, i) => ({
      kind: 'draw' as const,
      amount_usd: 1,
      at_unix_sec: NOW - i - 1,
    }));
    expect(evaluateSessionKey(call({ amount_usd: 1 }), state(history), noLimitCfg)).toEqual({
      allow: true,
    });
  });
});
