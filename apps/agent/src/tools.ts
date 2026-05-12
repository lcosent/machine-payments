import { z } from 'zod';
import { MerchantIdSchema, RailSchema, TaskIdSchema } from '@autocompute/types';

export const ToolNameSchema = z.enum([
  'quote_providers',
  'pay_usdc_escrow',
  'pay_visa_card',
  'draw_credit',
  'repay_credit',
  'settle_task',
  'report_status',
]);
export type ToolName = z.infer<typeof ToolNameSchema>;

export const QuoteProvidersInputSchema = z.object({
  task_id: TaskIdSchema,
  description: z.string().min(1),
  budget_ceiling_usd: z.number().positive(),
  rails: z.array(RailSchema).min(1).optional(),
});
export type QuoteProvidersInput = z.infer<typeof QuoteProvidersInputSchema>;

export const PayUsdcEscrowInputSchema = z.object({
  task_id: TaskIdSchema,
  merchant: MerchantIdSchema,
  amount_usd: z.number().positive(),
  rationale: z.string().min(1).max(500),
});
export type PayUsdcEscrowInput = z.infer<typeof PayUsdcEscrowInputSchema>;

export const PayVisaCardInputSchema = z.object({
  task_id: TaskIdSchema,
  merchant: MerchantIdSchema,
  amount_usd: z.number().positive(),
  rationale: z.string().min(1).max(500),
});
export type PayVisaCardInput = z.infer<typeof PayVisaCardInputSchema>;

export const DrawCreditInputSchema = z.object({
  task_id: TaskIdSchema,
  amount_usd: z.number().positive(),
  rationale: z.string().min(1).max(500),
});
export type DrawCreditInput = z.infer<typeof DrawCreditInputSchema>;

export const RepayCreditInputSchema = z.object({
  task_id: TaskIdSchema,
  amount_usd: z.number().positive(),
});
export type RepayCreditInput = z.infer<typeof RepayCreditInputSchema>;

export const SettleTaskInputSchema = z.object({
  task_id: TaskIdSchema,
  intent_jti: z.string().min(1),
  final_amount_usd: z.number().nonnegative(),
  merchant_signature: z.string().min(1),
});
export type SettleTaskInput = z.infer<typeof SettleTaskInputSchema>;

export const ReportStatusInputSchema = z.object({
  task_id: TaskIdSchema,
  status: z.enum(['progress', 'blocked', 'completed', 'needs_hitl']),
  message: z.string().min(1).max(2000),
});
export type ReportStatusInput = z.infer<typeof ReportStatusInputSchema>;

export type ToolInput =
  | { name: 'quote_providers'; input: QuoteProvidersInput }
  | { name: 'pay_usdc_escrow'; input: PayUsdcEscrowInput }
  | { name: 'pay_visa_card'; input: PayVisaCardInput }
  | { name: 'draw_credit'; input: DrawCreditInput }
  | { name: 'repay_credit'; input: RepayCreditInput }
  | { name: 'settle_task'; input: SettleTaskInput }
  | { name: 'report_status'; input: ReportStatusInput };

export const parseToolInput = (name: string, raw: unknown): ToolInput => {
  switch (name) {
    case 'quote_providers':
      return { name, input: QuoteProvidersInputSchema.parse(raw) };
    case 'pay_usdc_escrow':
      return { name, input: PayUsdcEscrowInputSchema.parse(raw) };
    case 'pay_visa_card':
      return { name, input: PayVisaCardInputSchema.parse(raw) };
    case 'draw_credit':
      return { name, input: DrawCreditInputSchema.parse(raw) };
    case 'repay_credit':
      return { name, input: RepayCreditInputSchema.parse(raw) };
    case 'settle_task':
      return { name, input: SettleTaskInputSchema.parse(raw) };
    case 'report_status':
      return { name, input: ReportStatusInputSchema.parse(raw) };
    default:
      throw new Error(`unknown tool: ${name}`);
  }
};

export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export const TOOL_DEFS: ReadonlyArray<AnthropicToolDef> = [
  {
    name: 'quote_providers',
    description:
      'Query the compute marketplace for quotes against the task. Returns an array of quotes (merchant id, rail, estimated USD cost, estimated seconds, expiry). Use this before any pay_* call so you can pick the best provider.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ULID-shaped task id, e.g. task_01J...' },
        description: { type: 'string', description: 'Free-text description of the compute task.' },
        budget_ceiling_usd: {
          type: 'number',
          description: 'Hard ceiling in USD the agent is willing to spend on this task.',
        },
        rails: {
          type: 'array',
          items: { type: 'string', enum: ['visa_card', 'usdc_escrow', 'credit_line'] },
          description: 'Optional filter restricting which payment rails to consider.',
        },
      },
      required: ['task_id', 'description', 'budget_ceiling_usd'],
    },
  },
  {
    name: 'pay_usdc_escrow',
    description:
      'Open a USDC escrow on Base Sepolia paying a decentralized provider. The harness runs the guardrail check, obtains an MPP intent receipt, and submits the escrow open via the smart wallet. Returns the intent jti, escrow job id, and on-chain tx hash on success; returns a structured rejection if the guardrail blocks.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        merchant: { type: 'string', description: 'merchant:<slug>' },
        amount_usd: { type: 'number' },
        rationale: {
          type: 'string',
          description: 'Short justification logged to the audit trail.',
        },
      },
      required: ['task_id', 'merchant', 'amount_usd', 'rationale'],
    },
  },
  {
    name: 'pay_visa_card',
    description:
      'Charge an MPP-scoped virtual Visa card at a hyperscaler-style merchant. Harness runs guardrail + issues intent receipt; returns intent jti and merchant authorization id on success.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        merchant: { type: 'string' },
        amount_usd: { type: 'number' },
        rationale: { type: 'string' },
      },
      required: ['task_id', 'merchant', 'amount_usd', 'rationale'],
    },
  },
  {
    name: 'draw_credit',
    description:
      'Borrow USDC from the on-chain credit line. Use this when projected task cost will exceed remaining float. Guardrail-gated.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        amount_usd: { type: 'number' },
        rationale: { type: 'string' },
      },
      required: ['task_id', 'amount_usd', 'rationale'],
    },
  },
  {
    name: 'repay_credit',
    description: 'Repay outstanding USDC debt to the credit line. Not guardrail-gated.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        amount_usd: { type: 'number' },
      },
      required: ['task_id', 'amount_usd'],
    },
  },
  {
    name: 'settle_task',
    description:
      'Countersign a provider settlement. Pass the intent jti returned by the originating pay_* call and the final amount the merchant signed for. Final amount must be ≤ intent ceiling.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        intent_jti: { type: 'string' },
        final_amount_usd: { type: 'number' },
        merchant_signature: { type: 'string' },
      },
      required: ['task_id', 'intent_jti', 'final_amount_usd', 'merchant_signature'],
    },
  },
  {
    name: 'report_status',
    description:
      'Emit a human-readable status update to the Principal. Use status="needs_hitl" when a guardrail HITL threshold is triggered and you want Principal sign-off before proceeding.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        status: {
          type: 'string',
          enum: ['progress', 'blocked', 'completed', 'needs_hitl'],
        },
        message: { type: 'string' },
      },
      required: ['task_id', 'status', 'message'],
    },
  },
];
