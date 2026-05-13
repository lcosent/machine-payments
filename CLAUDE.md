# CLAUDE.md

Guidance for Claude Code (Opus 4.7) and other Claude agents working on this
repository. Read this fully before your first edit. Read `design.md` next.

---

## Mission

This repo is a PoC: **AutoCompute**, an agent-to-agent compute marketplace
demonstrating Visa Machine Payment Protocol (MPP, simulated), USDC stablecoin
settlement on Base Sepolia, and onchain credit, working together in one flow.
See `design.md` for the full blueprint. Your job is to build toward the v1
verification plan in `design.md` §12 — nothing more, nothing less.

---

## Architecture Quick-Map

| Concern                                                    | Location                                 |
| ---------------------------------------------------------- | ---------------------------------------- |
| Web app + API routes (Principal dashboard, mock providers) | `apps/web/` (Next.js App Router)         |
| Compute Agent loop (tool use; `LlmPort` abstraction)       | `apps/agent/`                            |
| MPP simulator + `MppPort` adapter                          | `services/mpp-sim/`                      |
| Reconciliation worker + LedgerSink ports                   | `services/reconciler/`                   |
| Solidity contracts (`Escrow.sol`, `CreditLine.sol`)        | `contracts/` (Foundry)                   |
| Smart-wallet & onchain client helpers                      | `packages/onchain/`                      |
| Shared types (MPP claims, task DTOs, ledger rows)          | `packages/types/`                        |
| Supabase migrations                                        | `supabase/migrations/`                   |
| Offline MPP-only walkthrough                               | `scripts/demo.ts`                        |
| End-to-end runnable demo (tier 1/2/3 aware)                | `scripts/agent.ts` (`pnpm script:agent`) |
| Step-by-step setup                                         | `RUNBOOK.md`                             |

When you add a new component, also add a row here.

---

## Build / Test / Run

```bash
pnpm install                  # install workspaces
pnpm dev                      # Next.js app + mock providers
pnpm test                     # vitest across workspaces
pnpm typecheck                # tsc --noEmit
pnpm lint                     # eslint + prettier --check

supabase start                # local Postgres + studio
supabase migration up         # apply migrations

cd contracts && forge build   # compile contracts
cd contracts && forge test    # solidity tests
cd contracts && forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC --broadcast
```

The end-to-end demo lives at `scripts/demo.ts` and must pass before any PR is
merged.

---

## Conventions

- **TypeScript strict.** No `any`, no `as unknown as`. Use Zod or `valibot`
  at trust boundaries (HTTP, JWT, onchain reads).
- **No comments unless they explain the _why_.** Names should carry the _what_.
- **No `console.log` in production paths.** Use the shared logger
  (`packages/types/log.ts`). `console.log` is acceptable in `scripts/` only.
- **Secrets via env only.** Never commit `.env`. `.env.example` documents required vars.
- **Server actions / route handlers must validate input.** Trust nothing
  crossing the network or the LLM boundary.
- **Never mutate JWTs after issuance.** Re-issue instead.
- **All onchain calls go through `packages/onchain/`.** No raw `ethers`/`viem`
  imports in `apps/` or `services/`.
- **The agent (LLM) cannot bypass guardrails.** Guardrails are pure functions
  in `apps/agent/guardrails.ts`, called _before_ any tool fires. If a new tool
  spends money, it needs a guardrail check — no exceptions.

---

## Branch & Commit Policy

- Develop on branch **`claude/mpp-poc-design-GKca5`**. Never push to `main`.
- One logical change per commit. Commit messages: imperative mood, ≤72 chars
  for the subject; body explains _why_ if non-obvious.
- Never `--no-verify`. Never amend a published commit. Fix forward.
- Push only via `git push -u origin claude/mpp-poc-design-GKca5`. On network
  failure, retry up to 4× with exponential backoff (2s, 4s, 8s, 16s).
- Do **not** create a PR unless the user explicitly asks.

---

## Tool-Use Guidance (Opus 4.7)

- **Edit > Write** for existing files. Reserve `Write` for new files or full
  rewrites.
- **Plan mode** for any change touching the MPP port, the contracts, the
  agent loop, or the reconciliation worker. Trivial fixes can skip it.
