import { z } from 'zod';
import { json, parseBody } from '../../../../../lib/route-helpers';
import { DcompStore } from '../../../../../lib/provider-state';

const Body = z.object({
  task_id: z.string().min(1),
  intent_hash: z.string().regex(/^0x[0-9a-f]{64}$/, 'intent_hash must be 32-byte hex'),
  amount_ceiling_usd: z.number().positive(),
});

export async function POST(req: Request): Promise<Response> {
  const parsed = await parseBody(req, Body);
  if (!parsed.ok) return parsed.response;
  const job = DcompStore.open(parsed.data);
  return json({
    job_id: job.job_id,
    status: job.status,
    created_at: job.created_at,
  });
}
