import { AnthropicLlmPort } from './anthropic-port.js';
import type { LlmPort } from './llm-port.js';
import { OpenAICompatLlmPort } from './openai-compat-port.js';

export type LlmBackend = 'anthropic' | 'openai_compat';

export const LM_STUDIO_DEFAULT_BASE_URL = 'http://localhost:1234/v1';

export interface MakeLlmFromEnvInput {
  env?: Record<string, string | undefined>;
}

/// Reads LLM_BACKEND from env (defaults to 'anthropic') and returns a configured port.
/// Backend-specific env vars:
///   anthropic:     ANTHROPIC_API_KEY, ANTHROPIC_MODEL (default claude-sonnet-4-6)
///   openai_compat: OPENAI_COMPAT_BASE_URL (default http://localhost:1234/v1 — LM Studio),
///                  OPENAI_COMPAT_API_KEY (optional; LM Studio + Ollama accept any value),
///                  OPENAI_COMPAT_MODEL (required, e.g. qwen2.5-coder-32b-instruct)
export const makeLlmFromEnv = (input: MakeLlmFromEnvInput = {}): LlmPort => {
  const env = input.env ?? (process.env as Record<string, string | undefined>);
  const backend = (env['LLM_BACKEND'] ?? 'anthropic') as LlmBackend;
  switch (backend) {
    case 'anthropic': {
      const cfg: { apiKey?: string; model?: string } = {};
      const apiKey = env['ANTHROPIC_API_KEY'];
      const model = env['ANTHROPIC_MODEL'];
      if (apiKey !== undefined) cfg.apiKey = apiKey;
      if (model !== undefined) cfg.model = model;
      return new AnthropicLlmPort(cfg);
    }
    case 'openai_compat': {
      const model = env['OPENAI_COMPAT_MODEL'];
      if (!model) {
        throw new Error(
          'OPENAI_COMPAT_MODEL is required when LLM_BACKEND=openai_compat. ' +
            'For LM Studio, this is the model id shown next to the loaded model.',
        );
      }
      const cfg: ConstructorParameters<typeof OpenAICompatLlmPort>[0] = {
        baseUrl: env['OPENAI_COMPAT_BASE_URL'] ?? LM_STUDIO_DEFAULT_BASE_URL,
        model,
      };
      const apiKey = env['OPENAI_COMPAT_API_KEY'];
      if (apiKey !== undefined) cfg.apiKey = apiKey;
      return new OpenAICompatLlmPort(cfg);
    }
    default: {
      const _exhaustive: never = backend;
      throw new Error(`unknown LLM_BACKEND: ${String(_exhaustive)}`);
    }
  }
};
