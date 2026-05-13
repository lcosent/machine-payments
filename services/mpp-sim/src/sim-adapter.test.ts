import { describe, expect, it, beforeAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { ulid } from 'ulidx';
import type { MerchantId } from '@autocompute/types';
import { MppSimAdapter } from './sim-adapter.js';

const ISSUER_ID = 'mpp-sim://test/issuer';
const PRINCIPAL = 'ent:acme-corp' as const;
const AGENT = 'agent:autocompute-test' as const;
const HYPERSCALER: MerchantId = 'merchant:hyperscaler-mock';
const DCOMP: MerchantId = 'merchant:dcomp-mock';

const ulidTaskId = () => `task_${ulid()}` as const;
const intentHash = (s: string): `0x${string}` =>
  `0x${createHash('sha256').update(s).digest('hex')}`;
const _randomHex32 = (): `0x${string}` => `0x${randomBytes(32).toString('hex')}`;

let adapter: MppSimAdapter;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const privateKeyPkcs8Pem = await exportPKCS8(privateKey);
  const publicKeySpkiPem = await exportSPKI(publicKey);
  adapter = new MppSimAdapter({
    issuerId: ISSUER_ID,
    privateKeyPkcs8Pem,
    publicKeySpkiPem,
    alg: 'EdDSA',
  });
});

const baseScope = {
  rails: ['usdc_escrow' as const, 'credit_line' as const, 'visa_card' as const],
  caps: { per_tx_usd: 250, daily_usd: 1000, weekly_usd: 5000 },
  allowlist: [HYPERSCALER, DCOMP],
  hitl_threshold_usd: 200,
};

