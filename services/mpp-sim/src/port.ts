import type {
  AgentId,
  DelegationClaims,
  DelegationScope,
  IntentReceiptClaims,
  Jwt,
  MerchantId,
  PrincipalId,
  Rail,
  SettlementReceiptClaims,
  TaskId,
} from '@autocompute/types';

export interface DelegationRequest {
  principal: PrincipalId;
  agent: AgentId;
  audience: ReadonlyArray<MerchantId>;
  scope: DelegationScope;
  key_binding: string;
  ttl_seconds: number;
}

export interface IntentRequest {
  delegation_jwt: Jwt;
  task_id: TaskId;
  rail: Rail;
  merchant: MerchantId;
  amount_ceiling_usd: number;
  intent_hash: `0x${string}`;
  ttl_seconds: number;
}

export interface SettlementRequest {
  intent_jwt: Jwt;
  final_amount_usd: number;
  merchant_signature: string;
}

export type VerifyOk<TClaims> = { ok: true; claims: TClaims };
export type VerifyErr = { ok: false; reason: VerifyFailReason };
export type VerifyResult<TClaims> = VerifyOk<TClaims> | VerifyErr;

export type VerifyFailReason =
  | 'bad_signature'
  | 'expired'
  | 'wrong_audience'
  | 'malformed_claims'
  | 'unknown_issuer';

export interface MppPort {
  issueDelegation(req: DelegationRequest): Promise<{ jwt: Jwt; claims: DelegationClaims }>;
  issueIntent(req: IntentRequest): Promise<{ jwt: Jwt; claims: IntentReceiptClaims }>;
  countersignSettlement(
    req: SettlementRequest,
  ): Promise<{ jwt: Jwt; claims: SettlementReceiptClaims }>;
  verifyDelegation(jwt: Jwt, audience?: MerchantId): Promise<VerifyResult<DelegationClaims>>;
  verifyIntent(jwt: Jwt): Promise<VerifyResult<IntentReceiptClaims>>;
  verifySettlement(jwt: Jwt): Promise<VerifyResult<SettlementReceiptClaims>>;
}