- **Parallel `Explore` agents** when investigating cross-cutting questions
  (e.g., "how does intent_hash flow from MPP through escrow into the ledger?")
  — launch up to 3 in one message.
- **Supabase MCP** for all DB schema work:
  - `list_tables` before any change
  - `get_advisors` after any change
  - `apply_migration` writes go directly to the remote project — be careful
- **Vercel MCP** for deploy logs and build status when chasing a CI failure.
- **GitHub MCP** for _all_ GitHub interactions. There is no `gh` CLI in this
  sandbox.
- **`claude-api` skill**: invoke whenever you touch `apps/agent/` so prompt
  caching, tool-use patterns, and model selection stay current. The agent
  loop must cache the system prompt + tool definitions.
- **`LlmPort` abstraction** in `apps/agent/`: backend is chosen by the
  `LLM_BACKEND` env var (`anthropic` | `openai_compat`). The OpenAI-compatible
  port works with LM Studio (default base URL `http://localhost:1234/v1`),
  Ollama, vLLM, llama.cpp server, LocalAI, OpenRouter. The agent loop must
  go through `LlmPort` — no direct SDK calls from `loop.ts` or `handlers.ts`.
- **`security-review` skill** before any commit that touches contracts,
  signing keys, JWT issuance, or guardrails.
- **`simplify` skill** after finishing a feature, before opening a PR.

---

## File / Folder Conventions

- Use **kebab-case** for filenames, **PascalCase** for React components and
  Solidity contracts.
- One exported symbol per file in `packages/types/` where practical.
- Tests co-located: `foo.ts` ↔ `foo.test.ts`.
- Fixtures live in `tests/fixtures/`. Never call live testnet RPCs in unit
  tests — mock at the `packages/onchain/` boundary.

---

## Hard Don'ts

- **No mainnet RPCs.** Every onchain interaction targets Base Sepolia.
- **No real card numbers, no real PANs.** The Visa rail is mocked end-to-end.
- **No private keys in source.** Use env vars; document the var in `.env.example`.
- **No skipping pre-commit hooks.** If a hook fails, fix the root cause.
- **No bypassing `MppPort`.** All MPP interactions go through the port — no
  direct calls to the simulator from `apps/agent/`.
- **No bypassing guardrails.** New spend tool ⇒ new guardrail call ⇒ new test.
- **No background jobs without idempotency keys.** Reconciliation must be safe
  to re-run.
- **No `git push --force`** to a remote branch you share with the user.

---

## Debugging Playbook

- **Where are the logs?**
  - Next.js: terminal running `pnpm dev`; structured logs via shared logger.
  - Mock providers: same terminal, namespaced `[hyperscaler]`, `[dcomp]`.
  - Onchain events: Supabase table `onchain_events` (indexer worker) and Base
    Sepolia explorer.
- **Replay a task:** `pnpm script:replay --task <task_id>` reconstructs MPP
  receipts + onchain events from the ledger.
- **Inspect an MPP credential:** `pnpm script:inspect-jwt <jwt>` — verifies
  signature against current issuer keys and pretty-prints claims.
- **Query reconciliation ledger:** Supabase MCP → `execute_sql` against the
  `unified_statement` view, filtered by `task_id`.
- **Smart-wallet stuck:** check paymaster balance first; then session-key
  policy; then nonce.
- **LLM picked wrong tool / hallucinated:** check that the system prompt and
  tool descriptions are cached and current; check that guardrails refused
  loudly (they should never silently no-op).

---

## Definition of Done

Before declaring a feature complete:

- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] `pnpm test` passes, including any new unit/integration tests for this change
- [ ] `forge test` passes if contracts changed
- [ ] `scripts/demo.ts` end-to-end demo still runs
- [ ] `design.md` updated if architecture, ports, or scope shifted
- [ ] `CLAUDE.md` quick-map updated if a new component was added
- [ ] `.env.example` updated if a new env var was added
- [ ] `security-review` skill run if contracts/signing/guardrails touched

---

## When You Are Unsure

Ask the user via `AskUserQuestion`. Cheap to ask, expensive to guess wrong on
a payments system — even one running on testnet.
