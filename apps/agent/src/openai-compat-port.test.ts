import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatLlmPort } from './openai-compat-port.js';
import { makeLlmFromEnv } from './llm-factory.js';
import type { LlmMessage, LlmToolDef, LlmTurnRequest } from './llm-port.js';

const TOOLS: ReadonlyArray<LlmToolDef> = [
  {
    name: 'quote_providers',
    description: 'Quote providers for a task.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        budget_ceiling_usd: { type: 'number' },
      },
      required: ['task_id', 'budget_ceiling_usd'],
    },
  },
];

const makeMockFetch = (chatJson: unknown, status = 200) => {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit): Promise<Response> =>
      new Response(JSON.stringify(chatJson), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  return fetchMock;
};

describe('OpenAICompatLlmPort', () => {
  it('translates outbound request: system prompt, tools as functions, user text', async () => {
    const fetchMock = makeMockFetch({
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 42, completion_tokens: 7 },
    });
    const port = new OpenAICompatLlmPort({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test-model',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const req: LlmTurnRequest = {
      systemPrompt: 'you are a test',
      tools: TOOLS,
      messages: [{ role: 'user', kind: 'text', text: 'hello' }],
      maxTokens: 1000,
    };
    const out = await port.turn(req);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:1234/v1/chat/completions');
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body['model']).toBe('test-model');
    expect(body['max_tokens']).toBe(1000);
    const messages = body['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'system', content: 'you are a test' });
    expect(messages[1]).toEqual({ role: 'user', content: 'hello' });
    const tools = body['tools'] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      type: 'function',
      function: {
        name: 'quote_providers',
        description: 'Quote providers for a task.',
        parameters: {
          type: 'object',
          required: ['task_id', 'budget_ceiling_usd'],
        },
      },
    });

    expect(out.stop_reason).toBe('end_turn');
    expect(out.text).toBe('ok');
    expect(out.tool_calls).toEqual([]);
    expect(out.usage.input_tokens).toBe(42);
    expect(out.usage.output_tokens).toBe(7);
  });

  it('parses tool_calls and JSON-decodes arguments into input', async () => {
    const fetchMock = makeMockFetch({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_abc',
                type: 'function',
                function: {
                  name: 'quote_providers',
                  arguments:
                    '{"task_id":"task_01J0000000000000000000000A","budget_ceiling_usd":200}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
    const port = new OpenAICompatLlmPort({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test-model',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const out = await port.turn({
      systemPrompt: 's',
      tools: TOOLS,
      messages: [{ role: 'user', kind: 'text', text: 'go' }],
      maxTokens: 512,
    });
    expect(out.stop_reason).toBe('tool_use');
    expect(out.tool_calls).toHaveLength(1);
    expect(out.tool_calls[0]!.id).toBe('call_abc');
    expect(out.tool_calls[0]!.name).toBe('quote_providers');
    expect(out.tool_calls[0]!.input).toEqual({
      task_id: 'task_01J0000000000000000000000A',
      budget_ceiling_usd: 200,
    });
  });

  it('maps stop=stop with tool_calls present as tool_use (lenient backend)', async () => {
    const fetchMock = makeMockFetch({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'quote_providers', arguments: '{}' },
              },
            ],
          },
          finish_reason: 'stop',
        },
      ],
    });
    const port = new OpenAICompatLlmPort({
      baseUrl: 'http://localhost:1234/v1',
      model: 'm',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const out = await port.turn({
      systemPrompt: 's',
      tools: TOOLS,
      messages: [{ role: 'user', kind: 'text', text: '.' }],
      maxTokens: 100,
    });
    expect(out.stop_reason).toBe('tool_use');
  });

  it('maps content_filter to refusal and length to max_tokens', async () => {
    for (const [finish, expected] of [
      ['content_filter', 'refusal'],
      ['length', 'max_tokens'],
    ] as const) {
      const fetchMock = makeMockFetch({
        choices: [
          { index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: finish },
        ],
      });
      const port = new OpenAICompatLlmPort({
        baseUrl: 'http://localhost:1234/v1',
        model: 'm',
        fetchImpl: fetchMock as unknown as typeof fetch,
      });
      const out = await port.turn({
        systemPrompt: 's',
        tools: TOOLS,
        messages: [{ role: 'user', kind: 'text', text: '.' }],
        maxTokens: 100,
      });
      expect(out.stop_reason).toBe(expected);
    }
  });

  it('expands tool_results to N role=tool messages, one per result', async () => {
    const fetchMock = makeMockFetch({
      choices: [
        { index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' },
      ],
    });
    const port = new OpenAICompatLlmPort({
      baseUrl: 'http://localhost:1234/v1',
      model: 'm',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const messages: LlmMessage[] = [
      { role: 'user', kind: 'text', text: 'start' },
      {
        role: 'assistant',
        text: '',
        tool_calls: [
          { id: 'c1', name: 'quote_providers', input: { task_id: 'task_01J0' } },
          { id: 'c2', name: 'quote_providers', input: { task_id: 'task_02J0' } },
        ],
      },
      {
        role: 'user',
        kind: 'tool_results',
        results: [
          { tool_use_id: 'c1', content: '{"ok":true}', is_error: false },
          { tool_use_id: 'c2', content: '{"ok":false}', is_error: true },
        ],
      },
    ];

    await port.turn({ systemPrompt: 's', tools: TOOLS, messages, maxTokens: 100 });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    const chat = body['messages'] as Array<Record<string, unknown>>;
    expect(chat).toHaveLength(5);
    expect(chat[0]!['role']).toBe('system');
    expect(chat[1]!['role']).toBe('user');
    expect(chat[2]!['role']).toBe('assistant');
    expect((chat[2]!['tool_calls'] as Array<{ id: string }>)[0]!.id).toBe('c1');
    expect(chat[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' });
    expect(chat[4]).toEqual({
      role: 'tool',
      tool_call_id: 'c2',
      content: '[error] {"ok":false}',
    });
  });

  it('throws a useful error on non-2xx response', async () => {
    const fetchMock = vi.fn(async () => new Response('model not loaded', { status: 503 }));
    const port = new OpenAICompatLlmPort({
      baseUrl: 'http://localhost:1234/v1',
      model: 'm',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(
      port.turn({
        systemPrompt: 's',
        tools: TOOLS,
        messages: [{ role: 'user', kind: 'text', text: '.' }],
        maxTokens: 100,
      }),
    ).rejects.toThrow(/openai-compat backend 503/);
  });

  it('sends Authorization header when apiKey provided', async () => {
    const fetchMock = makeMockFetch({
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    });
    const port = new OpenAICompatLlmPort({
      baseUrl: 'http://localhost:1234/v1',
      model: 'm',
      apiKey: 'sk-test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await port.turn({
      systemPrompt: 's',
      tools: TOOLS,
      messages: [{ role: 'user', kind: 'text', text: '.' }],
      maxTokens: 100,
    });
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test');
  });
});

describe('makeLlmFromEnv', () => {
  it('builds an Anthropic port by default', () => {
    const llm = makeLlmFromEnv({ env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
    expect(llm.name).toBe('anthropic');
  });

  it('builds an OpenAI-compat port pointed at LM Studio defaults', () => {
    const llm = makeLlmFromEnv({
      env: {
        LLM_BACKEND: 'openai_compat',
        OPENAI_COMPAT_MODEL: 'qwen2.5-coder-32b-instruct',
      },
    });
    expect(llm.name).toBe('openai_compat');
    expect(llm.model).toBe('qwen2.5-coder-32b-instruct');
  });

  it('refuses to build openai_compat without a model id', () => {
    expect(() => makeLlmFromEnv({ env: { LLM_BACKEND: 'openai_compat' } })).toThrow(
      /OPENAI_COMPAT_MODEL is required/,
    );
  });
});
