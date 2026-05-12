import { ulid } from 'ulidx';
import {
  openEscrowJob,
  settleEscrowJob,
  taskIdToBytes32,
  usdToUsdc6,
  type Address,
  type AgentWallet,
  type Hex,
} from '@autocompute/onchain';
import type { LedgerSink } from '@autocompute/reconciler';
import type { TaskId } from '@autocompute/types';

export interface OpenEscrowInput {
  task_id: TaskId;
  amount_usd: number;
  intent_hash: Hex;
  deadline_unix_sec: number;
}
export interface OpenEscrowOutput {
  job_id: string;
  onchain_tx_hash: Hex | null;
}
export interface SettleEscrowInput {
  task_id: TaskId;
  job_id: string;
  final_amount_usd: number;
  provider_signature: Hex;
}
export interface SettleEscrowOutput {
  onchain_tx_hash: Hex | null;
}

/// Onchain escrow leg, factored out of the handler so the agent can swap
/// in-memory (sandbox / unit tests) for a real Escrow.sol call on Base
/// Sepolia by changing one line.
export interface EscrowPort {
  openJob(input: OpenEscrowInput): Promise<OpenEscrowOutput>;
  settle(input: SettleEscrowInput): Promise<SettleEscrowOutput>;
}

export interface InMemoryEscrowPortConfig {
  ledgerSink?: LedgerSink;
}

/// In-memory port. Doesn't talk to a real chain; writes synthetic
/// `escrow_opened` / `escrow_settled` rows to the ledger sink so the
/// reconciler can compute the same unified statement it would compute
/// against a real Base Sepolia indexer.
export class InMemoryEscrowPort implements EscrowPort {
  private nextLogIndex = 0;
  private readonly jobs = new Map<
    string,
    { task_id: TaskId; intent_hash: Hex; amount_usd: number }
  >();
  private readonly cfg: InMemoryEscrowPortConfig;

  constructor(cfg: InMemoryEscrowPortConfig = {}) {
    this.cfg = cfg;
  }

  async openJob(input: OpenEscrowInput): Promise<OpenEscrowOutput> {
    const job_id = `inmem_job_${ulid()}`;
    const onchain_tx_hash = synthTx();
    this.jobs.set(job_id, {
      task_id: input.task_id,
      intent_hash: input.intent_hash,
      amount_usd: input.amount_usd,
    });
    if (this.cfg.ledgerSink) {
      await this.cfg.ledgerSink.recordOnchainEvent({
        id: ulid(),
        kind: 'escrow_opened',
        task_id: input.task_id,
        tx_hash: onchain_tx_hash,
        log_index: this.nextLogIndex++,
        job_id,
        intent_hash: input.intent_hash,
        amount_usd: input.amount_usd,
        final_amount_usd: null,
        refunded_usd: null,
        account: null,
      });
    }
    return { job_id, onchain_tx_hash };
  }

  async settle(input: SettleEscrowInput): Promise<SettleEscrowOutput> {
    const job = this.jobs.get(input.job_id);
    if (!job) throw new Error(`unknown escrow job: ${input.job_id}`);
    const onchain_tx_hash = synthTx();
    if (this.cfg.ledgerSink) {
      const refunded_usd = Math.max(0, job.amount_usd - input.final_amount_usd);
      await this.cfg.ledgerSink.recordOnchainEvent({
        id: ulid(),
        kind: 'escrow_settled',
        task_id: input.task_id,
        tx_hash: onchain_tx_hash,
        log_index: this.nextLogIndex++,
        job_id: input.job_id,
        intent_hash: job.intent_hash,
        amount_usd: null,
        final_amount_usd: input.final_amount_usd,
        refunded_usd: refunded_usd > 0 ? refunded_usd : null,
        account: null,
      });
    }
    this.jobs.delete(input.job_id);
    return { onchain_tx_hash };
  }
}

export interface OnchainEscrowPortConfig {
  wallet: AgentWallet;
  escrow: Address;
  usdc: Address;
  ledgerSink?: LedgerSink;
}

/// Onchain port. Calls Escrow.openJob / Escrow.settle via packages/onchain.
/// Requires the agent's wallet to hold USDC (or have it pulled in via a
/// paymaster-funded smart wallet). Wires the resulting tx hash into the
/// ledger sink synchronously; for production a separate indexer would
/// emit the events on chain confirmation instead.
export class OnchainEscrowPort implements EscrowPort {
  private nextLogIndex = 0;
  constructor(private readonly cfg: OnchainEscrowPortConfig) {}

  async openJob(input: OpenEscrowInput): Promise<OpenEscrowOutput> {
    const { openTx, jobId } = await openEscrowJob({
      escrow: this.cfg.escrow,
      usdc: this.cfg.usdc,
      wallet: this.cfg.wallet,
      provider: this.cfg.wallet.address, // PoC: provider is the wallet itself
      amountUsd: input.amount_usd,
      deadlineUnixSec: input.deadline_unix_sec,
      intentHash: input.intent_hash,
      taskIdBytes32: taskIdToBytes32(input.task_id),
    });
    // `job_id` is the contract-assigned uint256 from JobOpened, serialized
    // as a decimal string so it round-trips cleanly through the ledger and
    // the agent's open_intents map.
    const job_id = jobId.toString();
    if (this.cfg.ledgerSink) {
      await this.cfg.ledgerSink.recordOnchainEvent({
        id: ulid(),
        kind: 'escrow_opened',
        task_id: input.task_id,
        tx_hash: openTx,
        log_index: this.nextLogIndex++,
        job_id,
        intent_hash: input.intent_hash,
        amount_usd: input.amount_usd,
        final_amount_usd: null,
        refunded_usd: null,
        account: this.cfg.wallet.address,
      });
    }
    return { job_id, onchain_tx_hash: openTx };
  }

  async settle(input: SettleEscrowInput): Promise<SettleEscrowOutput> {
    // job_id was emitted by Escrow.JobOpened as a uint256; we serialized it
    // to a decimal string when storing. Use BigInt() (not parseInt) so we
    // don't truncate ids that exceed Number.MAX_SAFE_INTEGER.
    const tx = await settleEscrowJob({
      escrow: this.cfg.escrow,
      wallet: this.cfg.wallet,
      jobId: BigInt(input.job_id),
      finalAmountUsd: input.final_amount_usd,
      providerSig: input.provider_signature,
    });
    if (this.cfg.ledgerSink) {
      await this.cfg.ledgerSink.recordOnchainEvent({
        id: ulid(),
        kind: 'escrow_settled',
        task_id: input.task_id,
        tx_hash: tx,
        log_index: this.nextLogIndex++,
        job_id: input.job_id,
        intent_hash: null,
        amount_usd: null,
        final_amount_usd: input.final_amount_usd,
        refunded_usd: null,
        account: this.cfg.wallet.address,
      });
    }
    return { onchain_tx_hash: tx };
  }
}

const synthTx = (): Hex => {
  const hex = ulid().toLowerCase().padEnd(64, '0').slice(0, 64);
  return `0x${hex.replace(/[^0-9a-f]/g, '0')}` as Hex;
};

// re-export for downstream wiring convenience
export { usdToUsdc6 };
