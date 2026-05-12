import { ulid } from 'ulidx';
import { z } from 'zod';
import { errorJson, json, parseBody } from '../../../../../lib/route-helpers';

const Body = z.object({
  task_id: z.string().min(1),
  description: z.string().min(1).max(2000),
  budget_ceiling_usd: z.number().positive(),
});

/// Hyperscaler-style provider. Always quotes 1.75x the dcomp price (slower
/// settlement on card rails has a cost) with a longer estimated runtime.
export async function POST(req: Request): Promise<Response> {
  const parsed = await parseBody(req, Body);
  if (!parsed.ok) return parsed.response;
  const { budget_ceiling_usd } = parsed.data;
  if (budget_ceiling_usd < 30) {
    return errorJson(422, 'below_minimum', 'minimum quotable job is $30');
  }
  const estimated_usd = Math.min(budget_ceiling_usd, Math.round(budget_ceiling_usd * 0.5 * 1.75));
  return json({
    merchant: 'merchant:hyperscaler-mock',
    rail: 'visa_card',
    estimated_usd,
    estimated_seconds: 90 * 60,
    quote_id: `q_${ulid()}`,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
}
