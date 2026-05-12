# AutoCompute Runbook

Step-by-step demo guide for the three tiers. Tier 1 is the **must-run**
quickstart. Tiers 2 and 3 layer on top and don't change the agent code —
they're enabled by env vars.

---

## Prerequisites

```bash
# Node 22+, pnpm 10
corepack enable
corepack prepare pnpm@10 --activate

pnpm install
pnpm typecheck    # tsc -b
pnpm test         # 77 tests
pnpm lint
pnpm demo         # 30s offline walkthrough — confirms MPP + guardrails
```

If `pnpm demo` passes, every tier below will work.

---

## Tier 1 — runnable agent + mock providers (≈30s)

The agent loop runs against the Next.js mock providers. No DB, no chain.
Pick an LLM backend or run the scripted fallback.

### Option A: scripted fallback (no API key needed)

```bash
# Terminal 1
pnpm dev                          # boots Next.js on :3000

# Terminal 2
pnpm script:agent                 # uses FakeScriptedLlmPort
```

What you should see at the end:

```json
{"msg":"ledger snapshot","fields":{"mpp_receipts":3,"onchain_events":4,"card_charges":0}}
{"msg":"unified statement (reconciled)","fields":{"rows":[
  {"rail":"credit_line","credit_drawn_usd":50,"credit_repaid_usd":50,...},
  {"rail":"usdc_escrow","mpp_settled_usd":78,"escrow_settled_usd":78,...}
],"anomalies":[]}}
```

### Option B: real Claude

```bash
# .env
LLM_BACKEND=anthropic
ANTHROPIC_API_KEY=sk-ant-...
# ANTHROPIC_MODEL=claude-sonnet-4-6   # optional

pnpm dev                          # Terminal 1
pnpm script:agent                 # Terminal 2
```

### Option C: local LLM via LM Studio (or Ollama / vLLM / llama.cpp)

1. In LM Studio: load a tool-capable model (Qwen 2.5 Coder 32B, Llama 3.3 70B, Mistral 8x22B). Small models tool-call poorly.
2. Developer → Start Server (default port 1234).
3. Configure env:

```bash
LLM_BACKEND=openai_compat
OPENAI_COMPAT_BASE_URL=http://localhost:1234/v1
OPENAI_COMPAT_MODEL=qwen2.5-coder-32b-instruct   # match LM Studio
# OPENAI_COMPAT_API_KEY=                          # not required for LM Studio

pnpm dev                          # Terminal 1
pnpm script:agent                 # Terminal 2
```

---

## Tier 2 — Supabase ledger + reconciled `unified_statement`

Persists every MPP receipt, onchain event, and card charge to Postgres
so the reconciler runs against a real database.

```bash
# Install Supabase CLI once
brew install supabase/tap/supabase     # mac
# or: see https://supabase.com/docs/guides/cli for linux/windows

# One-time
supabase start                          # local Postgres + Studio
supabase db reset                       # applies supabase/migrations/0001_init.sql

# Add to .env
DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres

# Run the agent — now writes to Postgres
pnpm dev                                # Terminal 1
pnpm script:agent                       # Terminal 2
```

Inspect what the agent wrote:

```bash
# Open http://localhost:54323 (Supabase Studio) and query
#   select * from mpp_receipts;
#   select * from onchain_events;
#   select * from unified_statement;
# or via psql
psql "$DATABASE_URL" -c 'select * from unified_statement;'
```

The reconciled rows printed at the end of `pnpm script:agent` match the
`unified_statement` view exactly — the in-process `reconcile()` is the
TS twin of the SQL view.

---

## Tier 3 — Base Sepolia smart contracts

Replaces the in-memory `EscrowPort` and `CreditPort` with viem-backed
implementations that hit deployed `Escrow.sol` and `CreditLine.sol` on
Base Sepolia.

### 1. Install Foundry

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

### 2. Fund a testnet wallet

You need a wallet with:

- Sepolia ETH on Base Sepolia for gas (~0.05 ETH)
- Base Sepolia USDC for the credit pool seed + the agent's float (10–100 USDC)

Faucets:

- Base Sepolia ETH: https://docs.base.org/docs/tools/network-faucets
- Base Sepolia USDC: https://faucet.circle.com

### 3. Deploy

```bash
export BASE_SEPOLIA_RPC=https://sepolia.base.org
export DEPLOYER_PRIVATE_KEY=0x...           # holds the testnet ETH + USDC
export USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
export CREDIT_LINE_SEED_USDC6=10000000      # 10 USDC into the pool

./scripts/deploy.sh
# Copy printed ESCROW_ADDRESS and CREDIT_LINE_ADDRESS into .env
```

### 4. Provision the agent wallet

Pick one of the two signer options.

