import type { Address } from '@autocompute/onchain';
import type { MerchantId, TaskId } from '@autocompute/types';
import type { ProviderPort, ProviderQuoteOut } from './handlers.js';
import type { QuoteProvidersInput } from './tools.js';

export interface HttpProviderPortConfig {
  dcompBaseUrl: string;
  hyperscalerBaseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface DcompQuoteResp {
  merchant: MerchantId;
  rail: 'usdc_escrow';
  estimated_usd: number;
  estimated_seconds: number;
  quote_id: string;
  expires_at: string;
}
interface HyperscalerQuoteResp {
  merchant: MerchantId;
  rail: 'visa_card';
  estimated_usd: number;
  estimated_seconds: number;
  quote_id: string;
  expires_at: string;
}
interface DcompStartResp {
  job_id: string;
  status: string;
  created_at: number;
}
interface DcompSettleResp {
  job_id: string;
  status: string;
  final_amount_usd: number;
  merchant_signature: string;
}
interface HyperscalerChargeResp {
  authorization_id: string;
  status: string;
}

export class HttpProviderPort implements ProviderPort {
  private readonly dcompBaseUrl: string;
  private readonly hyperscalerBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(cfg: HttpProviderPortConfig) {
    this.dcompBaseUrl = cfg.dcompBaseUrl.replace(/\/+$/, '');
    this.hyperscalerBaseUrl = cfg.hyperscalerBaseUrl.replace(/\/+$/, '');
    this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
  }

  async quote(input: QuoteProvidersInput): Promise<ReadonlyArray<ProviderQuoteOut>> {
    const body = JSON.stringify({
      task_id: input.task_id,
      description: input.description,
      budget_ceiling_usd: input.budget_ceiling_usd,
    });

    const wantUsdc = !input.rails || input.rails.includes('usdc_escrow');
    const wantCard = !input.rails || input.rails.includes('visa_card');

    const [dcomp, hyper] = await Promise.allSettled([
      wantUsdc
        ? this.postJson<DcompQuoteResp>(`${this.dcompBaseUrl}/quote`, body)
        : Promise.resolve(null),
      wantCard
        ? this.postJson<HyperscalerQuoteResp>(`${this.hyperscalerBaseUrl}/quote`, body)
        : Promise.resolve(null),
    ]);

    const out: ProviderQuoteOut[] = [];
    if (dcomp.status === 'fulfilled' && dcomp.value) out.push(dcomp.value);
    if (hyper.status === 'fulfilled' && hyper.value) out.push(hyper.value);
    return out;
  }

  async startUsdcJob(input: {
    merchant: MerchantId;
    quote_id?: string;
    amount_usd: number;
    intent_hash: `0x${string}`;
    task_id: TaskId;
  }): Promise<{ job_id: string; onchain_tx_hash?: string }> {
    const r = await this.postJson<DcompStartResp>(
      `${this.dcompBaseUrl}/start`,
      JSON.stringify({
        task_id: input.task_id,
        intent_hash: input.intent_hash,
        amount_ceiling_usd: input.amount_usd,
      }),
    );
    return { job_id: r.job_id };
  }

  async chargeCard(input: {
    merchant: MerchantId;
    amount_usd: number;
    task_id: TaskId;
    intent_hash?: `0x${string}`;
  }): Promise<{ authorization_id: string }> {
    const intentHash = input.intent_hash ?? (`0x${'0'.repeat(64)}` as `0x${string}`); // never used in production; HTTP card path always passes the real hash
    const r = await this.postJson<HyperscalerChargeResp>(
      `${this.hyperscalerBaseUrl}/charge`,
      JSON.stringify({
        task_id: input.task_id,
        amount_usd: input.amount_usd,
        intent_hash: intentHash,
      }),
    );
    return { authorization_id: r.authorization_id };
  }

  async finalSettlement(input: {
    job_id: string;
    final_amount_usd: number;
    /// Pass these on the Tier 3 path so the provider signs the real Escrow
    /// digest (EIP-191 over keccak256(escrow_addr, job_id_uint, finalUsdc6)).
    /// Omit on Tier 1/2 and the provider returns its mock-hash signature.
    escrow_address?: Address;
    job_id_uint?: string;
  }): Promise<{ merchant_signature: `0x${string}` }> {
    const body: Record<string, unknown> = {
      job_id: input.job_id,
      final_amount_usd: input.final_amount_usd,
    };
    if (input.escrow_address) body['escrow_address'] = input.escrow_address;
    if (input.job_id_uint) body['job_id_uint'] = input.job_id_uint;
    const r = await this.postJson<DcompSettleResp>(
      `${this.dcompBaseUrl}/settle`,
      JSON.stringify(body),
    );
    return { merchant_signature: r.merchant_signature as `0x${string}` };
  }

  /// Resolve the on-chain identity of a merchant. Used by Tier 3 so the
  /// agent passes the provider's address to Escrow.openJob, which is then
  /// the only address whose signature settle() will accept. Returns null
  /// when the provider doesn't expose an identity endpoint.
  async getProviderAddress(merchant: MerchantId): Promise<Address | null> {
    if (merchant !== ('merchant:dcomp-mock' as MerchantId)) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const resp = await this.fetchImpl(`${this.dcompBaseUrl}/identity`, { signal: ctrl.signal });
      if (!resp.ok) return null;
      const data = (await resp.json()) as { provider_address?: string };
      if (!data.provider_address || !/^0x[0-9a-fA-F]{40}$/.test(data.provider_address)) {
        return null;
      }
      return data.provider_address as Address;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async postJson<T>(url: string, body: string): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '<no body>');
      throw new Error(`provider ${url} returned ${resp.status}: ${text.slice(0, 500)}`);
    }
    return (await resp.json()) as T;
  }
}
