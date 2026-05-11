import { z } from 'zod';
import {
  AgentIdSchema,
  MerchantIdSchema,
  PrincipalIdSchema,
  RailSchema,
  TaskIdSchema,
} from './rail.js';

export const ScopeCapsSchema = z.object({
  per_tx_usd: z.number().positive(),
  daily_usd: z.number().positive(),
  weekly_usd: z.number().positive(),
});
export type ScopeCaps = z.infer<typeof ScopeCapsSchema>;

export const DelegationScopeSchema = z.object({
  rails: z.array(RailSchema).min(1),
  caps: ScopeCapsSchema,
  allowlist: z.array(MerchantIdSchema).min(1),
  hitl_threshold_usd: z.number().positive(),
});
export type DelegationScope = z.infer<typeof DelegationScopeSchema>;

export const DelegationClaimsSchema = z.object({
  iss: z.string().min(1),
  sub: AgentIdSchema,
  aud: z.array(MerchantIdSchema).min(1),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  jti: z.string().min(1),
  principal: PrincipalIdSchema,
  scope: DelegationScopeSchema,
  key_binding: z.string().min(1),
});
export type DelegationClaims = z.infer<typeof DelegationClaimsSchema>;

export const IntentReceiptClaimsSchema = z.object({
  iss: z.string().min(1),
  sub: AgentIdSchema,
  credential_jti: z.string().min(1),
  task_id: TaskIdSchema,
  rail: RailSchema,
  merchant: MerchantIdSchema,
  amount_ceiling_usd: z.number().positive(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  jti: z.string().min(1),
  intent_hash: z.string().regex(/^0x[0-9a-f]{64}$/),
});
export type IntentReceiptClaims = z.infer<typeof IntentReceiptClaimsSchema>;

export const SettlementReceiptClaimsSchema = z.object({
  iss: z.string().min(1),
  sub: AgentIdSchema,
  intent_jti: z.string().min(1),
  task_id: TaskIdSchema,
  rail: RailSchema,
  merchant: MerchantIdSchema,
  final_amount_usd: z.number().nonnegative(),
  merchant_signature: z.string().min(1),
  iat: z.number().int().nonnegative(),
  jti: z.string().min(1),
});
export type SettlementReceiptClaims = z.infer<typeof SettlementReceiptClaimsSchema>;

export type Jwt = string & { readonly __brand: 'jwt' };
export const asJwt = (s: string): Jwt => s as Jwt;
