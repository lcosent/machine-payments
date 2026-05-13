import { beforeEach, describe, expect, it } from 'vitest';
import { POST as quotePost } from './quote/route';
import { POST as chargePost } from './charge/route';
import { HyperscalerStore } from '../../../../lib/provider-state';

const post = (url: string, body: unknown) =>
  new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => HyperscalerStore.__reset());

describe('hyperscaler /quote', () => {
  it('returns a visa-card quote priced above the dcomp baseline', async () => {
    const r = await quotePost(
      post('http://x/api/providers/hyperscaler/quote', {
        task_id: 'task_01J0000000000000000000000A',
        description: 'render',
        budget_ceiling_usd: 200,
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body['merchant']).toBe('merchant:hyperscaler-mock');
    expect(body['rail']).toBe('visa_card');
    expect(typeof body['estimated_usd']).toBe('number');
  });
});

describe('hyperscaler /charge', () => {
  it('issues an authorization id and persists it', async () => {
    const r = await chargePost(
      post('http://x/api/providers/hyperscaler/charge', {
        task_id: 'task_01J0000000000000000000000A',
        amount_usd: 140,
        intent_hash: `0x${'b'.repeat(64)}`,
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { authorization_id: string; status: string };
    expect(body.status).toBe('authorized');
    expect(body.authorization_id).toMatch(/^auth_/);
    expect(HyperscalerStore.list()).toHaveLength(1);
  });

  it('rejects bad intent_hash', async () => {
    const r = await chargePost(
      post('http://x/api/providers/hyperscaler/charge', {
        task_id: 'task_01J0000000000000000000000A',
        amount_usd: 140,
        intent_hash: 'not-hex',
      }),
    );
    expect(r.status).toBe(400);
  });
});
