import postgres, { type Sql } from 'postgres';
import type { LedgerSink, LedgerSnapshot } from './ledger-sink.js';
import type { CardChargeRow, MppReceiptRow, OnchainEventRow } from './types.js';

/// LedgerSink backed by Postgres (e.g., the local Supabase instance started
/// via `supabase start`). Writes are upserts on the unique key so the agent
/// + reconciler can be replayed safely. Each method generates an
/// idempotency_key that's deterministic from the row's content, so the same
/// JWT or tx_hash never produces two ledger rows.
export interface SupabaseLedgerSinkConfig {
  /// PG connection string. With Supabase: `postgresql://postgres:postgres@localhost:54322/postgres`
  databaseUrl: string;
  /// Optional override; defaults to using the connection's search_path.
  schema?: string;
  /// Optional override for tests.
  sqlClient?: Sql;
}

export class SupabaseLedgerSink implements LedgerSink {
  private readonly sql: Sql;
  private readonly schema: string;
  private readonly ownsClient: boolean;

  constructor(cfg: SupabaseLedgerSinkConfig) {
    this.schema = cfg.schema ?? 'public';
    if (cfg.sqlClient) {
      this.sql = cfg.sqlClient;
      this.ownsClient = false;
    } else {
      this.sql = postgres(cfg.databaseUrl, { onnotice: () => {} });
      this.ownsClient = true;
    }
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.sql.end({ timeout: 5 });
  }

  async recordMppReceipt(row: MppReceiptRow): Promise<void> {
    const idempotencyKey = `mpp:${row.jti}`;
    await this.sql`
      insert into ${this.sql(this.schema)}.mpp_receipts (
        jti, kind, task_id, agent_id, rail, merchant,
        amount_ceiling_usd, final_amount_usd, intent_jti, intent_hash,
        jwt, issued_at, idempotency_key
      ) values (
        ${row.jti}, ${row.kind}, ${row.task_id}, ${row.agent_id}, ${row.rail}, ${row.merchant},
        ${row.amount_ceiling_usd}, ${row.final_amount_usd}, ${row.intent_jti}, ${row.intent_hash},
        '', now(), ${idempotencyKey}
      )
      on conflict (idempotency_key) do nothing
    `;
  }

  async recordOnchainEvent(row: OnchainEventRow): Promise<void> {
    const idempotencyKey = `onchain:${row.tx_hash}:${row.log_index}`;
    await this.sql`
      insert into ${this.sql(this.schema)}.onchain_events (
        kind, task_id, tx_hash, log_index, block_number, block_timestamp,
        job_id, intent_hash, amount_usd, final_amount_usd, refunded_usd,
        account, idempotency_key
      ) values (
        ${row.kind}, ${row.task_id}, ${row.tx_hash}, ${row.log_index}, 0, now(),
        ${row.job_id}, ${row.intent_hash}, ${row.amount_usd}, ${row.final_amount_usd}, ${row.refunded_usd},
        ${row.account}, ${idempotencyKey}
      )
      on conflict (idempotency_key) do nothing
    `;
  }

  async recordCardCharge(row: CardChargeRow): Promise<void> {
    const idempotencyKey = `card:${row.authorization_id}`;
    await this.sql`
      insert into ${this.sql(this.schema)}.card_charges (
        authorization_id, task_id, agent_id, merchant, amount_usd,
        intent_hash, status, intent_jti, idempotency_key
      ) values (
        ${row.authorization_id}, ${row.task_id}, ${row.agent_id}, ${row.merchant}, ${row.amount_usd},
        ${row.intent_hash}, ${row.status}, ${row.intent_jti}, ${idempotencyKey}
      )
      on conflict (idempotency_key) do nothing
    `;
  }

  async snapshot(): Promise<LedgerSnapshot> {
    const [mpp, onchain, card] = await Promise.all([
      this.sql<MppReceiptRow[]>`
        select jti, kind::text, task_id, agent_id, rail, merchant,
               amount_ceiling_usd::float8 as amount_ceiling_usd,
               final_amount_usd::float8 as final_amount_usd,
               intent_jti, intent_hash
          from ${this.sql(this.schema)}.mpp_receipts
      `,
      this.sql<OnchainEventRow[]>`
        select gen_random_uuid()::text as id, kind::text, task_id, tx_hash, log_index, job_id,
               intent_hash,
               amount_usd::float8 as amount_usd,
               final_amount_usd::float8 as final_amount_usd,
               refunded_usd::float8 as refunded_usd,
               account
          from ${this.sql(this.schema)}.onchain_events
      `,
      this.sql<CardChargeRow[]>`
        select authorization_id, task_id, agent_id, merchant,
               amount_usd::float8 as amount_usd,
               intent_hash, status::text, intent_jti
          from ${this.sql(this.schema)}.card_charges
      `,
    ]);
    return {
      mpp_receipts: mpp,
      onchain_events: onchain,
      card_charges: card,
    };
  }
}
