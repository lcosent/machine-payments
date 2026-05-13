-- AutoCompute reconciliation ledger.
--
-- Three append-only tables (`mpp_receipts`, `onchain_events`, `card_charges`)
-- record what each rail said happened, plus one view (`unified_statement`)
-- that joins them by task_id so the Principal can audit a task across rails.
--
-- All writes are idempotent on `idempotency_key`. The reconciliation worker
-- can replay event streams without producing duplicates.

create extension if not exists "pgcrypto";

------------------------------------------------------------
-- Reference data
------------------------------------------------------------

create table if not exists agents (
  id text primary key check (id ~ '^agent:[a-z0-9-]+$'),
  principal text not null check (principal ~ '^ent:[a-z0-9-]+$'),
  created_at timestamptz not null default now()
);

create table if not exists tasks (
  id text primary key check (id ~ '^task_[A-Z0-9]{26}$'),
  agent_id text not null references agents(id),
  description text not null,
  budget_ceiling_usd numeric(18, 6) not null check (budget_ceiling_usd > 0),
  deadline timestamptz,
  status text not null default 'submitted'
    check (status in ('submitted','quoting','awaiting_funds','running','metering','settled','failed','cancelled')),
  created_at timestamptz not null default now()
);

------------------------------------------------------------
-- MPP receipts (delegations, intents, settlements)
------------------------------------------------------------

create type mpp_receipt_kind as enum ('delegation','intent','settlement');

create table if not exists mpp_receipts (
  jti text primary key,
  kind mpp_receipt_kind not null,
  task_id text references tasks(id),
  agent_id text not null references agents(id),
  rail text check (rail in ('visa_card','usdc_escrow','credit_line')),
  merchant text check (merchant is null or merchant ~ '^merchant:[a-z0-9-]+$'),
  amount_ceiling_usd numeric(18, 6),
  final_amount_usd numeric(18, 6),
  intent_jti text,                 -- settlement → originating intent
  intent_hash text,                -- 0x-prefixed 32-byte hex
  jwt text not null,
  issued_at timestamptz not null,
  expires_at timestamptz,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists mpp_receipts_task_idx on mpp_receipts(task_id);
create index if not exists mpp_receipts_intent_jti_idx on mpp_receipts(intent_jti) where intent_jti is not null;

------------------------------------------------------------
-- Onchain events (Escrow.sol, CreditLine.sol)
------------------------------------------------------------

create type onchain_event_kind as enum (
  'escrow_opened',
  'escrow_metered',
  'escrow_settled',
  'escrow_refunded',
  'credit_borrowed',
  'credit_repaid',
  'credit_liquidated'
);

create table if not exists onchain_events (
  id uuid primary key default gen_random_uuid(),
  kind onchain_event_kind not null,
  task_id text references tasks(id),
  tx_hash text not null check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  log_index integer not null check (log_index >= 0),
  block_number bigint not null,
  block_timestamp timestamptz not null,
  -- Escrow fields
  job_id text,
  intent_hash text,
  amount_usd numeric(18, 6),
  final_amount_usd numeric(18, 6),
  refunded_usd numeric(18, 6),
  -- Credit fields
  account text,
  -- Free-form payload for fields not promoted above
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create unique index if not exists onchain_events_tx_log_idx on onchain_events(tx_hash, log_index);
create index if not exists onchain_events_task_idx on onchain_events(task_id);
create index if not exists onchain_events_intent_hash_idx on onchain_events(intent_hash) where intent_hash is not null;

------------------------------------------------------------
-- Card charges (simulated Visa rail)
------------------------------------------------------------

create table if not exists card_charges (
  authorization_id text primary key,
  task_id text references tasks(id),
  agent_id text not null references agents(id),
  merchant text not null check (merchant ~ '^merchant:[a-z0-9-]+$'),
  amount_usd numeric(18, 6) not null check (amount_usd > 0),
  intent_hash text,
  status text not null default 'authorized'
    check (status in ('authorized','captured','voided','disputed')),
  intent_jti text,
  idempotency_key text not null unique,
  authorized_at timestamptz not null default now(),
  captured_at timestamptz
);

create index if not exists card_charges_task_idx on card_charges(task_id);

------------------------------------------------------------
-- Anomaly log (set by the reconciler)
------------------------------------------------------------

create type anomaly_kind as enum (
  'intent_without_settlement',
  'settlement_without_intent',
  'final_exceeds_intent_ceiling',
  'onchain_amount_mismatch',
  'orphan_onchain_event',
  'duplicate_settlement'
);

create table if not exists anomalies (
  id uuid primary key default gen_random_uuid(),
  task_id text references tasks(id),
  kind anomaly_kind not null,
  detail jsonb not null default '{}'::jsonb,
  detected_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists anomalies_task_idx on anomalies(task_id);
create index if not exists anomalies_unresolved_idx on anomalies(task_id) where resolved_at is null;

------------------------------------------------------------
-- Unified statement view
------------------------------------------------------------

-- One row per (task_id, rail) summarising MPP receipts + onchain events +
-- card charges. The Principal's audit surface.

create or replace view unified_statement as
with mpp_per_task_rail as (
  select
    task_id,
    rail,
    sum(final_amount_usd) filter (where kind = 'settlement') as mpp_settled_usd,
    sum(amount_ceiling_usd) filter (where kind = 'intent') as mpp_intent_ceiling_usd,
    count(*) filter (where kind = 'intent') as intent_count,
    count(*) filter (where kind = 'settlement') as settlement_count
  from mpp_receipts
  where task_id is not null and rail is not null
  group by task_id, rail
),
onchain_per_task as (
  select
    task_id,
    sum(final_amount_usd) filter (where kind = 'escrow_settled') as escrow_settled_usd,
    sum(refunded_usd) filter (where kind = 'escrow_refunded') as escrow_refunded_usd,
    sum(amount_usd) filter (where kind = 'credit_borrowed') as credit_drawn_usd,
    sum(amount_usd) filter (where kind = 'credit_repaid') as credit_repaid_usd
  from onchain_events
  where task_id is not null
  group by task_id
),
card_per_task as (
  select
    task_id,
    sum(amount_usd) filter (where status in ('authorized','captured')) as card_charged_usd
  from card_charges
  where task_id is not null
  group by task_id
),
anomaly_flags as (
  select task_id, array_agg(distinct kind::text) as anomalies
  from anomalies
  where resolved_at is null and task_id is not null
  group by task_id
)
select
  t.id as task_id,
  t.agent_id,
  t.status,
  coalesce(m.rail, 'visa_card') as rail,
  coalesce(m.mpp_settled_usd, 0) as mpp_settled_usd,
  coalesce(m.mpp_intent_ceiling_usd, 0) as mpp_intent_ceiling_usd,
  coalesce(m.intent_count, 0) as intent_count,
  coalesce(m.settlement_count, 0) as settlement_count,
  coalesce(o.escrow_settled_usd, 0) as escrow_settled_usd,
  coalesce(o.escrow_refunded_usd, 0) as escrow_refunded_usd,
  coalesce(o.credit_drawn_usd, 0) as credit_drawn_usd,
  coalesce(o.credit_repaid_usd, 0) as credit_repaid_usd,
  coalesce(c.card_charged_usd, 0) as card_charged_usd,
  coalesce(a.anomalies, array[]::text[]) as anomalies
from tasks t
left join mpp_per_task_rail m on m.task_id = t.id
left join onchain_per_task o on o.task_id = t.id
left join card_per_task c on c.task_id = t.id
left join anomaly_flags a on a.task_id = t.id;
