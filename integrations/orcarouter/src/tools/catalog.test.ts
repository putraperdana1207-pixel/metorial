import { createLocalSlateTestClient } from '@slates/test';
import { beforeEach, describe, expect, it } from 'vitest';
import { provider } from '../index';
import { type RecordedRequest, startFakeServer, withEnv } from '../testing/fake-server';
import { resetModelCatalogCache } from './list-models';

let chatModels = [
  {
    id: 'openai/gpt-5.5',
    name: 'OpenAI: GPT-5.5',
    supported_endpoint_types: ['openai', 'openai-response']
  },
  { id: 'deepseek/vision', name: 'DeepSeek: Vision', supported_endpoint_types: ['openai'] },
  { id: 'google/imagen', supported_endpoint_types: ['image-generation'] },
  { id: 'openai/sora', supported_endpoint_types: ['openai-video'] },
  { id: 'jina/rerank', supported_endpoint_types: ['jina-rerank'] },
  { id: 'vendor/unknown-route', supported_endpoint_types: ['mystery'] }
];

let detailFor = (modelId: string) => {
  if (modelId === 'deepseek/vision') {
    return {
      id: modelId,
      name: 'DeepSeek: Vision',
      context_length: 128000,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      supported_endpoint_types: ['openai'],
      pricing: { prompt_per_million: '0.2' }
    };
  }

  return {
    id: modelId,
    name: modelId,
    context_length: 400000,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    supported_endpoint_types: ['openai']
  };
};

let createFakeApi = async (options: { failModels?: number; authFail?: boolean } = {}) => {
  return await startFakeServer(request => {
    if (options.authFail) {
      return {
        status: 401,
        body: { error: { message: 'Invalid API key', type: 'orcarouter_api_error' } }
      };
    }

    if (request.path === '/v1/models' && request.method === 'GET') {
      if (options.failModels) {
        return { status: options.failModels, body: { error: { message: 'catalog down' } } };
      }

      let capability = request.query.get('capability') ?? 'chat';
      if (capability === 'embedding') {
        return {
          body: {
            data: [
              {
                id: 'openai/text-embedding-3-small',
                supported_endpoint_types: ['embeddings']
              }
            ]
          }
        };
      }
      if (capability === 'image') {
        return {
          body: {
            data: [{ id: 'google/imagen', supported_endpoint_types: ['image-generation'] }]
          }
        };
      }
      if (capability === 'video') {
        return {
          body: { data: [{ id: 'openai/sora', supported_endpoint_types: ['openai-video'] }] }
        };
      }
      if (capability === 'rerank') {
        return {
          body: { data: [{ id: 'jina/rerank', supported_endpoint_types: ['jina-rerank'] }] }
        };
      }

      return { body: { data: chatModels, object: 'list', success: true } };
    }

    if (request.path.startsWith('/v1/models/') && request.method === 'GET') {
      let modelId = decodeURIComponent(request.path.slice('/v1/models/'.length));
      return { body: detailFor(modelId) };
    }

    if (request.path === '/v1/chat/completions' && request.method === 'POST') {
      return {
        body: {
          id: 'chatcmpl-1',
          model: request.body?.model,
          created: 123,
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'hello there' }
            }
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
        }
      };
    }

    if (request.path === '/v1/embeddings' && request.method === 'POST') {
      return {
        body: {
          model: request.body?.model,
          data: [{ index: 0, embedding: [0.1, 0.2] }],
          usage: { prompt_tokens: 4, total_tokens: 4 }
        }
      };
    }

    if (request.path === '/v1/responses' && request.method === 'POST') {
      return {
        body: {
          id: 'resp-1',
          model: request.body?.model,
          status: 'completed',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: 'from responses' }] }
          ],
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 }
        }
      };
    }

    return { status: 404, body: { error: { message: `unexpected path ${request.path}` } } };
  });
};

let createToolClient = (apiUrl: string) =>
  createLocalSlateTestClient({
    slate: provider,
    state: {
      config: { apiBaseUrl: `${apiUrl}/v1` },
      auth: { authenticationMethodId: 'api_key', output: { token: 'sk-orca-test' } }
    }
  });

