import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { ulid } from 'ulidx';
import {
  FakeScriptedLlmPort,
  HttpProviderPort,
  InMemoryEscrowPort,
  OnchainCreditPort,
  OnchainEscrowPort,
  type CreditPort,
  type EscrowPort,
  type HandlerDeps,
  type LlmPort,
  type ScriptedTurn,
  makeInitialState,
  makeLlmFromEnv,
  runAgent,
} from '@autocompute/agent';
import {
  loadPrivyClient,
  makeEoaWallet,
  makePrivyWallet,
  readPrivyEnv,
  type Address,
  type AgentWallet,
  type Hex,
} from '@autocompute/onchain';
import { MppSimAdapter } from '@autocompute/mpp-sim';
import {
  InMemoryLedgerSink,
  SupabaseLedgerSink,
  reconcile,
  type LedgerSink,
} from '@autocompute/reconciler';
import { makeLogger, type DelegationScope, type MerchantId, type TaskId } from '@autocompute/types';

const log = makeLogger('script.agent');

const PRINCIPAL = 'ent:acme-corp' as const;
const AGENT = 'agent:autocompute-demo' as const;
const HYPERSCALER: MerchantId = 'merchant:hyperscaler-mock';
const DCOMP: MerchantId = 'merchant:dcomp-mock';

const SCOPE: DelegationScope = {
  rails: ['usdc_escrow', 'credit_line', 'visa_card'],
  caps: { per_tx_usd: 250, daily_usd: 1000, weekly_usd: 5000 },
  allowlist: [HYPERSCALER, DCOMP],
  hitl_threshold_usd: 200,
};

const env = process.env;
const DCOMP_BASE = env['DCOMP_BASE_URL'] ?? 'http://localhost:3000/api/providers/dcomp';
const HYPER_BASE = env['HYPERSCALER_BASE_URL'] ?? 'http://localhost:3000/api/providers/hyperscaler';
const TASK_DESC = env['TASK_DESCRIPTION'] ?? 'render 60s of 4K video, deadline 2h';
const BUDGET_USD = Number(env['TASK_BUDGET_USD'] ?? '200');

const synthTxHash = (): `0x${string}` => {
  // 32-byte hex matching a real Ethereum tx hash. ulid()+random for
  // uniqueness even when many calls land in the same millisecond.
  const a = ulid().toLowerCase();
  const b = Math.random().toString(36).slice(2);
  return `0x${(a + b)
    .padEnd(64, '0')
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, '0')}` as `0x${string}`;
};

const inMemoryCredit = (
  initialAvailableUsd = 500,
): CreditPort & {
  state(): { available_usd: number; principal_usd: number };
} => {
  let available = initialAvailableUsd;
  let principal = 0;
  return {
    async draw(amount_usd: number) {
      if (amount_usd > available) throw new Error('credit pool dry');
      available -= amount_usd;
      principal += amount_usd;
      return { onchain_tx_hash: synthTxHash() };
    },
    async repay(amount_usd: number) {
      const paid = Math.min(amount_usd, principal);
      principal -= paid;
      available += paid;
      return { onchain_tx_hash: synthTxHash() };
    },
    state() {
      return { available_usd: available, principal_usd: principal };
    },
  };
};

