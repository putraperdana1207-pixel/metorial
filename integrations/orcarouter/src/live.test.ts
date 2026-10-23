import { createLocalSlateTestClient } from '@slates/test';
import { describe, expect, it } from 'vitest';
import { provider } from './index';

let apiKey = process.env.ORCAROUTER_API_KEY;

/**
 * Live checks against the public OrcaRouter API. They only run when a real
 * key is present in the environment; CI without credentials skips them so the
 * deterministic suite stays hermetic. The key is read from the environment and
 * never printed.
 */
describe.skipIf(!apiKey)('live OrcaRouter API', () => {
  let createClient = () =>
    createLocalSlateTestClient({
      slate: provider,
      state: {
        config: {},
        auth: { authenticationMethodId: 'api_key', output: { token: apiKey! } }
      }
    });

  it('discovers the live catalog and a text model', async () => {
    let client = createClient();
    let result = await client.invokeTool('list_models', {
      capability: 'chat',
      maxResults: 10
    });

    expect(result.output.catalogSource).toBe('live');
    expect(result.output.degraded).toBe(false);
    expect(result.output.totalCount).toBeGreaterThan(0);
    expect(result.output.models.length).toBeGreaterThan(0);
  }, 120_000);

  it('sends a real chat completion through the implemented provider', async () => {
    let client = createClient();
    let catalog = await client.invokeTool('list_models', {
      capability: 'chat',
      maxResults: 50
    });
    let modelId =
      catalog.output.models.find(
        (model: any) => model.modelId === 'deepseek/deepseek-v4-flash'
      )?.modelId ?? catalog.output.models[0]?.modelId;

    expect(modelId).toBeTruthy();

    let result = await client.invokeTool('send_chat_completion', {
      model: modelId,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      maxCompletionTokens: 16
    });

    expect(result.output.choices.length).toBeGreaterThan(0);
  }, 120_000);
});