let listRequests = (requests: RecordedRequest[]) =>
  requests.filter(request => request.path === '/v1/models');

describe('list_models', () => {
  beforeEach(() => resetModelCatalogCache());

  it('returns only chat-compatible live models from the real catalog endpoint', async () => {
    let api = await createFakeApi();
    try {
      await withEnv({}, async () => {
        let client = createToolClient(api.url);
        let result = await client.invokeTool('list_models', {});

        expect(result.output.catalogSource).toBe('live');
        expect(result.output.degraded).toBe(false);
        expect(result.output.models.map((model: any) => model.modelId)).toEqual([
          'openai/gpt-5.5',
          'deepseek/vision'
        ]);
        expect(listRequests(api.requests)[0]?.query.get('capability')).toBe('chat');
      });
    } finally {
      await api.close();
    }
  });

  it('fails closed for image input by resolving detail metadata', async () => {
    let api = await createFakeApi();
    try {
      await withEnv({}, async () => {
        let client = createToolClient(api.url);
        let result = await client.invokeTool('list_models', { inputModality: 'image' });

        expect(result.output.models.map((model: any) => model.modelId)).toEqual([
          'deepseek/vision'
        ]);
        expect(result.output.models[0].inputModalities).toEqual(['text', 'image']);

        // The text-only chat model was hydrated and excluded.
        expect(
          result.output.models.some((model: any) => model.modelId === 'openai/gpt-5.5')
        ).toBe(false);
      });
    } finally {
      await api.close();
    }
  });

  it('uses the server-side capability filter for embedding, image, video, and rerank', async () => {
    let api = await createFakeApi();
    try {
      await withEnv({}, async () => {
        let client = createToolClient(api.url);

        for (let [capability, expected] of [
          ['embedding', 'openai/text-embedding-3-small'],
          ['image', 'google/imagen'],
          ['video', 'openai/sora'],
          ['rerank', 'jina/rerank']
        ] as const) {
          let result = await client.invokeTool('list_models', { capability });
          expect(result.output.models.map((model: any) => model.modelId)).toEqual([expected]);
        }
      });
    } finally {
      await api.close();
    }
  });

  it('falls back to the labelled verified seed when discovery fails transiently', async () => {
    let api = await createFakeApi({ failModels: 503 });
    try {
      await withEnv({}, async () => {
        let client = createToolClient(api.url);
        let result = await client.invokeTool('list_models', {});

        expect(result.output.catalogSource).toBe('verified_fallback');
        expect(result.output.degraded).toBe(true);
        expect(result.output.note).toMatch(/Live OrcaRouter model discovery failed/);
        expect(
          result.output.models.every(
            (model: any) => model.catalogSource === 'verified_fallback'
          )
        ).toBe(true);
        expect(result.output.models.map((model: any) => model.modelId)).not.toContain(
          'deepseek/vision'
        );
        expect(
          result.output.models.find((model: any) => model.modelId === 'openai/gpt-5.5')
            ?.reasoningEfforts
        ).toEqual(['low', 'medium', 'high', 'xhigh']);
      });
    } finally {
      await api.close();
    }
  });

  it('surfaces an invalid credential instead of hiding it behind the fallback', async () => {
    let api = await createFakeApi({ authFail: true });
    try {
      await withEnv({}, async () => {
        let client = createToolClient(api.url);

        await expect(client.invokeTool('list_models', {})).rejects.toThrow(/reconnect/i);
      });
    } finally {
      await api.close();
    }
  });

  it('caches the catalog and refreshes on demand', async () => {
    let api = await createFakeApi();
    try {
      await withEnv({}, async () => {
        let client = createToolClient(api.url);

        await client.invokeTool('list_models', {});
        await client.invokeTool('list_models', {});
        expect(listRequests(api.requests)).toHaveLength(1);

        await client.invokeTool('list_models', { refresh: true });
        expect(listRequests(api.requests)).toHaveLength(2);
      });
    } finally {
      await api.close();
    }
  });

  it('applies search and maxResults without changing the total count', async () => {
    let api = await createFakeApi();
    try {
      await withEnv({}, async () => {
        let client = createToolClient(api.url);

        let limited = await client.invokeTool('list_models', { maxResults: 1 });
        expect(limited.output.totalCount).toBe(2);
        expect(limited.output.models).toHaveLength(1);

        let searched = await client.invokeTool('list_models', { search: 'vision' });
        expect(searched.output.models.map((model: any) => model.modelId)).toEqual([
          'deepseek/vision'
        ]);
      });
    } finally {
      await api.close();
    }
  });
});

