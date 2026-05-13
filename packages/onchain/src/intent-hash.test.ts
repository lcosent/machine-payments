import { describe, expect, it } from 'vitest';
import { computeIntentHash, taskIdToBytes32 } from './intent-hash.js';

describe('computeIntentHash', () => {
  const base = {
    agent_id: 'agent:autocompute-test',
    task_id: 'task_01J0000000000000000000000A',
    merchant: 'merchant:dcomp-mock',
    amount_ceiling_usdc6: 80_000_000n,
    expires_at_unix_sec: 1_700_000_600,
    nonce: 'nonce-1',
  };

  it('is deterministic for identical inputs', () => {
    expect(computeIntentHash(base)).toBe(computeIntentHash(base));
  });

  it('changes when any input changes', () => {
    const a = computeIntentHash(base);
    expect(computeIntentHash({ ...base, amount_ceiling_usdc6: 80_000_001n })).not.toBe(a);
    expect(computeIntentHash({ ...base, merchant: 'merchant:hyperscaler-mock' })).not.toBe(a);
    expect(computeIntentHash({ ...base, nonce: 'nonce-2' })).not.toBe(a);
  });

  it('produces a 32-byte hex output', () => {
    const h = computeIntentHash(base);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('taskIdToBytes32', () => {
  it('pads ULID-shaped ids into bytes32', () => {
    const b = taskIdToBytes32('task_01J0000000000000000000000A');
    expect(b).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
