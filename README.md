# AutoCompute

> An agent-to-agent compute marketplace where an autonomous agent shops for
> GPU/compute jobs, opens USDC escrows on-chain, draws from an on-chain
> credit line when costs overrun, and produces a fully reconciled statement
> — all within Visa's Machine Payment Protocol (MPP) trust frame.

This is a proof of concept. Not production. Testnet only. See
[`design.md`](./design.md) for the blueprint and [`RUNBOOK.md`](./RUNBOOK.md)
for step-by-step demo instructions.

---

## What the system does

A **Principal** (the human or business that holds the budget) issues a
short-lived **delegation JWT** to a **Compute Agent** — bounded by spend
caps, a merchant allowlist, and a TTL. The agent uses that delegation to:

1. **Quote** compute providers (a "decentralized" marketplace `dcomp` and a
   legacy `hyperscaler`) for a task
2. **Pay** whichever provider it picks — either by:
   - opening a **USDC escrow** on-chain (default for crypto-native rails), or
   - charging a **Visa card** through the hyperscaler (legacy rail)
3. **Draw** USDC from an on-chain **credit line** if the job overruns budget
4. **Settle** the escrow when the job finishes — provider's signature on
   the final amount is verified on-chain, refund returns to the agent
5. **Repay** the credit-line draw out of the next inflow

Every step issues an **MPP credential** (delegation → intent → settlement),
gets written to a **unified ledger**, and is **reconciled** against the
on-chain event log. The reconciler flags anomalies (intent without
settlement, ledger-vs-chain amount mismatch, etc.) so the Principal sees a
single coherent statement across all rails.

### The three rails, side-by-side

| | USDC escrow | Credit line | Visa card |
| --- | --- | --- | --- |
| **Backed by** | `Escrow.sol` on Sepolia | `CreditLine.sol` on Sepolia | mock hyperscaler `/charge` |
| **Trigger** | `pay_usdc_escrow` | `draw_credit` / `repay_credit` | `pay_visa_card` |
| **Settlement** | provider signs `(escrowAddr, jobId, final)` → on-chain ECDSA verify | borrow / repay against own collateral | authorize → capture (off-chain) |
| **MPP receipt** | delegation → intent → settlement | intent → settlement | intent → settlement |
| **Ledger row** | `onchain_events.kind = 'escrow_opened' / 'escrow_settled'` | `'credit_borrowed' / 'credit_repaid'` | `card_charges` |

### Architecture at a glance

```
┌──────────────────┐    delegation JWT    ┌──────────────────┐
│   Principal      │ ─────────────────►   │  Compute Agent   │
│ (dashboard)      │                       │   (LLM loop)     │
└──────────────────┘                       └────────┬─────────┘
        ▲                                            │
        │ unified statement                          │ tool calls
        │                                            ▼
┌──────────────────┐                       ┌──────────────────────────┐
│  Reconciler      │ ◄──── ledger ───────  │ Guardrails (pure)        │
│ (TS + SQL view)  │                       │ MPP simulator (Ed25519)  │
└──────────────────┘                       │ Provider HTTP            │
        ▲                                  │ Escrow / Credit ports    │
        │                                  └────────┬─────────────────┘
        │                                           │
        │             ┌─────────────────────────────┼──────────────┐
        │             ▼                             ▼              ▼
        │   ┌────────────────┐    ┌──────────────────────┐  ┌──────────────┐
        └── │ Supabase       │    │ Ethereum Sepolia     │  │ Mock dcomp / │
            │ (mpp_receipts, │    │ Escrow.sol           │  │ hyperscaler  │
            │ onchain_events,│    │ CreditLine.sol       │  │ (Next.js)    │
            │ card_charges)  │    │ USDC (ERC-20)        │  │              │
            └────────────────┘    └──────────────────────┘  └──────────────┘
```

Every external dependency is behind a typed port (`MppPort`, `LlmPort`,
`EscrowPort`, `CreditPort`, `LedgerSink`, `ProviderPort`) with an
in-memory + a real implementation. The Tier 1→2→3 progression is
implemented as port swaps, not code rewrites.

---

## The demo

There are three tiers, each layered on top of the previous. All three
share the same agent loop; only the ports it talks to change.

