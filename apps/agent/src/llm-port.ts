export type LlmStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface LlmToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface LlmToolResult {
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

export type LlmMessage =
  | { role: 'user'; kind: 'text'; text: string }
  | { role: 'user'; kind: 'tool_results'; results: ReadonlyArray<LlmToolResult> }
  | { role: 'assistant'; text: string; tool_calls: ReadonlyArray<LlmToolCall> };

export interface LlmToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface LlmTurnRequest {
  systemPrompt: string;
  tools: ReadonlyArray<LlmToolDef>;
  messages: ReadonlyArray<LlmMessage>;
  maxTokens: number;
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface LlmTurnResponse {
  stop_reason: LlmStopReason;
  text: string;
  tool_calls: ReadonlyArray<LlmToolCall>;
  usage: LlmUsage;
}

export interface LlmPort {
  readonly name: string;
  readonly model: string;
  turn(req: LlmTurnRequest): Promise<LlmTurnResponse>;
}
