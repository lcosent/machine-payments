import { ulid } from 'ulidx';
import { z } from 'zod';
import { errorJson, json, parseBody } from '../../../../../lib/route-helpers';

const Body = z.object({
  task_id: z.string().min(1),
  description: z.string().min(1).max(2000),
  budget_ceiling_usd: z.number().positive(),
});

/// USDC-escrow provider quote. Pricing model: $0.40/sec for the "rendering"
/// workload, capped at the requested budget. Always quotes within budget so
/// the agent can make a normal decision; the overrun comes later via /meter.
export async function POST(req: Request): Promise<Response> {
  const parsed = await parseBody(req, Body);
  if (!parsed.ok) return parsed.response;
  const { budget_ceiling_usd } = parsed.data;
  if (budget_ceiling_usd < 20) {
    return errorJson(422, 'below_minimum', 'minimum quotable job is $20');
  }
  // Quote at 50% of budget, with a 70-second job estimate.
  const estimated_usd = Math.min(budget_ceiling_usd, Math.round(budget_ceiling_usd * 0.5));
  return json({
    merchant: 'merchant:dcomp-mock',
    rail: 'usdc_escrow',
    estimated_usd,
    estimated_seconds: 70,
    quote_id: `q_${ulid()}`,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
}