### Tier 1 — runnable agent + mock providers (≈30s)

No database. No chain. The agent picks providers, opens an in-memory
escrow, draws virtual credit, settles, and prints a reconciled statement.
Works with `FakeScriptedLlmPort` (deterministic, no API key), real Claude
(`LLM_BACKEND=anthropic`), or any OpenAI-compatible local model
(`LLM_BACKEND=openai_compat` — LM Studio, Ollama, vLLM, llama.cpp,
OpenRouter).

```bash
pnpm install
pnpm dev                    # Terminal 1 — Next.js + mock providers
pnpm script:agent           # Terminal 2 — runs the agent end-to-end
```

Expected tail of the output:

```jsonc
{"msg":"unified statement (reconciled)","rows":[
  {"rail":"credit_line", "credit_drawn_usd":50, "credit_repaid_usd":50, "anomalies":[]},
  {"rail":"usdc_escrow", "mpp_settled_usd":78, "escrow_settled_usd":78, "anomalies":[]}
]}
```

### Tier 2 — Supabase ledger + reconciled view

Same agent, same flow — except every MPP receipt and on-chain event is
written to a local Postgres (via `supabase start`). The reconciler now
queries the `unified_statement` SQL view and compares it against the
in-process TypeScript reconciler — they must agree row-for-row, and any
anomaly the SQL view flags is also flagged in-process.

```bash
brew install supabase/tap/supabase   # macOS; see Supabase docs otherwise
supabase start                       # local Postgres + Studio on :54323
supabase db reset                    # applies supabase/migrations/0001_init.sql

# .env
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres

pnpm script:agent                    # now writes to Postgres
```

Open Supabase Studio at <http://127.0.0.1:54323> and inspect:

```sql
select * from mpp_receipts;
select * from onchain_events;
select * from unified_statement;
```

### Tier 3 — real testnet (Ethereum Sepolia)

The two in-memory ports swap out for viem-backed
`OnchainEscrowPort` + `OnchainCreditPort`. The agent now broadcasts real
transactions to deployed `Escrow.sol` and `CreditLine.sol` contracts. The
provider's settle signature is a real ECDSA signature that `Escrow.sol`
recovers on-chain.

**Currently deployed (Ethereum Sepolia, chain `11155111`):**

