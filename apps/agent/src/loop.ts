import Anthropic from '@anthropic-ai/sdk';
import type { Logger, TaskId } from '@autocompute/types';
import { parseToolInput, TOOL_DEFS } from './tools.js';
import {
  dispatchTool,
  renderToolResultJson,
  type AgentRunState,
  type HandlerDeps,
} from './handlers.js';
import { SYSTEM_PROMPT } from './system-prompt.js';

const MODEL_ID = 'claude-sonnet-4-6';
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
  stop_reason: Anthropic.Message['stop_reason'];
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  final_state: AgentRunState;
}

export const runAgent = async (
  client: Anthropic,
  deps: HandlerDeps,
  state: AgentRunState,
  task: RunAgentInput,
): Promise<RunAgentResult> => {
  const log: Logger = deps.logger.child('loop', { task_id: task.task_id });

  const userBootstrap = `New task:
task_id: ${task.task_id}
description: ${task.description}
budget_ceiling_usd: ${task.budget_ceiling_usd}
deadline: ${task.deadline_iso}

Allowed merchants for this task: ${deps.scope.allowlist.join(', ')}.
Allowed rails: ${deps.scope.rails.join(', ')}.
Per-tx cap: $${deps.scope.caps.per_tx_usd}. Daily cap: $${deps.scope.caps.daily_usd}. HITL above $${deps.scope.hitl_threshold_usd}.

Begin by quoting providers.`;

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userBootstrap }];

  let totals = {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_create: 0,
  };

  let iterations = 0;
  let lastStop: Anthropic.Message['stop_reason'] = null;

  while (iterations < MAX_ITERATIONS) {
    iterations += 1;
    const response = await client.messages.create({
      model: MODEL_ID,
      max_tokens: MAX_TOKENS_PER_TURN,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: TOOL_DEFS.map((t) => ({
        ...t,
        cache_control: { type: 'ephemeral' as const },
      })),
      messages,
    });

    totals.input += response.usage.input_tokens;
    totals.output += response.usage.output_tokens;
    totals.cache_read += response.usage.cache_read_input_tokens ?? 0;
    totals.cache_create += response.usage.cache_creation_input_tokens ?? 0;

    lastStop = response.stop_reason;

    log.info('turn', {
      iteration: iterations,
      stop_reason: response.stop_reason,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read: response.usage.cache_read_input_tokens ?? 0,
    });

    if (response.stop_reason === 'refusal') {
      log.error('model refused', { stop_details: response.stop_reason });
      messages.push({ role: 'assistant', content: response.content });
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      break;
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (toolUses.length === 0) {
      break;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      let parsed;
      try {
        parsed = parseToolInput(tu.name, tu.input);
      } catch (e) {
        log.warn('tool input validation failed', {
          tool: tu.name,
          err: (e as Error).message,
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
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
        type: 'tool_result',
        tool_use_id: tu.id,
        content: renderToolResultJson(r),
        is_error: !r.ok,
      });
    }

    messages.push({ role: 'user', content: toolResults });
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
