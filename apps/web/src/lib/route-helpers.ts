import type { ZodTypeAny, infer as zinfer } from 'zod';

export const json = (body: unknown, init: ResponseInit = {}): Response =>
  Response.json(body, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });

export const errorJson = (
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response => json({ error: code, message, ...extra }, { status });

export const parseBody = async <S extends ZodTypeAny>(
  req: Request,
  schema: S,
): Promise<{ ok: true; data: zinfer<S> } | { ok: false; response: Response }> => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return {
      ok: false,
      response: errorJson(400, 'invalid_json', 'request body must be valid JSON'),
    };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      response: errorJson(400, 'invalid_input', 'request body failed schema validation', {
        issues: result.error.issues,
      }),
    };
  }
  return { ok: true, data: result.data };
};
