import { ulid } from 'ulidx';
import type {
  LlmMessage,
  LlmPort,
  LlmStopReason,
  LlmToolCall,
  LlmTurnRequest,
  LlmTurnResponse,
} from './llm-port.js';

export interface OpenAICompatConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export class OpenAICompatLlmPort implements LlmPort {
  readonly name = 'openai_compat';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(cfg: OpenAICompatConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
    this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
  }

  async turn(req: LlmTurnRequest): Promise<LlmTurnResponse> {
    const body = {
      model: this.model,
      max_tokens: req.maxTokens,
      messages: [
        { role: 'system' as const, content: req.systemPrompt },
        ...flattenToChatMessages(req.messages),
      ],
      tools: req.tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      })),
      tool_choice: 'auto' as const,
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '<no body>');
      throw new Error(`openai-compat backend ${resp.status}: ${errText.slice(0, 500)}`);
    }

    const payload = (await resp.json()) as ChatCompletionResponse;
    const choice = payload.choices[0];
    if (!choice) throw new Error('openai-compat: response had no choices');

    const text = choice.message.content ?? '';
    const tool_calls: LlmToolCall[] = (choice.message.tool_calls ?? []).map((tc) => {
      let parsed: unknown;
      try {
        parsed =
          typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
      } catch {
        parsed = {};
      }
      return {
        id: tc.id || ulid(),
        name: tc.function.name,
        input: parsed,
      };
    });

    return {
      stop_reason: mapFinishReason(choice.finish_reason, tool_calls.length > 0),
      text,
      tool_calls,
      usage: {
        input_tokens: payload.usage?.prompt_tokens ?? 0,
        output_tokens: payload.usage?.completion_tokens ?? 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
  }
}

const mapFinishReason = (s: string, hasToolCalls: boolean): LlmStopReason => {
  switch (s) {
    case 'stop':
      return hasToolCalls ? 'tool_use' : 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return hasToolCalls ? 'tool_use' : 'other';
  }
};

const flattenToChatMessages = (messages: ReadonlyArray<LlmMessage>): ChatMessage[] => {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.kind === 'text') {
        out.push({ role: 'user', content: m.text });
      } else {
        for (const r of m.results) {
          out.push({
            role: 'tool',
            tool_call_id: r.tool_use_id,
            content: r.is_error ? `[error] ${r.content}` : r.content,
          });
        }
      }
    } else {
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: m.text || null,
      };
      if (m.tool_calls.length > 0) {
        assistantMsg.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.input ?? {}),
          },
        }));
      }
      out.push(assistantMsg);
    }
  }
  return out;
};
