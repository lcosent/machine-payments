import { z } from 'zod';
import { errorJson, json, parseBody } from '../../../../../lib/route-helpers';
import { DcompStore } from '../../../../../lib/provider-state';

const Body = z.object({
  job_id: z.string().min(1),
  final_amount_usd: z.number().nonnegative(),
});

export async function POST(req: Request): Promise<Response> {
  const parsed = await parseBody(req, Body);
  if (!parsed.ok) return parsed.response;
  try {
    const { job, merchant_signature } = DcompStore.settle(parsed.data);
    return json({
      job_id: job.job_id,
      status: job.status,
      final_amount_usd: job.consumed_usd,
      merchant_signature,
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith('unknown job')) return errorJson(404, 'unknown_job', msg);
    if (msg.includes('exceeds')) return errorJson(409, 'final_exceeds_ceiling', msg);
    if (msg.includes('already settled')) return errorJson(409, 'already_settled', msg);
    return errorJson(409, 'settle_rejected', msg);
  }
}
