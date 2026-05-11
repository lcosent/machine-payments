# AutoCompute — Agent-to-Agent Compute Marketplace PoC

A proof-of-concept that demonstrates the combined value of **Visa's Machine
Payment Protocol (MPP)**, **stablecoins**, and **onchain credit** in a single,
coherent flow that no existing payments stack delivers today.

> **Status:** design document for a PoC. Testnet only. No real funds, no real
> cards, no production claims.

---

## 1. Context & Motivation

AI agents are starting to take actions that cost money — booking compute,
calling paid APIs, paying contractors, buying inventory. The payments stack was
designed for humans-in-the-loop and breaks down for machines on three fronts:

1. **Identity / authority.** A corporate card has no notion of "this agent, for
   this purpose, up to this limit, until next Tuesday." Visa's Machine Payment
   Protocol (MPP) introduces issuer-signed, scoped delegations that bind a
   transaction to an agent, an intent, and a budget.
2. **Settlement rails.** Card networks can't do per-second metering, can't
   settle to crypto-native counterparties, and lag at cross-border payouts.
   Stablecoins (USDC on Base) do all three, programmably.
3. **Working capital.** Agents need to absorb spikes — a training job balloons,
   a tool call retries, ad spend opens a new winner. Human-gated credit lines
   can't keep up. Onchain credit (Aave/Morpho-style) is callable from a smart
   contract in seconds.

No one of these alone is sufficient. **The PoC's job is to show the
intersection.**

---

## 2. The Use Case — "AutoCompute"

An enterprise (the **Principal**) provisions an autonomous **Compute Agent** to
procure compute on its behalf. The agent operates against a **mixed marketplace**:

- **Hyperscaler-style providers** (mocked): billed via Visa card rails. The
  agent presents an MPP-scoped virtual-card credential and the provider charges
  it like any merchant.
- **Decentralized / agent-native providers** (mocked): per-unit USDC payments
  via on-chain escrow. The provider exposes `/quote → /start → /meter → /settle`.

When the agent's prefunded float runs short, it **autonomously draws from an
onchain credit line** (overcollateralized Morpho-Blue-style pool), and
auto-repays when downstream revenue lands or the Principal tops up.

All activity flows into a **Unified Statement** the Principal can audit:
MPP-signed receipts + onchain events, joined by `task_id`.

### Worked example

> The Principal funds AutoCompute with $200 USDC float and a $1,000 daily MPP cap.
> A user submits the task **"render 60s of 4K video, deadline 2h."**
>
> 1. Agent queries two providers. Hyperscaler quotes $140 fiat, 90 min. A
>    decentralized GPU provider quotes 80 USDC, 70 min. Agent picks the
>    decentralized provider (cheaper, faster, within scope).
> 2. Agent opens a USDC escrow for 80, signed and authorized by an MPP intent
>    receipt. Provider starts rendering, posts `/meter` every 10s.
> 3. At 50% progress the job's projected cost rises to 130 USDC (a denoise pass
>    is heavier than estimated). Agent's remaining float is 120. **It draws 50
>    USDC from the credit line**, tops up escrow, continues.
> 4. Provider posts final `/settle` for 128 USDC. Escrow releases. Agent
>    repays 50 USDC + interest to the credit line. Final MPP receipt countersigned.
> 5. Principal dashboard shows: one task, $128 USDC, credit line touched
>    briefly, MPP audit trail intact.

---

## 3. Why This Beats the Standard

| Approach | Identity / authority | Settlement | Working capital | Reconciliation |
|---|---|---|---|---|
| Corporate card + human | OK for humans, none for agents | Card rails only; fees, lag, no crypto-native | Human-gated credit, days | Manual |
| Prefunded crypto wallet | No delegation, no governance | Stablecoin only | None | None |
| Standard credit line | Human approval | Wire/ACH | Slow draw, slow repay | Manual |
| **AutoCompute (this PoC)** | **MPP-scoped delegation, signed receipts** | **Cards + USDC, sub-second** | **Programmatic draw/repay** | **Unified statement, joined by task** |

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  Principal (enterprise human)                   │
│   Dashboard: provision agent, set scope, audit statement        │
└───────────────────────────┬─────────────────────────────────────┘
                            │ signs delegation
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│      MPP Credential Service  (simulated, swap-in for Visa)      │
│   - Ed25519 issuer key                                          │
│   - Mints scoped delegations (VC-shaped JWTs)                   │
│   - Issues per-tx intent receipts + signed settlement receipts  │
└───────────────────────────┬─────────────────────────────────────┘
                            │ credential + per-tx intents
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│              Autonomous Compute Agent (Claude)                  │
│   - Tools: estimate, select_provider, pay_card, pay_usdc,       │
│           draw_credit, repay_credit, settle_task                │
│   - Guardrails: per-tx, daily, weekly caps; allowlist; HITL     │
└──────┬──────────────────┬─────────────────────────────┬─────────┘
       │                  │                             │
       ▼                  ▼                             ▼
