import { z } from 'zod';
import { json, parseBody } from '../../../../../lib/route-helpers';
import { HyperscalerStore } from '../../../../../lib/provider-state';

const Body = z.object({
  task_id: z.string().min(1),
  amount_usd: z.number().positive(),
  intent_hash: z.string().regex(/^0x[0-9a-f]{64}$/, 'intent_hash must be 32-byte hex'),
});

export async function POST(req: Request): Promise<Response> {
  const parsed = await parseBody(req, Body);
  if (!parsed.ok) return parsed.response;
  const auth = HyperscalerStore.charge(parsed.data);
  return json({
    authorization_id: auth.authorization_id,
    status: auth.status,
    amount_usd: auth.amount_usd,
    created_at: auth.created_at,
  });
}
