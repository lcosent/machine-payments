import type { CardChargeRow, MppReceiptRow, OnchainEventRow } from './types.js';

/// Append-only sink the agent + MPP service + onchain indexer + mock providers
/// write through. The Supabase implementation persists; the in-memory
/// implementation buffers in a process. Reads from any implementation are
/// snapshot-style so reconcile() can run over a consistent view.
export interface LedgerSink {
  recordMppReceipt(row: MppReceiptRow): Promise<void>;
  recordOnchainEvent(row: OnchainEventRow): Promise<void>;
  recordCardCharge(row: CardChargeRow): Promise<void>;
  /// Returns a consistent point-in-time snapshot. Implementations are free to
  /// freeze copies of their rows or wrap the read in a transaction.
  snapshot(): Promise<LedgerSnapshot>;
}

export interface LedgerSnapshot {
  mpp_receipts: ReadonlyArray<MppReceiptRow>;
  onchain_events: ReadonlyArray<OnchainEventRow>;
  card_charges: ReadonlyArray<CardChargeRow>;
}

export class InMemoryLedgerSink implements LedgerSink {
  private readonly mpp = new Map<string, MppReceiptRow>();
  private readonly onchain = new Map<string, OnchainEventRow>();
  private readonly card = new Map<string, CardChargeRow>();

  async recordMppReceipt(row: MppReceiptRow): Promise<void> {
    this.mpp.set(row.jti, row);
  }
  async recordOnchainEvent(row: OnchainEventRow): Promise<void> {
    const key = `${row.tx_hash}|${row.log_index}`;
    this.onchain.set(key, row);
  }
  async recordCardCharge(row: CardChargeRow): Promise<void> {
    this.card.set(row.authorization_id, row);
  }
  async snapshot(): Promise<LedgerSnapshot> {
    return {
      mpp_receipts: Array.from(this.mpp.values()),
      onchain_events: Array.from(this.onchain.values()),
      card_charges: Array.from(this.card.values()),
    };
  }
}