┌──────────────┐   ┌──────────────────┐         ┌──────────────────┐
│ Hyperscaler  │   │ Decentralized    │         │ Onchain Credit   │
│ (mock)       │   │ Provider (mock)  │         │ Line (Morpho-    │
│ Visa card    │   │ USDC escrow      │         │ shaped; custom)  │
│ rail (sim)   │   │ /quote /start    │         │ draw/repay       │
│              │   │ /meter /settle   │         │                  │
└──────────────┘   └────────┬─────────┘         └────────┬─────────┘
                            │                            │
                            └──────────┬─────────────────┘
                                       ▼
                        ┌──────────────────────────────┐
                        │  Base Sepolia                │
                        │  USDC + Escrow.sol +         │
                        │  CreditLine.sol              │
                        │  via ERC-4337 smart wallet   │
                        │  + paymaster (gasless agent) │
                        └──────────────────────────────┘

                  All rails emit events → Supabase
                                       │
                                       ▼
                        ┌──────────────────────────────┐
                        │   Unified Statement Service  │
                        │   joins MPP receipts +       │
                        │   onchain events by task_id  │
                        └──────────────────────────────┘
```

### Components

| Component | Responsibility | Tech |
|---|---|---|
| Principal dashboard | Provision agents, set MPP scope, view statement | Next.js (App Router) on Vercel |
| MPP Credential Service | Issuer keys, mint delegations, per-tx intents, settlement receipts | Next.js route handlers + `jose` for JWT |
| Compute Agent | Plans and executes tasks; tool-using LLM with guardrails | Anthropic Claude Sonnet 4.6, prompt caching on system + tool defs |
| Hyperscaler mock | Quotes and charges via simulated Visa card rail | Next.js route handlers; in-memory ledger |
| Decentralized provider mock | Quotes; opens job; meters; settles against escrow | Next.js route handlers + Base Sepolia reads |
| `Escrow.sol` | Holds USDC for an active job; releases on settle, refunds on timeout | Foundry, deployed Base Sepolia |
| `CreditLine.sol` | Overcollateralized USDC credit line; draw/repay; interest accrual | Foundry, deployed Base Sepolia |
| Smart wallet | Gasless agent transactions | Coinbase Smart Wallet (preferred) or Privy embedded wallet |
| Reconciliation ledger | Joins MPP receipts + onchain events | Supabase Postgres |

---

## 5. Data Flow Walkthroughs

### 5a. Happy path (single rail, within budget)

1. Principal POSTs `/api/agents` → creates agent record, MPP service issues
   delegation JWT (scope: daily cap, allowlist, expiry).
2. User submits task → agent estimates cost, picks decentralized provider.
3. Agent calls MPP service → gets **intent receipt** binding (agent_id, task_id,
   provider, amount_ceiling, expiry).
4. Agent calls smart wallet → opens `Escrow.sol` job with 80 USDC, embeds
   intent-receipt hash.
5. Provider runs job, posts `/meter` ticks. On `/settle`, smart contract
   releases USDC. Provider returns settlement payload.
6. Agent calls MPP service → gets **settlement receipt** (countersigns
   provider's payload).
7. Reconciliation ledger writes a row joining intent + settlement + onchain tx.

### 5b. Multi-rail in one task

Task splits across providers (e.g., embedding model from a decentralized
provider, then post-processing on a hyperscaler). Two intent receipts, two
settlement receipts, two rails, one `task_id`. Statement view shows them as
sub-line-items.

### 5c. Cost overrun → autonomous credit draw

1. Mid-job, provider's `/meter` indicates projected cost will exceed remaining
   float by X.
2. Agent invokes `draw_credit(X + buffer)` tool. Guardrail check: within MPP
   daily cap? Below per-tx ceiling? Allowed provider? If all clear, smart wallet
   calls `CreditLine.borrow(amount)`.
3. Credit pool transfers USDC to smart wallet. Agent tops up escrow.
4. Job completes. Settlement releases USDC back to wallet.
5. Agent invokes `repay_credit(amount + interest)` once the cash-flow event
   lands (here: Principal top-up or downstream invoice).
6. Statement shows: task cost, credit-line draw, credit-line repay, net interest.

### 5d. Reconciliation & unified statement

- Every MPP receipt has `task_id` and a `rail` field (`visa` | `usdc_escrow` |
  `credit_line`).
- Every onchain event includes `task_id` (via escrow metadata).
- Reconciliation worker reads both streams, joins on `task_id`, materializes a
  view: per-task totals, per-rail subtotals, anomaly flags (intent without
  settlement, settlement without intent, double-charge).
- Dashboard exports CSV/PDF; principal sees a single human-readable statement.

---

## 6. MPP Simulation Contract

The simulator mirrors the **semantic surface** of Visa MPP so a real-SDK swap
is mechanical. We will not invent custom semantics where MPP has documented
ones.

### Credential shape (delegation token)

```jsonc
{
  // JWS-signed (Ed25519); shape modeled on W3C VC + MPP claims
  "iss": "mpp-sim://issuer/visa-poc",
  "sub": "agent:autocompute-prod-1",
  "aud": ["merchant:hyperscaler-mock", "merchant:dcomp-mock"],
  "iat": 1736899200,
  "exp": 1737504000,
  "principal": "ent:acme-corp",
  "scope": {
    "rails": ["visa_card", "usdc_escrow", "credit_line"],
    "caps": {
      "per_tx_usd": 250,
      "daily_usd": 1000,
      "weekly_usd": 5000
    },
    "allowlist": ["merchant:hyperscaler-mock", "merchant:dcomp-mock"],
    "hitl_threshold_usd": 200
  },
  "key_binding": "did:key:z6Mk..." // agent's signing pubkey
}
```

### Per-transaction intent receipt

Issued just-in-time before each spend:

```jsonc
{
  "iss": "mpp-sim://issuer/visa-poc",
  "sub": "agent:autocompute-prod-1",
  "credential_jti": "<delegation-id>",
  "task_id": "task_01J...",
  "rail": "usdc_escrow",
  "merchant": "merchant:dcomp-mock",
  "amount_ceiling_usd": 100,
  "expires_at": 1736902800,
  "intent_hash": "0x..." // hashed by smart contract on escrow open
}
```

### Settlement receipt

Countersigned after merchant returns final settlement payload. Stored in the
reconciliation ledger and surfaced on the dashboard.

### Swap-in seam

```
interface MppPort {
  issueDelegation(req: DelegationRequest): Promise<DelegationJwt>;
  issueIntent(req: IntentRequest): Promise<IntentReceipt>;
  countersignSettlement(req: SettlementRequest): Promise<SettlementReceipt>;
  verify(jwt: string): Promise<VerifyResult>;
}
```

The simulator and (future) Visa adapter both implement this port. Nothing
upstream knows which is wired in.

---

## 7. Onchain Components

Deployed to **Base Sepolia**. All paid in **USDC** (Circle's testnet USDC).

### `Escrow.sol`

- `openJob(provider, amount, intentHash, deadline)` — pulls USDC from caller,
  stores commitment to `intentHash`.
- `meter(jobId, progressBps)` — provider-callable; advisory; emits event.
- `settle(jobId, finalAmount, providerSig)` — releases `finalAmount` to
  provider, refund remainder to wallet. Validates `finalAmount ≤ amount` and
  provider signature over `(jobId, finalAmount)`.
- `refund(jobId)` — after `deadline`, anyone can refund unsettled escrow.

### `CreditLine.sol`

Minimal overcollateralized credit (USDC vs. USDC for PoC clarity; collateral
ratio just demonstrates the mechanics).

- `deposit(amount)` — Principal posts collateral.
- `borrow(amount)` — agent-controlled wallet borrows; checks LTV, mints debt.
- `repay(amount)` — debt accrues simple interest at fixed rate for PoC.
- `liquidate(account)` — anyone, when LTV crossed.

Both contracts emit events carrying `task_id` and `intent_hash` so the
reconciliation worker can join them to MPP receipts.

### Smart wallet + paymaster

The agent's signing key controls an ERC-4337 smart wallet. A paymaster
sponsors gas so the agent never holds ETH. The wallet's session keys can be
scoped to specific contracts (`Escrow.sol`, `CreditLine.sol`, `USDC.transfer`)
as a second line of defense alongside MPP scope.

---

## 8. Guardrails (Defense in Depth)

The agent's authority is bounded at **three independent layers**:

1. **MPP scope** — issuer-signed caps, allowlist, expiry. Verified on every
   intent issuance.
2. **Agent-loop guardrails** — pure functions checked before every tool call:
   per-tx, daily, weekly cumulative caps; provider allowlist; cooldowns
   between large spends; HITL prompt above `hitl_threshold_usd`.
3. **Smart-wallet session-key policy** — only specific contracts callable;
   per-call amount caps; circuit-breaker that pauses the wallet on anomaly
   patterns (rapid retries, novel callee, value > p99).

A failure at any layer halts the spend. Every halt is logged and surfaced on
the dashboard.

---

## 9. Pressure-Test Results & Mitigations

| Risk | Mitigation |
|---|---|
| Visa MPP SDK is gated | `MppPort` abstraction; simulator implements documented semantics; real-SDK adapter is a follow-up |
| Stablecoin UX kills demos | ERC-4337 smart wallet + paymaster; agent never sees gas |
| Undercollateralized agent credit is unrealistic at PoC scope | Overcollateralized `CreditLine.sol`; undercollateralized noted as v4 |
| Runaway-spend / agent compromise | Three-layer defense: MPP scope + agent-loop guardrails + smart-wallet session-key policy |
| Cross-rail reconciliation is the real enterprise pain | First-class Unified Statement, joined by `task_id`, with anomaly flags |
| Real decentralized compute providers need real wallets | Two mocks with realistic surfaces (`/quote /start /meter /settle`) |
| Per-second streaming payments are complex | Escrow + per-tick claim/refund, not continuous streams |
| Base Sepolia liquidity / latency | Self-deploy `CreditLine.sol` with seeded liquidity; cap timeouts; cache RPC reads |
| Cost overrun arrives faster than credit draw confirms | Agent pre-draws when projected cost crosses 80% of float; debt accrues only on borrowed balance |
| Regulatory ambiguity | Testnet only, US scope, no real cards/funds; called out in §10 |
| LLM nondeterminism in a payments loop | Structured outputs + tool calls only; all spend gated by deterministic guardrails; LLM cannot bypass `MppPort` |
| Provider can cheat on `/meter` reports | `/meter` is advisory; final `/settle` is bounded by escrow's `amount` ceiling; provider signature is verified onchain |
| Replay of intent receipts | `intent_hash` is single-use, consumed by `Escrow.openJob`; expiry enforced |

---

## 10. Scope & Non-Goals

**In scope (v1):**
- Two mock providers, one Visa-billed, one USDC-escrow
- MPP simulator with full delegation + intent + settlement surface
- Base Sepolia smart wallet, escrow, credit line
- Single-tenant Principal dashboard
- Unified Statement view

**Out of scope (v1):**
- Real Visa MPP SDK integration (v2)
- Real decentralized compute provider (v3)
- Undercollateralized credit (v4)
- Mainnet, real funds, real cards
- Multi-tenant / production auth
- Non-US jurisdictions

---

## 11. Roadmap

- **v1 (this PoC):** simulated MPP, mock providers, testnet contracts,
  end-to-end happy path + overrun + reconciliation.
- **v2:** swap `MppSimAdapter` for Visa MPP sandbox adapter behind `MppPort`.
- **v3:** integrate one real decentralized compute provider
  (e.g., Akash, io.net) on testnet/mainnet behind the same port.
- **v4:** replace `CreditLine.sol` with an undercollateralized agent-credit
  primitive (revenue-share, reputation-scored, or insurance-pool-backed).
- **v5:** multi-tenant Principal experience; org-level guardrails; SOC 2 prep.

---

## 12. Verification Plan

The PoC is "demo-correct" when the following end-to-end flow runs without
human intervention beyond initial provisioning:

1. `pnpm install && pnpm build`
2. `supabase start` + apply migrations
3. `forge script Deploy` against Base Sepolia; seed `CreditLine` liquidity
4. `pnpm dev` (Next.js app + mock providers)
5. Principal dashboard:
   - Provision an agent with $200 float, $1,000 daily cap, two-merchant allowlist
6. Submit task "render 60s 4K video":
   - Agent selects decentralized provider
   - Agent opens escrow, provider runs, meters
   - Job projected to exceed float → agent draws from credit line
   - Job settles; agent repays credit line
7. Verify:
   - Unified Statement shows one task, both escrow + credit-line activity
   - MPP intent and settlement receipts present and signature-valid
   - Onchain events on Base Sepolia explorer match ledger entries
   - No guardrail violations; no manual intervention

Automated tests (`pnpm test`, `forge test`) must also pass:
- Guardrail unit tests (cap arithmetic, allowlist, cooldown)
- `MppSimAdapter` produces JWTs that `verify()` accepts; expired/wrong-aud rejected
- `Escrow.sol` honors `amount` ceiling; replay rejected; refund after deadline works
- `CreditLine.sol` LTV enforced; interest math; liquidation path
- Reconciliation worker correctly joins intent + settlement + onchain events
- Agent integration test: simulated overrun triggers exactly one credit draw