| Contract / actor | Address |
| --- | --- |
| `Escrow.sol` | [`0x7590cD3bA111Bd05Fb289A63e92464cc8B283e0F`](https://sepolia.etherscan.io/address/0x7590cD3bA111Bd05Fb289A63e92464cc8B283e0F) |
| `CreditLine.sol` | [`0xdf36B0c9B26067e3B8477b9259ED426DA79fd150`](https://sepolia.etherscan.io/address/0xdf36B0c9B26067e3B8477b9259ED426DA79fd150) |
| USDC (Circle testnet) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| Agent (Privy server wallet) | `0x3545fD7761c6Bd5Ef17c5Ac65c369d44E26ccA9F` |

**What happens, end-to-end, when you run `pnpm script:agent` with the Tier 3
env vars set:**

1. Agent generates an Ed25519 keypair, MPP simulator issues a **delegation
   JWT** scoped to the configured caps + allowlist. Ledger row in
   `mpp_receipts` (kind=delegation).
2. Agent calls the dcomp + hyperscaler mocks for **quotes**.
3. Agent picks dcomp, issues an MPP **intent**, opens the on-chain escrow —
   `USDC.approve` + `Escrow.openJob(provider, $4, deadline, intentHash,
   taskId)`. Two real txs on Sepolia. Escrow contract now holds 4 USDC.
4. Budget overruns mid-job → agent **draws** $2 from the credit line. The
   `OnchainCreditPort` reads the account, sees no collateral, posts $4
   collateral (50% LTV), then `borrow($2)`. Three real txs.
5. Job finishes → agent calls dcomp `/settle($3.9)`. The dcomp mock signs
   the EIP-191-wrapped `keccak256(escrowAddr, jobId, finalAmount)` digest
   with its on-chain EOA. Agent calls `Escrow.settle(jobId, $3.9, sig)`.
   Contract recovers ECDSA → matches the provider stored at openJob →
   transfers $3.9 to the provider, refunds $0.1 to the agent. MPP
   settlement countersigned.
6. Agent **repays** $2 to the credit line. `USDC.approve` +
   `CreditLine.repay($2)`. Principal back to 0.
7. Reconciler snapshots all sinks and prints the unified statement. For
   the Tier 3 task:

```jsonc
{ "task_id": "task_…",
  "rail": "usdc_escrow",
  "mpp_settled_usd": 3.9,
  "escrow_settled_usd": 3.9,    // ← real on-chain settle event
  "escrow_refunded_usd": 0,
  "anomalies": [] }
{ "task_id": "task_…",
  "rail": "credit_line",
  "credit_drawn_usd": 2,
  "credit_repaid_usd": 2,
  "anomalies": [] }
```

You can verify every transaction on Sepolia Etherscan; `JobOpened`,
`JobSettled`, `Borrowed`, and `Repaid` events are emitted by the
contracts and observable independently of this repo.

### Demo drawbacks (explicit scope choices — not bugs)

This is a PoC. Each of these is a deliberate simplification, called out
so you don't mistake them for defects:

- **A Tier 3 run burns ~$4 testnet USDC of float per execution** (3.9 to
  the provider, 0.1 refund). Top up between runs.
- **`CreditLine` is same-asset.** Collateral and debt are both USDC, so
  the LTV mechanic demonstrates the agent's draw/repay loop but isn't
  safe for production. Real lending would price collateral against an
  oracle.
- **No metering loop.** `Escrow.meter()` exists; the scripted plan
  jumps from openJob → settle without progress updates.
- **Mock provider state lives in process memory** (pinned to
  `globalThis` so Next.js HMR doesn't fork it; cold restarts wipe it).
- **No tx batching / 4337 paymaster.** One demo run mints 6–8 separate
  txs; a 4337 smart wallet would batch them.
- **Signer choice is fixed at boot** — Privy XOR raw EOA. No runtime
  rotation.
- **Demo doesn't withdraw collateral at the end**, so each Tier 3 run
  leaves 4 USDC posted in `CreditLine` as collateral with 0 principal
  (withdrawable; the script just doesn't call it).

---

## Repo layout

| Concern | Location |
| --- | --- |
| Web app + API routes (Principal dashboard, mock providers) | `apps/web/` (Next.js App Router) |
| Compute Agent loop (tool use, `LlmPort` abstraction) | `apps/agent/` |
| MPP simulator + `MppPort` adapter | `services/mpp-sim/` |
| Reconciliation worker + LedgerSink ports | `services/reconciler/` |
| Solidity contracts (`Escrow.sol`, `CreditLine.sol`) | `contracts/` (Foundry) |
| Smart-wallet & onchain client helpers | `packages/onchain/` |
| Shared types (MPP claims, task DTOs, ledger rows) | `packages/types/` |
| Supabase migrations | `supabase/migrations/` |
| Offline MPP-only walkthrough | `scripts/demo.ts` |
| End-to-end runnable demo (tier 1/2/3 aware) | `scripts/agent.ts` (`pnpm script:agent`) |
| Step-by-step setup | `RUNBOOK.md` |
| Full blueprint | `design.md` |

---

## Tests

- `pnpm test` — 91 vitest tests across MPP, guardrails, handlers,
  reconciler, ports
- `forge test` — 12 Solidity tests for `Escrow.sol` + `CreditLine.sol`
- `pnpm typecheck` and `pnpm lint` — TS strict, ESLint + Prettier
- `pnpm demo` — 30s offline MPP walkthrough (no chain, no DB)
- `pnpm script:agent` — full agent run, behavior depends on env (see
  [`RUNBOOK.md`](./RUNBOOK.md))

---

## Why this exists

To show that the **same agent**, with the **same guardrails** and the
**same reconciliation**, can drive payments across **a card rail** and
**two crypto rails** under one credential model — MPP — without bespoke
integration per rail. Tier 1 is the loop. Tier 2 adds durability. Tier 3
proves the same code works against a real chain. The goal isn't to ship
this as-is; it's to make the architecture concrete enough that the
production version can be built off this skeleton.
