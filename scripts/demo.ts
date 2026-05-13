import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { ulid } from 'ulidx';
import { keccak256, stringToHex } from 'viem';
import { MppSimAdapter } from '@autocompute/mpp-sim';
import { checkSpend } from '@autocompute/agent';
import { computeIntentHash } from '@autocompute/onchain';
import { makeLogger, type DelegationScope, type MerchantId, type TaskId } from '@autocompute/types';

const log = makeLogger('demo');

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

const main = async () => {
  log.info('boot: generating ephemeral MPP issuer keypair');
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const adapter = new MppSimAdapter({
    issuerId: 'mpp-sim://demo/issuer',
    privateKeyPkcs8Pem: await exportPKCS8(privateKey),
    publicKeySpkiPem: await exportSPKI(publicKey),
    alg: 'EdDSA',
  });

  log.info('step 1: principal provisions agent', { principal: PRINCIPAL, agent: AGENT });
  const { jwt: delegationJwt, claims: delegation } = await adapter.issueDelegation({
    principal: PRINCIPAL,
    agent: AGENT,
    audience: [HYPERSCALER, DCOMP],
    scope: SCOPE,
    key_binding: 'did:key:z6Mkdemo',
    ttl_seconds: 3600,
  });
  log.info('delegation issued', { jti: delegation.jti, exp: delegation.exp });

  const taskId = `task_${ulid()}` as TaskId;
  log.info('step 2: task arrives', {
    task_id: taskId,
    description: 'render 60s of 4K video',
    deadline_min: 120,
  });

  const initialEstimateUsd = 80;
  const merchant = DCOMP;
  log.info('step 3: agent picks provider', { merchant, estimate_usd: initialEstimateUsd });

  const now = Math.floor(Date.now() / 1000);
  const history: never[] = [];
  const decision = checkSpend(
    {
      task_id: taskId,
      merchant,
      rail: 'usdc_escrow',
      amount_usd: initialEstimateUsd,
      at_unix_sec: now,
    },
    {
      scope: SCOPE,
      history,
      now_unix_sec: now,
      cooldown_seconds_between_large_spends: 60,
      large_spend_threshold_usd: 150,
    },
  );
  if (!decision.allow) {
    log.error('guardrail blocked initial spend', { reason: decision.reason });
    process.exit(1);
  }
  log.info('guardrail allowed', { requires_hitl: decision.requires_hitl });

  const intentHash = computeIntentHash({
    agent_id: AGENT,
    task_id: taskId,
    merchant,
    amount_ceiling_usdc6: BigInt(initialEstimateUsd) * 1_000_000n,
    expires_at_unix_sec: now + 600,
    nonce: ulid(),
  });
  const { jwt: intentJwt, claims: intent } = await adapter.issueIntent({
    delegation_jwt: delegationJwt,
    task_id: taskId,
    rail: 'usdc_escrow',
    merchant,
    amount_ceiling_usd: initialEstimateUsd,
    intent_hash: intentHash,
    ttl_seconds: 600,
  });
  log.info('step 4: MPP intent receipt issued', {
    jti: intent.jti,
    amount_ceiling_usd: intent.amount_ceiling_usd,
    intent_hash: intent.intent_hash,
  });

  log.info('step 5: would call Escrow.openJob via smart wallet (skipped in offline demo)', {
    onchain: 'requires BASE_SEPOLIA_RPC and deployed contracts',
    intentHash,
    taskIdBytes32: keccak256(stringToHex(taskId)),
  });

  // Simulated cost overrun mid-job: projected total balloons to $128.
  log.info('step 6: meter tick reports projected_total_usd=128 (overrun)');
  const overrunEstimateUsd = 50;
  const overrunDecision = checkSpend(
    {
      task_id: taskId,
      merchant,
      rail: 'credit_line',
      amount_usd: overrunEstimateUsd,
      at_unix_sec: now,
    },
    {
      scope: SCOPE,
      history: [{ amount_usd: initialEstimateUsd, at_unix_sec: now, merchant }],
      now_unix_sec: now,
      cooldown_seconds_between_large_spends: 60,
      large_spend_threshold_usd: 150,
    },
  );
  if (!overrunDecision.allow) {
    log.error('guardrail refused credit draw', { reason: overrunDecision.reason });
    process.exit(1);
  }
  log.info('step 7: would draw $50 from CreditLine via smart wallet (skipped offline)');

  // The credit-funded escrow topup requires its own intent receipt, separate
  // from the original. Two intents → two settlements → one task in the ledger.
  const topupIntentHash = computeIntentHash({
    agent_id: AGENT,
    task_id: taskId,
    merchant,
    amount_ceiling_usdc6: BigInt(overrunEstimateUsd) * 1_000_000n,
    expires_at_unix_sec: now + 600,
    nonce: ulid(),
  });
  const { jwt: topupIntentJwt, claims: topupIntent } = await adapter.issueIntent({
    delegation_jwt: delegationJwt,
    task_id: taskId,
    rail: 'usdc_escrow',
    merchant,
    amount_ceiling_usd: overrunEstimateUsd,
    intent_hash: topupIntentHash,
    ttl_seconds: 600,
  });
  log.info('step 7b: second MPP intent issued for escrow topup', {
    jti: topupIntent.jti,
    amount_ceiling_usd: topupIntent.amount_ceiling_usd,
  });

  // Final settlement: $80 against the first intent, $48 against the topup.
  const { jwt: settlementJwt, claims: settlement } = await adapter.countersignSettlement({
    intent_jwt: intentJwt,
    final_amount_usd: 80,
    merchant_signature: '0xdemo-merchant-sig-a',
  });
  const { jwt: topupSettlementJwt, claims: topupSettlement } = await adapter.countersignSettlement({
    intent_jwt: topupIntentJwt,
    final_amount_usd: 48,
    merchant_signature: '0xdemo-merchant-sig-b',
  });
  log.info('step 8: settlements countersigned', {
    primary: { intent_jti: settlement.intent_jti, final_amount_usd: settlement.final_amount_usd },
    topup: {
      intent_jti: topupSettlement.intent_jti,
      final_amount_usd: topupSettlement.final_amount_usd,
    },
    task_total_usd: settlement.final_amount_usd + topupSettlement.final_amount_usd,
  });

  // Verify the entire chain end-to-end.
  const dCheck = await adapter.verifyDelegation(delegationJwt, merchant);
  const iCheck = await adapter.verifyIntent(intentJwt);
  const iTopupCheck = await adapter.verifyIntent(topupIntentJwt);
  const sCheck = await adapter.verifySettlement(settlementJwt);
  const sTopupCheck = await adapter.verifySettlement(topupSettlementJwt);
  log.info('verify: delegation', { ok: dCheck.ok });
  log.info('verify: intent (primary)', { ok: iCheck.ok });
  log.info('verify: intent (topup)', { ok: iTopupCheck.ok });
  log.info('verify: settlement (primary)', { ok: sCheck.ok });
  log.info('verify: settlement (topup)', { ok: sTopupCheck.ok });

  log.info('demo: end-to-end flow exercised in-memory');
  log.info(
    'note: §12 verification plan also requires forge-deployed contracts + Supabase ledger to fully validate',
  );
};

main().catch((e) => {
  log.error('demo failed', { err: (e as Error).message });
  process.exit(1);
});
