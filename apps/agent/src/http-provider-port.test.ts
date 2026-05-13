import { describe, expect, it, vi } from 'vitest';
import type { TaskId } from '@autocompute/types';
import { HttpProviderPort } from './http-provider-port.js';

const TASK = 'task_01J0000000000000000000000A' as TaskId;

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('HttpProviderPort.quote', () => {
  it('queries both providers in parallel and aggregates their quotes', async () => {
    const fetchMock = vi.fn(async (url: string | URL): Promise<Response> => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/dcomp/quote')) {
        return okJson({
          merchant: 'merchant:dcomp-mock',
          rail: 'usdc_escrow',
          estimated_usd: 80,
          estimated_seconds: 70,
          quote_id: 'q-d',
          expires_at: new Date().toISOString(),
        });
      }
      if (u.endsWith('/hyperscaler/quote')) {
        return okJson({
          merchant: 'merchant:hyperscaler-mock',
          rail: 'visa_card',
          estimated_usd: 140,
          estimated_seconds: 5400,
          quote_id: 'q-h',
          expires_at: new Date().toISOString(),
        });
      }
      throw new Error(`unexpected url: ${u}`);
    });

    const port = new HttpProviderPort({
      dcompBaseUrl: 'http://x/api/providers/dcomp',
      hyperscalerBaseUrl: 'http://x/api/providers/hyperscaler',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const quotes = await port.quote({
      task_id: TASK,
      description: 'render',
      budget_ceiling_usd: 200,
    });
    expect(quotes).toHaveLength(2);
    expect(quotes.map((q) => q.merchant).sort()).toEqual([
      'merchant:dcomp-mock',
      'merchant:hyperscaler-mock',
    ]);
  });

  it('honours an explicit rails filter', async () => {
    const fetchMock = vi.fn(async (url: string | URL): Promise<Response> => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/dcomp/quote')) {
        return okJson({
          merchant: 'merchant:dcomp-mock',
          rail: 'usdc_escrow',
          estimated_usd: 80,
          estimated_seconds: 70,
          quote_id: 'q-d',
          expires_at: new Date().toISOString(),
        });
      }
      throw new Error('hyperscaler should not have been queried');
    });
    const port = new HttpProviderPort({
      dcompBaseUrl: 'http://x/api/providers/dcomp',
      hyperscalerBaseUrl: 'http://x/api/providers/hyperscaler',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const quotes = await port.quote({
      task_id: TASK,
      description: 'render',
      budget_ceiling_usd: 200,
      rails: ['usdc_escrow'],
    });
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.rail).toBe('usdc_escrow');
  });

  it('returns the surviving quote when one provider fails', async () => {
    const fetchMock = vi.fn(async (url: string | URL): Promise<Response> => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/dcomp/quote')) {
        return new Response('boom', { status: 500 });
      }
      return okJson({
        merchant: 'merchant:hyperscaler-mock',
        rail: 'visa_card',
        estimated_usd: 140,
        estimated_seconds: 5400,
        quote_id: 'q-h',
        expires_at: new Date().toISOString(),
      });
    });
    const port = new HttpProviderPort({
      dcompBaseUrl: 'http://x/api/providers/dcomp',
      hyperscalerBaseUrl: 'http://x/api/providers/hyperscaler',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const quotes = await port.quote({
      task_id: TASK,
      description: 'render',
      budget_ceiling_usd: 200,
    });
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.merchant).toBe('merchant:hyperscaler-mock');
  });
});

describe('HttpProviderPort.startUsdcJob and finalSettlement', () => {
  it('opens a job and signs settlement', async () => {
    const fetchMock = vi.fn(async (url: string | URL): Promise<Response> => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/dcomp/start')) {
        return okJson({ job_id: 'job_abc', status: 'open', created_at: 1 });
      }
      if (u.endsWith('/dcomp/settle')) {
        return okJson({
          job_id: 'job_abc',
          status: 'settled',
          final_amount_usd: 78,
          merchant_signature: '0xdeadbeef',
        });
      }
      throw new Error(`unexpected url: ${u}`);
    });
    const port = new HttpProviderPort({
      dcompBaseUrl: 'http://x/api/providers/dcomp',
      hyperscalerBaseUrl: 'http://x/api/providers/hyperscaler',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const start = await port.startUsdcJob({
      merchant: 'merchant:dcomp-mock',
      amount_usd: 80,
      intent_hash: `0x${'a'.repeat(64)}`,
      task_id: TASK,
    });
    expect(start.job_id).toBe('job_abc');
    const settle = await port.finalSettlement({ job_id: 'job_abc', final_amount_usd: 78 });
    expect(settle.merchant_signature).toBe('0xdeadbeef');
  });
});

describe('HttpProviderPort.chargeCard', () => {
  it('returns the authorization id from the hyperscaler', async () => {
    const fetchMock = vi.fn(
      async (): Promise<Response> => okJson({ authorization_id: 'auth_xyz', status: 'authorized' }),
    );
    const port = new HttpProviderPort({
      dcompBaseUrl: 'http://x/api/providers/dcomp',
      hyperscalerBaseUrl: 'http://x/api/providers/hyperscaler',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const r = await port.chargeCard({
      merchant: 'merchant:hyperscaler-mock',
      amount_usd: 140,
      task_id: TASK,
      intent_hash: `0x${'b'.repeat(64)}`,
    });
    expect(r.authorization_id).toBe('auth_xyz');
  });
});
