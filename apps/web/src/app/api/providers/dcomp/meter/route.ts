import { z } from 'zod';
import { errorJson, json, parseBody } from '../../../../../lib/route-helpers';
import { DcompStore } from '../../../../../lib/provider-state';

/// GET /api/providers/dcomp/meter?job_id=...
/// Returns the current set of meter ticks for an open job.
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const jobId = url.searchParams.get('job_id');
  if (!jobId) return errorJson(400, 'missing_param', 'job_id query param required');
  const job = DcompStore.get(jobId);
  if (!job) return errorJson(404, 'unknown_job', `no such job: ${jobId}`);
  return json({
    job_id: job.job_id,
    status: job.status,
    consumed_usd: job.consumed_usd,
    projected_total_usd: job.projected_total_usd,
    ticks: job.meter_ticks,
  });
}

/// POST /api/providers/dcomp/meter
/// Test-only path used by drivers (e.g. demo script) to advance the job's
/// progress. In a real provider this would be pushed by the worker, not
/// pulled by the agent.
const PostBody = z.object({
  job_id: z.string().min(1),
  progress_bps: z.number().int().min(0).max(10_000),
  consumed_usd: z.number().nonnegative(),
  projected_total_usd: z.number().nonnegative(),
});

export async function POST(req: Request): Promise<Response> {
  const parsed = await parseBody(req, PostBody);
  if (!parsed.ok) return parsed.response;
  try {
    const updated = DcompStore.meter(parsed.data);
    return json({
      job_id: updated.job_id,
      status: updated.status,
      consumed_usd: updated.consumed_usd,
      projected_total_usd: updated.projected_total_usd,
      tick_count: updated.meter_ticks.length,
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith('unknown job')) return errorJson(404, 'unknown_job', msg);
    return errorJson(409, 'meter_rejected', msg);
  }
}