describe('get_model', () => {
  it('returns live capability metadata for one model', async () => {
    let api = await createFakeApi();
    try {
      await withEnv({}, async () => {
        let client = createToolClient(api.url);
        let result = await client.invokeTool('get_model', { modelId: 'deepseek/vision' });

        expect(result.output.model).toMatchObject({
          modelId: 'deepseek/vision',
          contextLength: 128000,
          inputModalities: ['text', 'image'],
          catalogSource: 'live'
        });
      });
    } finally {
      await api.close();
    }
  });
});

describe('send_chat_completion', () => {
  it('sends a text completion through the OpenAI-compatible endpoint', async () => {
    let api = await createFakeApi();
    try {
      await withEnv({}, async () => {
        let client = createToolClient(api.url);
        let result = await client.invokeTool('send_chat_completion', {
          model: 'openai/gpt-5.5',
          messages: [{ role: 'user', content: 'hi' }]
        });

        expect(result.output.choices[0].message.content).toBe('hello there');
        expect(result.output.usage).toEqual({
          promptTokens: 3,
          completionTokens: 2,
          totalTokens: 5
        });

        let request = api.requests.find(entry => entry.path === '/v1/chat/completions');
        expect(request?.headers.authorization).toBe('Bearer sk-orca-test');
        expect(request?.body.messages).toEqual([{ role: 'user', content: 'hi' }]);
      });
    } finally {
      await api.close();
    }
  });

  it('sends image content parts to a model that declares image input', async () => {
    let api = await createFakeApi();
    try {
      await withEnv({}, async () => {
        let client = createToolClient(api.url);
        let result = await client.invokeTool('send_chat_completion', {
          model: 'deepseek/vision',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'what is this?' },
                { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }
              ]
            }
          ]
        });

        expect(result.output.id).toBe('chatcmpl-1');
        expect(api.requests.some(entry => entry.path === '/v1/models/deepseek/vision')).toBe(
          true
        );
      });
    } finally {
      await api.close();
    }
  });

  it('refuses image input for a model that does not declare it, before sending', async () => {
    let api = await createFakeApi();
    try {
      await withEnv({}, async () => {
        let client = createToolClient(api.url);

        await expect(
          client.invokeTool('send_chat_completion', {
            model: 'openai/gpt-5.5',
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }
                ]
              }
            ]
          })
        ).rejects.toThrow(/does not declare image input/);

        expect(api.requests.some(entry => entry.path === '/v1/chat/completions')).toBe(false);
      });
    } finally {
      await api.close();
    }
  });
});

describe('create_embedding and create_response', () => {
  it('maps embeddings from the OpenAI-compatible response', async () => {
    let api = await createFakeApi();
    try {
      await withEnv({}, async () => {
        let client = createToolClient(api.url);
        let result = await client.invokeTool('create_embedding', {
          model: 'openai/text-embedding-3-small',
          input: ['a', 'b']
        });

        expect(result.output.embeddings).toEqual([{ index: 0, embedding: [0.1, 0.2] }]);
        expect(result.output.usage).toEqual({ promptTokens: 4, totalTokens: 4 });
      });
    } finally {
      await api.close();
    }
  });

  it('maps the Responses API output text', async () => {
    let api = await createFakeApi();
    try {
      await withEnv({}, async () => {
        let client = createToolClient(api.url);
        let result = await client.invokeTool('create_response', {
          model: 'openai/gpt-5.5',
          input: 'hello'
        });

        expect(result.output).toMatchObject({
          id: 'resp-1',
          status: 'completed',
          outputText: 'from responses'
        });
      });
    } finally {
      await api.close();
    }
  });
});