/// Canned tool-use plan the FakeScriptedLlmPort runs when no real LLM
/// backend is configured. Mirrors the design.md §5c overrun flow:
/// quote → pay dcomp → draw credit → settle → end.
///
/// Amounts are deliberately small (≤$5/leg) so the Tier 3 onchain demo
/// runs inside a ~20 USDC testnet faucet budget. The flow itself is
/// identical to a production-sized run; only the numerals scale.
const ESCROW_USD = 4;
const CREDIT_USD = 2;
const SETTLE_USD = 3.9; // ≤ ESCROW_USD; refunds 0.1 USDC to the agent
const REPAY_USD = CREDIT_USD;
const buildFakeScript = (taskId: TaskId): ReadonlyArray<ScriptedTurn> => [
  {
    text: 'Quoting providers.',
    tool_calls: [
      {
        name: 'quote_providers',
        input: {
          task_id: taskId,
          description: TASK_DESC,
          budget_ceiling_usd: BUDGET_USD,
        },
      },
    ],
  },
  {
    text: `Decentralized provider is cheaper and faster — opening $${ESCROW_USD} USDC escrow.`,
    tool_calls: [
      {
        name: 'pay_usdc_escrow',
        input: {
          task_id: taskId,
          merchant: DCOMP,
          amount_usd: ESCROW_USD,
          rationale: 'dcomp quoted within budget; faster than hyperscaler',
        },
      },
    ],
  },
  {
    text: `Projected cost rose mid-job. Drawing $${CREDIT_USD} from the credit line.`,
    tool_calls: [
      {
        name: 'draw_credit',
        input: {
          task_id: taskId,
          amount_usd: CREDIT_USD,
          rationale: `projected overrun beyond initial $${ESCROW_USD} ceiling`,
        },
      },
    ],
  },
  // Settle ≤ ESCROW_USD — Escrow.sol enforces final ≤ amount_ceiling.
  {
    text: 'Job complete. Countersigning settlement.',
    tool_calls: [
      {
        name: 'settle_task',
        input: {
          task_id: taskId,
          intent_jti: '__LAST_INTENT__', // resolved at dispatch time below
          final_amount_usd: SETTLE_USD,
          merchant_signature: '0xfake-merchant-sig',
        },
      },
    ],
  },
  {
    text: 'Repaying the credit-line draw.',
    tool_calls: [
      {
        name: 'repay_credit',
        input: { task_id: taskId, amount_usd: REPAY_USD },
      },
    ],
  },
  {
    text: 'Task settled. Statement closed.',
  },
];

