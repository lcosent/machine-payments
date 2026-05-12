import { beforeEach, describe, expect, it } from 'vitest';
import { POST as quotePost } from './quote/route';
import { POST as startPost } from './start/route';
import { GET as meterGet, POST as meterPost } from './meter/route';
import { POST as settlePost } from './settle/route';
import { DcompStore } from '../../../../lib/provider-state';

const TASK = 'task_01J0000000000000000000000A';
const INTENT = `0x${'a'.repeat(64)}`;

const post = (url: string, body: unknown) =>
  new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => DcompStore.__reset());

describe('dcomp /quote', () => {
  it('returns a USDC-escrow quote within budget', async () => {
    const r = await quotePost(
      post('http://x/api/providers/dcomp/quote', {
        task_id: TASK,
        description: 'render 60s of 4K video',
        budget_ceiling_usd: 200,
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body['merchant']).toBe('merchant:dcomp-mock');
    expect(body['rail']).toBe('usdc_escrow');
    expect(typeof body['estimated_usd']).toBe('number');
    expect((body['estimated_usd'] as number) <= 200).toBe(true);
  });

  it('rejects budget below the minimum', async () => {
    const r = await quotePost(
      post('http://x/api/providers/dcomp/quote', {
        task_id: TASK,
        description: 'tiny',
        budget_ceiling_usd: 5,
      }),
    );
    expect(r.status).toBe(422);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body['error']).toBe('below_minimum');
  });

  it('rejects malformed body', async () => {
    const r = await quotePost(
      new Request('http://x/api/providers/dcomp/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ not json',
      }),
    );
    expect(r.status).toBe(400);
    expect(((await r.json()) as Record<string, unknown>)['error']).toBe('invalid_json');
  });
});

describe('dcomp /start, /meter, /settle lifecycle', () => {
  it('opens a job, accepts meter ticks, and settles within ceiling', async () => {
    const startResp = await startPost(
      post('http://x/api/providers/dcomp/start', {
        task_id: TASK,
        intent_hash: INTENT,
        amount_ceiling_usd: 100,
      }),
    );
    const startBody = (await startResp.json()) as { job_id: string; status: string };
    expect(startResp.status).toBe(200);
    expect(startBody.job_id).toMatch(/^job_/);

    const meterResp = await meterPost(
      post('http://x/api/providers/dcomp/meter', {
        job_id: startBody.job_id,
        progress_bps: 5000,
        consumed_usd: 50,
        projected_total_usd: 95,
      }),
    );
    expect(meterResp.status).toBe(200);
    const meterBody = (await meterResp.json()) as { status: string; tick_count: number };
    expect(meterBody.status).toBe('metering');
    expect(meterBody.tick_count).toBe(1);

    const meterGetResp = await meterGet(
      new Request(
        `http://x/api/providers/dcomp/meter?job_id=${encodeURIComponent(startBody.job_id)}`,
      ),
    );
    expect(meterGetResp.status).toBe(200);
    const ticks = (await meterGetResp.json()) as { ticks: unknown[] };
    expect(ticks.ticks).toHaveLength(1);

    const settleResp = await settlePost(
      post('http://x/api/providers/dcomp/settle', {
        job_id: startBody.job_id,
        final_amount_usd: 90,
      }),
    );
    expect(settleResp.status).toBe(200);
    const settleBody = (await settleResp.json()) as {
      status: string;
      final_amount_usd: number;
      merchant_signature: string;
    };
    expect(settleBody.status).toBe('settled');
    expect(settleBody.final_amount_usd).toBe(90);
    expect(settleBody.merchant_signature).toMatch(/^0x[0-9a-f]+$/);
  });

  it('rejects settle above ceiling', async () => {
    const startResp = await startPost(
      post('http://x/api/providers/dcomp/start', {
        task_id: TASK,
        intent_hash: INTENT,
        amount_ceiling_usd: 100,
      }),
    );
    const startBody = (await startResp.json()) as { job_id: string };
    const settleResp = await settlePost(
      post('http://x/api/providers/dcomp/settle', {
        job_id: startBody.job_id,
        final_amount_usd: 101,
      }),
    );
    expect(settleResp.status).toBe(409);
    expect(((await settleResp.json()) as Record<string, unknown>)['error']).toBe(
      'final_exceeds_ceiling',
    );
  });

  it('rejects settle on unknown job', async () => {
    const r = await settlePost(
      post('http://x/api/providers/dcomp/settle', {
        job_id: 'job_does_not_exist',
        final_amount_usd: 10,
      }),
    );
    expect(r.status).toBe(404);
  });

  it('rejects double-settle', async () => {
    const startResp = await startPost(
      post('http://x/api/providers/dcomp/start', {
        task_id: TASK,
        intent_hash: INTENT,
        amount_ceiling_usd: 100,
      }),
    );
    const { job_id } = (await startResp.json()) as { job_id: string };
    const ok = await settlePost(
      post('http://x/api/providers/dcomp/settle', { job_id, final_amount_usd: 50 }),
    );
    expect(ok.status).toBe(200);
    const dup = await settlePost(
      post('http://x/api/providers/dcomp/settle', { job_id, final_amount_usd: 50 }),
    );
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as Record<string, unknown>)['error']).toBe('already_settled');
  });
});

describe('dcomp /meter validation', () => {
  it('rejects bad intent_hash on /start', async () => {
    const r = await startPost(
      post('http://x/api/providers/dcomp/start', {
        task_id: TASK,
        intent_hash: '0xnope',
        amount_ceiling_usd: 100,
      }),
    );
    expect(r.status).toBe(400);
  });

  it('returns 400 when /meter GET missing job_id', async () => {
    const r = await meterGet(new Request('http://x/api/providers/dcomp/meter'));
    expect(r.status).toBe(400);
  });
});
