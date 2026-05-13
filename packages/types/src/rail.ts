import { z } from 'zod';

export const RailSchema = z.enum(['visa_card', 'usdc_escrow', 'credit_line']);
export type Rail = z.infer<typeof RailSchema>;

export const MerchantIdSchema = z
  .string()
  .regex(/^merchant:[a-z0-9-]+$/, 'merchant id must look like merchant:slug');
export type MerchantId = z.infer<typeof MerchantIdSchema>;

export const AgentIdSchema = z
  .string()
  .regex(/^agent:[a-z0-9-]+$/, 'agent id must look like agent:slug');
export type AgentId = z.infer<typeof AgentIdSchema>;

export const PrincipalIdSchema = z
  .string()
  .regex(/^ent:[a-z0-9-]+$/, 'principal id must look like ent:slug');
export type PrincipalId = z.infer<typeof PrincipalIdSchema>;

export const TaskIdSchema = z.string().regex(/^task_[A-Z0-9]{26}$/, 'task id must be ULID-shaped');
export type TaskId = z.infer<typeof TaskIdSchema>;
