import type {
  LlmMessage,
  LlmPort,
  LlmStopReason,
  LlmToolCall,
  LlmTurnRequest,
  LlmTurnResponse,
} from './llm-port.js';

/// A scripted LLM that drives the agent loop through a canned sequence of
/// tool calls so the demo can run end-to-end without an API key. Each turn
/// emits the next entry from `script`; when the script runs out the port
/// returns `end_turn` with a final summary.
///
/// Useful for:
///  - exercising the full agent + sink + escrow + reconciler pipeline in CI
///  - sandbox demos that show the four-pillar trace deterministically
///  - regression tests that wire a fixed plan into the harness
///
/// **Not a substitute for a real LLM.** It does not reason about quote
/// results or guardrail rejections; it just emits the next scripted call.
export interface ScriptedTurn {
  /// Text the LLM "says" alongside this turn. Optional.
  text?: string;
  /// Tool calls to make this turn. Empty/absent → no tool use this turn.
  tool_calls?: ReadonlyArray<{ name: string; input: unknown }>;
}

export interface FakeScriptedLlmPortConfig {
  script: ReadonlyArray<ScriptedTurn>;
  /// Optional hook called on each turn so callers can inspect what the
  /// agent fed in. Useful for debugging which tool result the next scripted
  /// step should react to.
  onTurn?: (info: { index: number; messages: ReadonlyArray<LlmMessage> }) => void;
}

export class FakeScriptedLlmPort implements LlmPort {
  readonly name = 'fake_scripted';
  readonly model = 'fake-scripted-llm';
  private cursor = 0;
  private readonly cfg: FakeScriptedLlmPortConfig;

  constructor(cfg: FakeScriptedLlmPortConfig) {
    this.cfg = cfg;
  }

  async turn(req: LlmTurnRequest): Promise<LlmTurnResponse> {
    this.cfg.onTurn?.({ index: this.cursor, messages: req.messages });
    const step = this.cfg.script[this.cursor];
    this.cursor += 1;

    if (!step) {
      return mkResponse('end_turn', 'Task complete.', []);
    }
    const calls: LlmToolCall[] = (step.tool_calls ?? []).map((c, i) => ({
      id: `fake_call_${this.cursor}_${i}`,
      name: c.name,
      input: c.input,
    }));
    const stop: LlmStopReason = calls.length > 0 ? 'tool_use' : 'end_turn';
    return mkResponse(stop, step.text ?? '', calls);
  }
}

const mkResponse = (
  stop_reason: LlmStopReason,
  text: string,
  tool_calls: ReadonlyArray<LlmToolCall>,
): LlmTurnResponse => ({
  stop_reason,
  text,
  tool_calls,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
});