**Option A: raw private key (you hold it)**

```bash
# .env
AGENT_PRIVATE_KEY=0x...   # your testnet key; needs ETH for gas + USDC
```

**Option B: Privy server wallet (recommended — Privy custodies the key)**

1. Sign up at https://dashboard.privy.io and create an app.
2. Add the credentials to `.env`:

   ```bash
   PRIVY_APP_ID=...
   PRIVY_APP_SECRET=...
   ```

3. Mint a wallet:

   ```bash
   pnpm script:provision-wallet
   ```

   The script writes `PRIVY_WALLET_ID` + `PRIVY_WALLET_ADDRESS` back into
   `.env` automatically and prints the address.

4. Fund the printed address with Base Sepolia ETH + USDC. Whichever faucet
   route you choose is fine — the wallet is now a regular EOA on Base
   Sepolia, controlled by Privy.

### 5. Run the agent against the deployed contracts

Add to `.env`:

```bash
BASE_SEPOLIA_RPC=https://sepolia.base.org
USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
ESCROW_ADDRESS=0x...     # from deploy
CREDIT_LINE_ADDRESS=0x... # from deploy
```

When the address vars + a signer (A or B) are present, `scripts/agent.ts`
swaps in `OnchainEscrowPort` + `OnchainCreditPort` automatically. On
boot you'll see either `using Privy server wallet` (option B) or just
`using onchain ports` (option A).

```bash
pnpm dev                  # Terminal 1
pnpm script:agent         # Terminal 2 — now broadcasts real txs
```

Verify on Base Sepolia explorer:

- https://sepolia.basescan.org/address/$ESCROW_ADDRESS — should show `JobOpened` + `JobSettled` events
- https://sepolia.basescan.org/address/$CREDIT_LINE_ADDRESS — `Borrowed` + `Repaid`

---

## What `pnpm script:agent` does, end-to-end

1. Generates an ephemeral Ed25519 keypair (or use `MPP_ISSUER_PRIVATE_KEY` for stability)
2. MppSimAdapter issues a delegation JWT scoped to the configured caps + allowlist; row hits the ledger sink
3. Builds the LLM port (Anthropic / OpenAI-compat / scripted fallback)
4. Builds the EscrowPort (in-memory by default, onchain if env says so)
5. Builds the CreditPort (in-memory by default, onchain if env says so)
6. Builds the LedgerSink (in-memory by default, Supabase if `DATABASE_URL` set)
7. Runs `runAgent(...)` — agent picks providers, opens escrow, draws credit, settles
8. Snapshots the ledger, runs `reconcile()`, prints the unified statement
9. Anomalies (intent without settlement, amount mismatch, etc.) surface in the same printout

---

## Troubleshooting

**`script:agent` prints `unable to build LLM port`.** You set `LLM_BACKEND` but didn't set the right backend env. Either fill in the API key/model or `unset LLM_BACKEND` for the scripted fallback.

**Connection refused on `localhost:3000`.** `pnpm dev` isn't running in another shell.

**Supabase `psql: connection to server failed`.** Run `supabase status` to confirm the container's up; check that port 54322 isn't taken.

**`forge build` fails with `cannot find package "forge-std"`.** Run `cd contracts && forge install --no-git foundry-rs/forge-std && forge install --no-git OpenZeppelin/openzeppelin-contracts@v5.1.0`. `scripts/deploy.sh` does this automatically the first time.

**Agent runs but `credit_drawn_usd: 0`.** Likely a ULID-millisecond collision in an old in-memory CreditPort; the current `synthTxHash()` adds entropy. Pull latest and re-run.

**Anthropic 401.** Key is wrong or expired. Test with `curl https://api.anthropic.com/v1/models -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"`.

**LM Studio tool calls malformed / agent hits MAX_ITERATIONS.** Your local model isn't tool-call competent. Try a stronger model (Qwen 2.5 72B, Llama 3.3 70B) or switch to Anthropic.

---

## File map

| Concern            | Where                                                                     |
| ------------------ | ------------------------------------------------------------------------- |
| End-to-end script  | `scripts/agent.ts`                                                        |
| Mock providers     | `apps/web/src/app/api/providers/...`                                      |
| Agent loop + ports | `apps/agent/src/{loop,handlers,*-port,*-sink}.ts`                         |
| MPP simulator      | `services/mpp-sim/`                                                       |
| Reconciler + sinks | `services/reconciler/src/{reconcile,ledger-sink,supabase-ledger-sink}.ts` |
| SQL schema         | `supabase/migrations/0001_init.sql`                                       |
| Solidity           | `contracts/src/{Escrow,CreditLine}.sol`                                   |
| Deploy wrapper     | `scripts/deploy.sh`                                                       |
