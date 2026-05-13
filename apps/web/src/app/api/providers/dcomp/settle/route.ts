import { z } from 'zod';
import { errorJson, json, parseBody } from '../../../../../lib/route-helpers';
import { DcompStore } from '../../../../../lib/provider-state';

const Body = z.object({
  job_id: z.string().min(1),
  final_amount_usd: z.number().nonnegative(),
  /// Optional. When set, the returned signature is a real ECDSA signature over
  /// the digest Escrow.sol's settle() recovers. Pass these for Tier 3 runs.
  escrow_address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'escrow_address must be a 20-byte hex address')
    .optional(),
  job_id_uint: z
    .string()
    .regex(/^[0-9]+$/, 'job_id_uint must be a decimal-string uint256')
    .optional(),
});

export async function POST(req: Request): Promise<Response> {
  const parsed = await parseBody(req, Body);
  if (!parsed.ok) return parsed.response;
  try {
    const args: Parameters<typeof DcompStore.settle>[0] = {
      job_id: parsed.data.job_id,
      final_amount_usd: parsed.data.final_amount_usd,
    };
    if (parsed.data.escrow_address)
      args.escrow_address = parsed.data.escrow_address as `0x${string}`;
    if (parsed.data.job_id_uint) args.job_id_uint = BigInt(parsed.data.job_id_uint);
    const { job, merchant_signature } = await DcompStore.settle(args);
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
