import { SignJWT, jwtVerify, importPKCS8, importSPKI, type KeyLike } from 'jose';
import { ulid } from 'ulidx';
import {
  DelegationClaimsSchema,
  IntentReceiptClaimsSchema,
  SettlementReceiptClaimsSchema,
  asJwt,
  type DelegationClaims,
  type IntentReceiptClaims,
  type Jwt,
  type MerchantId,
  type SettlementReceiptClaims,
} from '@autocompute/types';
import type {
  DelegationRequest,
  IntentRequest,
  MppPort,
  SettlementRequest,
  VerifyFailReason,
  VerifyResult,
} from './port.js';

export interface SimAdapterConfig {
  issuerId: string;
  privateKeyPkcs8Pem: string;
  publicKeySpkiPem: string;
  alg: 'EdDSA';
  now?: () => number;
}

export class MppSimAdapter implements MppPort {
  private readonly issuerId: string;
  private readonly privateKeyPromise: Promise<KeyLike>;
  private readonly publicKeyPromise: Promise<KeyLike>;
  private readonly alg: 'EdDSA';
  private readonly now: () => number;

  constructor(cfg: SimAdapterConfig) {
    this.issuerId = cfg.issuerId;
    this.alg = cfg.alg;
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
    this.privateKeyPromise = importPKCS8(cfg.privateKeyPkcs8Pem, cfg.alg);
    this.publicKeyPromise = importSPKI(cfg.publicKeySpkiPem, cfg.alg);
  }

  async issueDelegation(req: DelegationRequest): ReturnType<MppPort['issueDelegation']> {
    const now = this.now();
    const claims: DelegationClaims = {
      iss: this.issuerId,
      sub: req.agent,
      aud: [...req.audience],
      iat: now,
      exp: now + req.ttl_seconds,
      jti: ulid(),
      principal: req.principal,
      scope: req.scope,
      key_binding: req.key_binding,
    };
    const parsed = DelegationClaimsSchema.parse(claims);
    const jwt = await this.sign(parsed);
    return { jwt, claims: parsed };
  }

  async issueIntent(req: IntentRequest): ReturnType<MppPort['issueIntent']> {
    const delegationCheck = await this.verifyDelegation(req.delegation_jwt, req.merchant);
    if (!delegationCheck.ok) {
      throw new Error(`refused to issue intent: delegation ${delegationCheck.reason}`);
    }
    const now = this.now();
    const claims: IntentReceiptClaims = {
      iss: this.issuerId,
      sub: delegationCheck.claims.sub,
      credential_jti: delegationCheck.claims.jti,
      task_id: req.task_id,
      rail: req.rail,
      merchant: req.merchant,
      amount_ceiling_usd: req.amount_ceiling_usd,
      iat: now,
      exp: now + req.ttl_seconds,
      jti: ulid(),
      intent_hash: req.intent_hash,
    };
    const parsed = IntentReceiptClaimsSchema.parse(claims);
    const jwt = await this.sign(parsed);
    return { jwt, claims: parsed };
  }

  async countersignSettlement(
    req: SettlementRequest,
  ): ReturnType<MppPort['countersignSettlement']> {
    const intentCheck = await this.verifyIntent(req.intent_jwt);
    if (!intentCheck.ok) {
      throw new Error(`refused to countersign settlement: intent ${intentCheck.reason}`);
    }
    if (req.final_amount_usd > intentCheck.claims.amount_ceiling_usd) {
      throw new Error('refused to countersign settlement: final exceeds ceiling');
    }
    const claims: SettlementReceiptClaims = {
      iss: this.issuerId,
      sub: intentCheck.claims.sub,
      intent_jti: intentCheck.claims.jti,
      task_id: intentCheck.claims.task_id,
      rail: intentCheck.claims.rail,
      merchant: intentCheck.claims.merchant,
      final_amount_usd: req.final_amount_usd,
      merchant_signature: req.merchant_signature,
      iat: this.now(),
      jti: ulid(),
    };
    const parsed = SettlementReceiptClaimsSchema.parse(claims);
    const jwt = await this.sign(parsed);
    return { jwt, claims: parsed };
  }

  async verifyDelegation(jwt: Jwt, audience?: MerchantId): Promise<VerifyResult<DelegationClaims>> {
    return this.verifyWith(jwt, DelegationClaimsSchema, audience);
  }

  async verifyIntent(jwt: Jwt): Promise<VerifyResult<IntentReceiptClaims>> {
    return this.verifyWith(jwt, IntentReceiptClaimsSchema);
  }

  async verifySettlement(jwt: Jwt): Promise<VerifyResult<SettlementReceiptClaims>> {
    return this.verifyWith(jwt, SettlementReceiptClaimsSchema);
  }

  private async sign(claims: Record<string, unknown>): Promise<Jwt> {
    const key = await this.privateKeyPromise;
    const token = await new SignJWT(claims).setProtectedHeader({ alg: this.alg }).sign(key);
    return asJwt(token);
  }

  private async verifyWith<T extends { iss: string; exp?: number; aud?: ReadonlyArray<string> }>(
    jwt: Jwt,
    schema: { parse: (v: unknown) => T },
    audience?: MerchantId,
  ): Promise<VerifyResult<T>> {
    let payload: unknown;
    try {
      const verified = await jwtVerify(jwt, await this.publicKeyPromise, {
        algorithms: [this.alg],
      });
      payload = verified.payload;
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      const reason: VerifyFailReason = code === 'ERR_JWT_EXPIRED' ? 'expired' : 'bad_signature';
      return { ok: false, reason };
    }
    let claims: T;
    try {
      claims = schema.parse(payload);
    } catch {
      return { ok: false, reason: 'malformed_claims' };
    }
    if (claims.iss !== this.issuerId) {
      return { ok: false, reason: 'unknown_issuer' };
    }
    if (typeof claims.exp === 'number' && claims.exp <= this.now()) {
      return { ok: false, reason: 'expired' };
    }
    if (audience && Array.isArray(claims.aud) && !claims.aud.includes(audience)) {
      return { ok: false, reason: 'wrong_audience' };
    }
    return { ok: true, claims };
  }
}