const main = async () => {
  log.info('boot', {
    dcomp: DCOMP_BASE,
    hyperscaler: HYPER_BASE,
    task: TASK_DESC,
    budget_usd: BUDGET_USD,
  });

  const ledgerSink: LedgerSink = env['DATABASE_URL']
    ? (log.info('using SupabaseLedgerSink', {
        db: env['DATABASE_URL']!.replace(/:[^:@]+@/, ':***@'),
      }),
      new SupabaseLedgerSink({ databaseUrl: env['DATABASE_URL']! }))
    : new InMemoryLedgerSink();

  // Seed the agent row that mpp_receipts FK to. Task seed happens later once
  // its ulid is known. No-op for in-memory.
  if (env['DATABASE_URL']) {
    const sql = postgres(env['DATABASE_URL']!, { onnotice: () => {} });
    try {
      await sql`
        insert into public.agents (id, principal)
        values (${AGENT}, ${PRINCIPAL})
        on conflict (id) do nothing
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const mpp = new MppSimAdapter({
    issuerId: 'mpp-sim://demo/issuer',
    privateKeyPkcs8Pem: await exportPKCS8(privateKey),
    publicKeySpkiPem: await exportSPKI(publicKey),
    alg: 'EdDSA',
    ledgerSink,
  });

  const { jwt: delegationJwt, claims: delegation } = await mpp.issueDelegation({
    principal: PRINCIPAL,
    agent: AGENT,
    audience: [HYPERSCALER, DCOMP],
    scope: SCOPE,
    key_binding: 'did:key:z6Mkdemo',
    ttl_seconds: 3600,
  });
  log.info('delegation issued', { jti: delegation.jti });

  const providers = new HttpProviderPort({
    dcompBaseUrl: DCOMP_BASE,
    hyperscalerBaseUrl: HYPER_BASE,
  });
  // Onchain swap-in. We need: deployed contracts, an RPC, USDC address, AND
  // some way to source a signer. Two signer paths are supported:
  //   (a) AGENT_PRIVATE_KEY  — a raw hex private key (simplest; you hold it).
  //   (b) Privy server wallet — set PRIVY_APP_ID + PRIVY_APP_SECRET +
  //       PRIVY_WALLET_ID + PRIVY_WALLET_ADDRESS. Mint the wallet first via
  //       `pnpm script:provision-wallet`, then fund the printed address with
  //       Base Sepolia ETH + USDC. Privy custodies the key; we just sign.
  const privyCfg = readPrivyEnv(env);
  const hasPrivyWallet = !!privyCfg && !!env['PRIVY_WALLET_ID'] && !!env['PRIVY_WALLET_ADDRESS'];
  const hasEoaKey = !!env['AGENT_PRIVATE_KEY'];
  const wantOnchain =
    env['ESCROW_ADDRESS'] &&
    env['CREDIT_LINE_ADDRESS'] &&
    env['BASE_SEPOLIA_RPC'] &&
    env['USDC_ADDRESS'] &&
    (hasEoaKey || hasPrivyWallet);

  let credit: CreditPort & { state?(): { available_usd: number; principal_usd: number } };
  let escrow: EscrowPort;

  if (wantOnchain) {
    let wallet: AgentWallet;
    if (hasPrivyWallet) {
      log.info('using Privy server wallet', {
        wallet_id: env['PRIVY_WALLET_ID'],
        address: env['PRIVY_WALLET_ADDRESS'],
      });
      const { accountFactory } = await loadPrivyClient(privyCfg!);
      wallet = await makePrivyWallet({
        rpcUrl: env['BASE_SEPOLIA_RPC']!,
        walletId: env['PRIVY_WALLET_ID']!,
        address: env['PRIVY_WALLET_ADDRESS']! as Address,
        accountFactory,
      });
    } else {
      wallet = makeEoaWallet(env['AGENT_PRIVATE_KEY'] as Hex, env['BASE_SEPOLIA_RPC']!);
    }
    log.info('using onchain ports', {
      escrow: env['ESCROW_ADDRESS'],
      creditLine: env['CREDIT_LINE_ADDRESS'],
      agent_address: wallet.address,
    });
    credit = new OnchainCreditPort({
      wallet,
      usdc: env['USDC_ADDRESS']! as Address,
      creditLine: env['CREDIT_LINE_ADDRESS']! as Address,
    });
    escrow = new OnchainEscrowPort({
      wallet,
      usdc: env['USDC_ADDRESS']! as Address,
      escrow: env['ESCROW_ADDRESS']! as Address,
      ledgerSink,
    });
  } else {
    credit = inMemoryCredit(500);
    escrow = new InMemoryEscrowPort({ ledgerSink });
  }

  const taskId = `task_${ulid()}` as TaskId;
  const task = {
    task_id: taskId,
    description: TASK_DESC,
    budget_ceiling_usd: BUDGET_USD,
    deadline_iso: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  };

  // Seed the task row mpp_receipts.task_id FKs to (agent row was seeded
  // earlier, before delegation issuance).
  if (env['DATABASE_URL']) {
    const sql = postgres(env['DATABASE_URL']!, { onnotice: () => {} });
    try {
      await sql`
        insert into public.tasks (id, agent_id, description, budget_ceiling_usd, deadline)
        values (${taskId}, ${AGENT}, ${task.description}, ${task.budget_ceiling_usd}, ${task.deadline_iso})
        on conflict (id) do nothing
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  let llm: LlmPort;
  const backend = env['LLM_BACKEND'];
  if (!backend) {
    log.info('no LLM_BACKEND set — running scripted fallback plan');
    llm = wrapWithIntentResolution(new FakeScriptedLlmPort({ script: buildFakeScript(taskId) }));
  } else {
    try {
      llm = makeLlmFromEnv();
    } catch (e) {
      log.error(
        'unable to build LLM port from env — falling back to scripted demo. Set LLM_BACKEND + API key to use a real model.',
        { err: (e as Error).message },
      );
      llm = wrapWithIntentResolution(new FakeScriptedLlmPort({ script: buildFakeScript(taskId) }));
    }
  }
  log.info('llm', { backend: llm.name, model: llm.model });

  const deps: HandlerDeps = {
    agent: AGENT,
    scope: SCOPE,
    delegationJwt,
    mpp,
    providers,
    credit,
    escrow,
    now: () => Math.floor(Date.now() / 1000),
    logger: log.child('agent'),
    cooldown_seconds_between_large_spends: 60,
    large_spend_threshold_usd: 150,
    ledgerSink,
    ...(wantOnchain ? { escrowAddress: env['ESCROW_ADDRESS']! as `0x${string}` } : {}),
  };

  const state = makeInitialState();
  log.info('task submitted', task);

  const result = await runAgent(llm, deps, state, task);

  log.info('agent finished', {
    iterations: result.iterations,
    stop_reason: result.stop_reason,
    tokens: {
      input: result.total_input_tokens,
      output: result.total_output_tokens,
      cache_read: result.total_cache_read_tokens,
      cache_create: result.total_cache_creation_tokens,
    },
    spends: state.history.length,
    open_intents: state.open_intents.size,
    credit:
      typeof credit.state === 'function'
        ? credit.state()
        : 'onchain (state not tracked in-process)',
  });

  if (state.history.length > 0) {
    log.info('spend history', {
      entries: state.history.map((h) => ({
        merchant: h.merchant,
        amount_usd: h.amount_usd,
        at: new Date(h.at_unix_sec * 1000).toISOString(),
      })),
      total_spent_usd: state.history.reduce((acc, h) => acc + h.amount_usd, 0),
    });
  }

  const snapshot = await ledgerSink.snapshot();
  log.info('ledger snapshot', {
    mpp_receipts: snapshot.mpp_receipts.length,
    onchain_events: snapshot.onchain_events.length,
    card_charges: snapshot.card_charges.length,
  });

  const out = reconcile(snapshot);
  log.info('unified statement (reconciled)', {
    rows: out.statement,
    anomalies: out.anomalies,
  });
};

/// The scripted plan references `__LAST_INTENT__` as a placeholder for the
/// settle_task input. This shim rewrites that placeholder using the most
/// recent intent_jti the harness has seen come back as a tool_result, so
/// the scripted demo doesn't need to know the random jti up front.
const wrapWithIntentResolution = (inner: LlmPort): LlmPort => {
  let lastIntentJti: string | null = null;
  return {
    name: inner.name,
    model: inner.model,
    async turn(req) {
      // Scan the latest user tool_results for an intent_jti to remember.
      for (let i = req.messages.length - 1; i >= 0; i--) {
        const m = req.messages[i];
        if (!m || m.role !== 'user' || m.kind !== 'tool_results') continue;
        for (const r of m.results) {
          try {
            const parsed = JSON.parse(r.content) as { intent_jti?: string };
            if (parsed.intent_jti) {
              lastIntentJti = parsed.intent_jti;
              break;
            }
          } catch {
            /* ignore */
          }
        }
        if (lastIntentJti) break;
      }
      const resp = await inner.turn(req);
      if (!lastIntentJti) return resp;
      const rewritten = resp.tool_calls.map((tc) => {
        if (
          tc.name === 'settle_task' &&
          typeof tc.input === 'object' &&
          tc.input !== null &&
          (tc.input as Record<string, unknown>)['intent_jti'] === '__LAST_INTENT__'
        ) {
          return {
            ...tc,
            input: { ...(tc.input as Record<string, unknown>), intent_jti: lastIntentJti },
          };
        }
        return tc;
      });
      return { ...resp, tool_calls: rewritten };
    },
  };
};

main().catch((e) => {
  log.error('script:agent failed', { err: (e as Error).message, stack: (e as Error).stack });
  process.exit(1);
});
