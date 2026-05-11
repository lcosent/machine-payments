import { z } from 'zod';
import { AgentIdSchema, MerchantIdSchema, RailSchema, TaskIdSchema } from './rail.js';

export const TaskStatusSchema = z.enum([
  'submitted',
  'quoting',
  'awaiting_funds',
  'running',
  'metering',
  'settled',
  'failed',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: TaskIdSchema,
  agent_id: AgentIdSchema,
  description: z.string().min(1).max(2000),
  budget_ceiling_usd: z.number().positive(),
  deadline: z.string().datetime(),
  status: TaskStatusSchema,
  created_at: z.string().datetime(),
});
export type Task = z.infer<typeof TaskSchema>;

export const ProviderQuoteSchema = z.object({
  merchant: MerchantIdSchema,
  rail: RailSchema,
  estimated_usd: z.number().positive(),
  estimated_seconds: z.number().int().positive(),
  quote_id: z.string().min(1),
  expires_at: z.string().datetime(),
});
export type ProviderQuote = z.infer<typeof ProviderQuoteSchema>;

export const MeterTickSchema = z.object({
  job_id: z.string().min(1),
  progress_bps: z.number().int().min(0).max(10_000),
  consumed_usd: z.number().nonnegative(),
  projected_total_usd: z.number().nonnegative(),
  at: z.string().datetime(),
});
export type MeterTick = z.infer<typeof MeterTickSchema>;
