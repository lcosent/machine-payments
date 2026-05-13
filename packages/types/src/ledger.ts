import { z } from 'zod';
import { AgentIdSchema, MerchantIdSchema, RailSchema, TaskIdSchema } from './rail.js';

export const LedgerEntryKindSchema = z.enum([
  'intent_issued',
  'escrow_opened',
  'escrow_metered',
  'escrow_settled',
  'card_charged',
  'credit_drawn',
  'credit_repaid',
  'settlement_receipt',
  'guardrail_block',
]);
export type LedgerEntryKind = z.infer<typeof LedgerEntryKindSchema>;

export const LedgerEntrySchema = z.object({
  id: z.string().uuid(),
  task_id: TaskIdSchema,
  agent_id: AgentIdSchema,
  merchant: MerchantIdSchema.optional(),
  rail: RailSchema,
  kind: LedgerEntryKindSchema,
  amount_usd: z.number(),
  ref_jti: z.string().optional(),
  onchain_tx_hash: z
    .string()
    .regex(/^0x[0-9a-f]{64}$/)
    .optional(),
  payload_sha256: z.string().regex(/^0x[0-9a-f]{64}$/),
  idempotency_key: z.string().min(1),
  at: z.string().datetime(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const UnifiedStatementRowSchema = z.object({
  task_id: TaskIdSchema,
  rail: RailSchema,
  gross_usd: z.number(),
  net_usd: z.number(),
  credit_drawn_usd: z.number().nonnegative(),
  credit_repaid_usd: z.number().nonnegative(),
  anomalies: z.array(z.string()),
});
export type UnifiedStatementRow = z.infer<typeof UnifiedStatementRowSchema>;
