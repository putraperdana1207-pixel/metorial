import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildFallbackCatalog,
  clearCatalogCache,
  filterByCapability,
  filterByInputModality,
  normalizeModel,
  type OrcaModel,
  readCachedCatalog,
  VERIFIED_FALLBACK_MODELS,
  writeCachedCatalog
} from './models';

let model = (overrides: Partial<OrcaModel> & { modelId: string }): OrcaModel => ({
  catalogSource: 'live',
  ...overrides
});

describe('normalizeModel', () => {
  it('keeps the vendor namespace and reads live detail metadata', () => {
    let normalized = normalizeModel({
      id: 'deepseek/deepseek-v4-flash-vision-exp',
      name: 'DeepSeek: V4 Flash Vision',
      owned_by: 'DeepSeek',
      context_length: 1048576,
      max_completion_tokens: 384000,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      supported_endpoint_types: ['openai', 'anthropic'],
      supported_parameters: ['tools', 'temperature'],
      pricing: { prompt: '0.0000002', completion_per_million: '0.66' }
    });

    expect(normalized).toMatchObject({
      modelId: 'deepseek/deepseek-v4-flash-vision-exp',
      ownedBy: 'DeepSeek',
      contextLength: 1048576,
      maxCompletionTokens: 384000,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      supportedEndpointTypes: ['openai', 'anthropic'],
      supportedParameters: ['tools', 'temperature'],
      catalogSource: 'live'
    });
    expect(normalized?.pricing).toEqual({
      prompt: '0.0000002',
      completionPerMillion: '0.66'
    });
  });

  it('rejects records without a usable model id', () => {
    expect(normalizeModel({ name: 'Missing id' })).toBeNull();
    expect(normalizeModel({ id: '' })).toBeNull();
    expect(normalizeModel(null)).toBeNull();
  });

  it('drops non-string endpoint and modality entries instead of guessing', () => {
    let normalized = normalizeModel({
      id: 'openai/gpt-5.5',
      supported_endpoint_types: ['openai', 42],
      architecture: { input_modalities: ['text', null] }
    });

    expect(normalized?.supportedEndpointTypes).toBeUndefined();
    expect(normalized?.inputModalities).toBeUndefined();
  });
});

describe('capability filtering', () => {
  let models = [
    model({
      modelId: 'openai/gpt-5.5',
      supportedEndpointTypes: ['openai', 'openai-response']
    }),
    model({ modelId: 'anthropic/claude-opus-4.8', supportedEndpointTypes: ['anthropic'] }),
    model({ modelId: 'google/imagen', supportedEndpointTypes: ['image-generation'] }),
    model({ modelId: 'openai/sora', supportedEndpointTypes: ['openai-video'] }),
    model({ modelId: 'jina/rerank', supportedEndpointTypes: ['jina-rerank'] }),
    model({
      modelId: 'openai/text-embedding-3-small',
      supportedEndpointTypes: ['embeddings']
    }),
    model({ modelId: 'vendor/unknown-route', supportedEndpointTypes: ['mystery'] })
  ];

  it('keeps only text-capable chat endpoints and excludes non-text routes', () => {
    let chat = filterByCapability(models, 'chat').map(entry => entry.modelId);

    expect(chat).toEqual(['openai/gpt-5.5', 'anthropic/claude-opus-4.8']);
  });

  it('filters embedding, image, video, and rerank strictly', () => {
    expect(filterByCapability(models, 'embedding').map(entry => entry.modelId)).toEqual([
      'openai/text-embedding-3-small'
    ]);
    expect(filterByCapability(models, 'image').map(entry => entry.modelId)).toEqual([
      'google/imagen'
    ]);
    expect(filterByCapability(models, 'video').map(entry => entry.modelId)).toEqual([
      'openai/sora'
    ]);
    expect(filterByCapability(models, 'rerank').map(entry => entry.modelId)).toEqual([
      'jina/rerank'
    ]);
  });

  it('accepts server-filtered records that omit endpoint metadata only where the API already filtered', () => {
    let withoutEndpoints = [model({ modelId: 'openai/text-embedding-3-large' })];
    expect(filterByCapability(withoutEndpoints, 'embedding')).toHaveLength(1);
    expect(filterByCapability(withoutEndpoints, 'video')).toHaveLength(0);
    expect(filterByCapability(withoutEndpoints, 'rerank')).toHaveLength(0);
  });
});

describe('input modality filtering', () => {
  it('fails closed when a model does not declare the modality', () => {
    let models = [
      model({ modelId: 'text/only', inputModalities: ['text'] }),
      model({ modelId: 'vision/declared', inputModalities: ['text', 'image'] }),
      model({ modelId: 'vision/undeclared' })
    ];

    expect(filterByInputModality(models, 'image').map(entry => entry.modelId)).toEqual([
      'vision/declared'
    ]);
  });
});

describe('verified fallback catalog', () => {
  it('labels every fallback entry and keeps reasoning metadata', () => {
    let fallback = buildFallbackCatalog('chat');

    expect(fallback.catalogSource).toBe('verified_fallback');
    expect(fallback.degraded).toBe(true);
    expect(fallback.note).toBeTruthy();
    expect(fallback.models.map(entry => entry.modelId).sort()).toEqual(
      VERIFIED_FALLBACK_MODELS.map(entry => entry.modelId).sort()
    );
    expect(fallback.models.every(entry => entry.catalogSource === 'verified_fallback')).toBe(
      true
    );

    let gpt = fallback.models.find(entry => entry.modelId === 'openai/gpt-5.5');
    expect(gpt?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(gpt?.inputModalities).toEqual(['text']);
  });

  it('never offers fallback entries for capabilities without a verified seed', () => {
    expect(buildFallbackCatalog('embedding').models).toEqual([]);
    expect(buildFallbackCatalog('rerank').models).toEqual([]);
  });

  it('applies the requested modality to the fallback too', () => {
    let image = buildFallbackCatalog('chat', 'image');
    expect(image.models.map(entry => entry.modelId).sort()).toEqual([
      'anthropic/claude-opus-4.8',
      'google/gemini-3.5-flash'
    ]);
  });
});

describe('catalog cache', () => {
  beforeEach(() => clearCatalogCache());

  it('returns entries until the TTL elapses', () => {
    writeCachedCatalog('key', [model({ modelId: 'openai/gpt-5.5' })], 1000);

    expect(readCachedCatalog('key', 2000)).toHaveLength(1);
    expect(readCachedCatalog('key', 1000 + 60_001)).toBeUndefined();
  });
});