describe('MppSimAdapter', () => {
  it('issues a delegation that verifies for an in-audience merchant', async () => {
    const { jwt, claims } = await adapter.issueDelegation({
      principal: PRINCIPAL,
      agent: AGENT,
      audience: [HYPERSCALER, DCOMP],
      scope: baseScope,
      key_binding: 'did:key:z6Mktest',
      ttl_seconds: 3600,
    });
    expect(claims.sub).toBe(AGENT);
    const verified = await adapter.verifyDelegation(jwt, DCOMP);
    expect(verified.ok).toBe(true);
  });

  it('rejects delegation for an out-of-audience merchant', async () => {
    const { jwt } = await adapter.issueDelegation({
      principal: PRINCIPAL,
      agent: AGENT,
      audience: [HYPERSCALER],
      scope: baseScope,
      key_binding: 'did:key:z6Mktest',
      ttl_seconds: 3600,
    });
    const verified = await adapter.verifyDelegation(jwt, DCOMP);
    expect(verified).toEqual({ ok: false, reason: 'wrong_audience' });
  });

  it('refuses to issue intent if delegation does not cover merchant', async () => {
    const { jwt: delegationJwt } = await adapter.issueDelegation({
      principal: PRINCIPAL,
      agent: AGENT,
      audience: [HYPERSCALER],
      scope: baseScope,
      key_binding: 'did:key:z6Mktest',
      ttl_seconds: 3600,
    });
    await expect(
      adapter.issueIntent({
        delegation_jwt: delegationJwt,
        task_id: ulidTaskId(),
        rail: 'usdc_escrow',
        merchant: DCOMP,
        amount_ceiling_usd: 80,
        intent_hash: intentHash('job-1'),
        ttl_seconds: 600,
      }),
    ).rejects.toThrow(/wrong_audience/);
  });

  it('round-trips intent: issue → verify', async () => {
    const { jwt: delegationJwt } = await adapter.issueDelegation({
      principal: PRINCIPAL,
      agent: AGENT,
      audience: [DCOMP],
      scope: baseScope,
      key_binding: 'did:key:z6Mktest',
      ttl_seconds: 3600,
    });
    const { jwt: intentJwt, claims } = await adapter.issueIntent({
      delegation_jwt: delegationJwt,
      task_id: ulidTaskId(),
      rail: 'usdc_escrow',
      merchant: DCOMP,
      amount_ceiling_usd: 80,
      intent_hash: intentHash('job-2'),
      ttl_seconds: 600,
    });
    const verified = await adapter.verifyIntent(intentJwt);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.amount_ceiling_usd).toBe(80);
      expect(verified.claims.task_id).toBe(claims.task_id);
    }
  });

  it('refuses to countersign settlement above the intent ceiling', async () => {
    const { jwt: delegationJwt } = await adapter.issueDelegation({
      principal: PRINCIPAL,
      agent: AGENT,
      audience: [DCOMP],
      scope: baseScope,
      key_binding: 'did:key:z6Mktest',
      ttl_seconds: 3600,
    });
    const { jwt: intentJwt } = await adapter.issueIntent({
      delegation_jwt: delegationJwt,
      task_id: ulidTaskId(),
      rail: 'usdc_escrow',
      merchant: DCOMP,
      amount_ceiling_usd: 80,
      intent_hash: intentHash('job-3'),
      ttl_seconds: 600,
    });
    await expect(
      adapter.countersignSettlement({
        intent_jwt: intentJwt,
        final_amount_usd: 81,
        merchant_signature: '0xdeadbeef',
      }),
    ).rejects.toThrow(/exceeds ceiling/);
  });

  it('countersigns a within-ceiling settlement and verifies it', async () => {
    const { jwt: delegationJwt } = await adapter.issueDelegation({
      principal: PRINCIPAL,
      agent: AGENT,
      audience: [DCOMP],
      scope: baseScope,
      key_binding: 'did:key:z6Mktest',
      ttl_seconds: 3600,
    });
    const { jwt: intentJwt } = await adapter.issueIntent({
      delegation_jwt: delegationJwt,
      task_id: ulidTaskId(),
      rail: 'usdc_escrow',
      merchant: DCOMP,
      amount_ceiling_usd: 80,
      intent_hash: intentHash('job-4'),
      ttl_seconds: 600,
    });
    const { jwt: settlementJwt, claims } = await adapter.countersignSettlement({
      intent_jwt: intentJwt,
      final_amount_usd: 78,
      merchant_signature: '0xdeadbeef',
    });
    const verified = await adapter.verifySettlement(settlementJwt);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.final_amount_usd).toBe(78);
      expect(verified.claims.intent_jti).toBe(claims.intent_jti);
    }
  });

  it('marks an expired delegation as expired', async () => {
    let nowSec = 1_700_000_000;
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const a = new MppSimAdapter({
      issuerId: ISSUER_ID,
      privateKeyPkcs8Pem: await exportPKCS8(privateKey),
      publicKeySpkiPem: await exportSPKI(publicKey),
      alg: 'EdDSA',
      now: () => nowSec,
    });
    const { jwt } = await a.issueDelegation({
      principal: PRINCIPAL,
      agent: AGENT,
      audience: [DCOMP],
      scope: baseScope,
      key_binding: 'did:key:z6Mktest',
      ttl_seconds: 60,
    });
    nowSec += 120;
    const verified = await a.verifyDelegation(jwt, DCOMP);
    expect(verified).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a JWT signed by a different issuer key', async () => {
    const other = await generateKeyPair('EdDSA', { extractable: true });
    const otherAdapter = new MppSimAdapter({
      issuerId: ISSUER_ID,
      privateKeyPkcs8Pem: await exportPKCS8(other.privateKey),
      publicKeySpkiPem: await exportSPKI(other.publicKey),
      alg: 'EdDSA',
    });
    const { jwt } = await otherAdapter.issueDelegation({
      principal: PRINCIPAL,
      agent: AGENT,
      audience: [DCOMP],
      scope: baseScope,
      key_binding: 'did:key:z6Mktest',
      ttl_seconds: 3600,
    });
    const verified = await adapter.verifyDelegation(jwt, DCOMP);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('bad_signature');
  });
});
