import { ulid } from 'ulidx';

/// In-memory state for the mock providers. Module-scoped so it survives across
/// requests within a single Next.js process. Reset on full restart or hot
/// reload of this module — fine for a PoC, would move to Postgres for v2.

export interface DcompJob {
  job_id: string;
  task_id: string;
  intent_hash: string;
  amount_ceiling_usd: number;
  consumed_usd: number;
  projected_total_usd: number;
  status: 'open' | 'metering' | 'settled' | 'expired';
  created_at: number;
  meter_ticks: ReadonlyArray<{
    at_unix_sec: number;
    progress_bps: number;
    consumed_usd: number;
    projected_total_usd: number;
  }>;
  /// Hex bytes the provider will sign over (jobId, finalAmount). For PoC the
  /// "signature" is a deterministic hash; in production this is the provider's
  /// EOA signature that Escrow.sol verifies.
  provider_signing_seed: string;
}

export interface HyperscalerAuthorization {
  authorization_id: string;
  task_id: string;
  amount_usd: number;
  intent_hash: string;
  status: 'authorized' | 'captured' | 'voided';
  created_at: number;
}

const dcompJobs = new Map<string, DcompJob>();
const hyperscalerAuths = new Map<string, HyperscalerAuthorization>();

export const DcompStore = {
  open(input: { task_id: string; intent_hash: string; amount_ceiling_usd: number }): DcompJob {
    const job: DcompJob = {
      job_id: `job_${ulid()}`,
      task_id: input.task_id,
      intent_hash: input.intent_hash,
      amount_ceiling_usd: input.amount_ceiling_usd,
      consumed_usd: 0,
      projected_total_usd: input.amount_ceiling_usd,
      status: 'open',
      created_at: Math.floor(Date.now() / 1000),
      meter_ticks: [],
      provider_signing_seed: `seed-${ulid()}`,
    };
    dcompJobs.set(job.job_id, job);
    return job;
  },

  get(job_id: string): DcompJob | undefined {
    return dcompJobs.get(job_id);
  },

  /// Append a meter tick. Allows tests / scripts to drive job progress.
  meter(input: {
    job_id: string;
    progress_bps: number;
    consumed_usd: number;
    projected_total_usd: number;
  }): DcompJob {
    const j = dcompJobs.get(input.job_id);
    if (!j) throw new Error(`unknown job: ${input.job_id}`);
    if (j.status !== 'open' && j.status !== 'metering') {
      throw new Error(`cannot meter job in status ${j.status}`);
    }
    const updated: DcompJob = {
      ...j,
      status: 'metering',
      consumed_usd: input.consumed_usd,
      projected_total_usd: input.projected_total_usd,
      meter_ticks: [
        ...j.meter_ticks,
        {
          at_unix_sec: Math.floor(Date.now() / 1000),
          progress_bps: input.progress_bps,
          consumed_usd: input.consumed_usd,
          projected_total_usd: input.projected_total_usd,
        },
      ],
    };
    dcompJobs.set(input.job_id, updated);
    return updated;
  },

  settle(input: { job_id: string; final_amount_usd: number }): {
    job: DcompJob;
    merchant_signature: string;
  } {
    const j = dcompJobs.get(input.job_id);
    if (!j) throw new Error(`unknown job: ${input.job_id}`);
    if (j.status === 'settled') throw new Error('job already settled');
    if (input.final_amount_usd > j.amount_ceiling_usd) {
      throw new Error('final exceeds amount_ceiling');
    }
    const settled: DcompJob = {
      ...j,
      status: 'settled',
      consumed_usd: input.final_amount_usd,
    };
    dcompJobs.set(input.job_id, settled);
    return {
      job: settled,
      merchant_signature: signSettlement(
        j.provider_signing_seed,
        input.job_id,
        input.final_amount_usd,
      ),
    };
  },

  list(): ReadonlyArray<DcompJob> {
    return Array.from(dcompJobs.values());
  },

  /// Test-only — clears all jobs. Don't call from request handlers.
  __reset(): void {
    dcompJobs.clear();
  },
};

export const HyperscalerStore = {
  charge(input: {
    task_id: string;
    amount_usd: number;
    intent_hash: string;
  }): HyperscalerAuthorization {
    const auth: HyperscalerAuthorization = {
      authorization_id: `auth_${ulid()}`,
      task_id: input.task_id,
      amount_usd: input.amount_usd,
      intent_hash: input.intent_hash,
      status: 'authorized',
      created_at: Math.floor(Date.now() / 1000),
    };
    hyperscalerAuths.set(auth.authorization_id, auth);
    return auth;
  },

  get(authorization_id: string): HyperscalerAuthorization | undefined {
    return hyperscalerAuths.get(authorization_id);
  },

  list(): ReadonlyArray<HyperscalerAuthorization> {
    return Array.from(hyperscalerAuths.values());
  },

  __reset(): void {
    hyperscalerAuths.clear();
  },
};

/// Deterministic mock signature. Real implementation would be ECDSA over the
/// EIP-191 prefixed digest matching Escrow.sol's settle() check.
const signSettlement = (seed: string, jobId: string, finalAmountUsd: number): string => {
  let acc = 0;
  const s = `${seed}|${jobId}|${finalAmountUsd}`;
  for (let i = 0; i < s.length; i++) {
    acc = (acc * 31 + s.charCodeAt(i)) >>> 0;
  }
  return `0x${acc.toString(16).padStart(8, '0').repeat(8)}`;
};
