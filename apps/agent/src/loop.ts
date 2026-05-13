import type { Logger, TaskId } from '@autocompute/types';
import { parseToolInput, TOOL_DEFS } from './tools.js';
import {
  dispatchTool,
  renderToolResultJson,
  type AgentRunState,
  type HandlerDeps,
} from './handlers.js';
import type { LlmMessage, LlmPort, LlmStopReason, LlmToolResult } from './llm-port.js';
import { SYSTEM_PROMPT } from './system-prompt.js';

const MAX_TOKENS_PER_TURN = 16000;
const MAX_ITERATIONS = 24;

export interface RunAgentInput {
  task_id: TaskId;
  description: string;
  budget_ceiling_usd: number;
  deadline_iso: string;
}

export interface RunAgentResult {
  iterations: number;
  stop_reason: LlmStopReason;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  final_state: AgentRunState;
}

export const runAgent = async (
  llm: LlmPort,
  deps: HandlerDeps,
  state: AgentRunState,
  task: RunAgentInput,
): Promise<RunAgentResult> => {
  const log: Logger = deps.logger.child('loop', {
    task_id: task.task_id,
    llm_backend: llm.name,
    llm_model: llm.model,
  });

  const userBootstrap = `New task:
task_id: ${task.task_id}
description: ${task.description}
budget_ceiling_usd: ${task.budget_ceiling_usd}
deadline: ${task.deadline_iso}

Allowed merchants for this task: ${deps.scope.allowlist.join(', ')}.
Allowed rails: ${deps.scope.rails.join(', ')}.
Per-tx cap: $${deps.scope.caps.per_tx_usd}. Daily cap: $${deps.scope.caps.daily_usd}. HITL above $${deps.scope.hitl_threshold_usd}.

Begin by quoting providers.`;

  const messages: LlmMessage[] = [{ role: 'user', kind: 'text', text: userBootstrap }];

  const totals = {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_create: 0,
  };

  let iterations = 0;
  let lastStop: LlmStopReason = 'other';

  while (iterations < MAX_ITERATIONS) {
    iterations += 1;
    const response = await llm.turn({
      systemPrompt: SYSTEM_PROMPT,
      tools: TOOL_DEFS,
      messages,
      maxTokens: MAX_TOKENS_PER_TURN,
    });

    totals.input += response.usage.input_tokens;
    totals.output += response.usage.output_tokens;
    totals.cache_read += response.usage.cache_read_input_tokens;
    totals.cache_create += response.usage.cache_creation_input_tokens;
    lastStop = response.stop_reason;

    log.info('turn', {
      iteration: iterations,
      stop_reason: response.stop_reason,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read: response.usage.cache_read_input_tokens,
      tool_calls: response.tool_calls.length,
    });

    messages.push({
      role: 'assistant',
      text: response.text,
      tool_calls: response.tool_calls,
    });

    if (response.stop_reason === 'refusal') {
      log.error('model refused', { text: response.text });
      break;
    }

    if (response.stop_reason === 'end_turn' || response.tool_calls.length === 0) {
      break;
    }

    const toolResults: LlmToolResult[] = [];
    for (const tc of response.tool_calls) {
      let parsed;
      try {
        parsed = parseToolInput(tc.name, tc.input);
      } catch (e) {
        log.warn('tool input validation failed', {
          tool: tc.name,
          err: (e as Error).message,
        });
        toolResults.push({
          tool_use_id: tc.id,
          content: JSON.stringify({
            ok: false,
            error: 'invalid_input',
            message: (e as Error).message,
          }),
          is_error: true,
        });
        continue;
      }
      const r = await dispatchTool(parsed, deps, state);
      toolResults.push({
        tool_use_id: tc.id,
        content: renderToolResultJson(r),
        is_error: !r.ok,
      });
    }

    messages.push({ role: 'user', kind: 'tool_results', results: toolResults });
  }

  if (iterations >= MAX_ITERATIONS) {
    log.warn('hit MAX_ITERATIONS', { iterations });
  }

  return {
    iterations,
    stop_reason: lastStop,
    total_input_tokens: totals.input,
    total_output_tokens: totals.output,
    total_cache_read_tokens: totals.cache_read,
    total_cache_creation_tokens: totals.cache_create,
    final_state: state,
  };
};
