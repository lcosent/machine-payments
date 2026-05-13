import Anthropic from '@anthropic-ai/sdk';
import type {
  LlmMessage,
  LlmPort,
  LlmStopReason,
  LlmToolCall,
  LlmTurnRequest,
  LlmTurnResponse,
} from './llm-port.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

export interface AnthropicLlmPortConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

export class AnthropicLlmPort implements LlmPort {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;

  constructor(cfg: AnthropicLlmPortConfig = {}) {
    this.model = cfg.model ?? DEFAULT_MODEL;
    this.client = new Anthropic({
      ...(cfg.apiKey !== undefined ? { apiKey: cfg.apiKey } : {}),
      ...(cfg.baseURL !== undefined ? { baseURL: cfg.baseURL } : {}),
    });
  }

  async turn(req: LlmTurnRequest): Promise<LlmTurnResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: [
        {
          type: 'text',
          text: req.systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: req.tools.map((t, i) =>
        i === req.tools.length - 1
          ? { ...t, cache_control: { type: 'ephemeral' as const } }
          : { ...t },
      ),
      messages: req.messages.map(toAnthropicMessage),
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const tool_calls: LlmToolCall[] = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    return {
      stop_reason: mapStopReason(response.stop_reason),
      text,
      tool_calls,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

const mapStopReason = (s: Anthropic.Message['stop_reason']): LlmStopReason => {
  switch (s) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
};

const toAnthropicMessage = (m: LlmMessage): Anthropic.MessageParam => {
  if (m.role === 'user') {
    if (m.kind === 'text') {
      return { role: 'user', content: m.text };
    }
    return {
      role: 'user',
      content: m.results.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.tool_use_id,
        content: r.content,
        is_error: r.is_error,
      })),
    };
  }
  const content: Anthropic.ContentBlockParam[] = [];
  if (m.text) content.push({ type: 'text', text: m.text });
  for (const tc of m.tool_calls) {
    content.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.name,
      input: tc.input as Record<string, unknown>,
    });
  }
  return { role: 'assistant', content };
};
