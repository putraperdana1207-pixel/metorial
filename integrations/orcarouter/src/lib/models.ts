export type OrcaCapability = 'chat' | 'embedding' | 'image' | 'video' | 'rerank';

export type OrcaInputModality = 'text' | 'image' | 'audio' | 'video';

export type OrcaModelPricing = {
  prompt?: string;
  completion?: string;
  promptPerMillion?: string;
  completionPerMillion?: string;
};

export type OrcaModel = {
  modelId: string;
  name?: string;
  ownedBy?: string;
  contextLength?: number;
  maxCompletionTokens?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  supportedEndpointTypes?: string[];
  endpointCapabilities?: string[];
  supportedParameters?: string[];
  reasoningEfforts?: string[];
  pricing?: OrcaModelPricing;
  catalogSource: 'live' | 'verified_fallback';
};

export type ModelCatalogResult = {
  models: OrcaModel[];
  totalCount: number;
  catalogSource: 'live' | 'verified_fallback';
  degraded: boolean;
  note?: string;
};

export const CHAT_ENDPOINT_TYPES = [
  'openai',
  'anthropic',
  'gemini',
  'openai-response'
] as const;

export const NON_TEXT_ENDPOINT_TYPES = [
  'image-generation',
  'openai-video',
  'jina-rerank',
  'embeddings'
] as const;

let isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

let readString = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
let readNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
let readStringArray = (value: unknown) =>
  Array.isArray(value) && value.every(item => typeof item === 'string')
    ? (value as string[])
    : undefined;

/**
 * Normalizes one record from `GET /v1/models`. Records without a string `id`
 * are rejected so a malformed catalog cannot produce unusable model entries.
 */
export let normalizeModel = (
  raw: unknown,
  catalogSource: OrcaModel['catalogSource'] = 'live'
): OrcaModel | null => {
  if (!isRecord(raw)) return null;

  let modelId = readString(raw.id);
  if (!modelId) return null;

  let architecture = isRecord(raw.architecture) ? raw.architecture : undefined;
  let pricing = isRecord(raw.pricing) ? raw.pricing : undefined;

  let normalized: OrcaModel = {
    modelId,
    catalogSource
  };

  let name = readString(raw.name);
  if (name) normalized.name = name;

  let ownedBy = readString(raw.owned_by);
  if (ownedBy) normalized.ownedBy = ownedBy;

  let contextLength = readNumber(raw.context_length);
  if (contextLength !== undefined) normalized.contextLength = contextLength;

  let maxCompletionTokens = readNumber(raw.max_completion_tokens);
  if (maxCompletionTokens !== undefined) normalized.maxCompletionTokens = maxCompletionTokens;

  let inputModalities = readStringArray(architecture?.input_modalities);
  if (inputModalities) normalized.inputModalities = inputModalities;

  let outputModalities = readStringArray(architecture?.output_modalities);
  if (outputModalities) normalized.outputModalities = outputModalities;

  let supportedEndpointTypes = readStringArray(raw.supported_endpoint_types);
  if (supportedEndpointTypes) normalized.supportedEndpointTypes = supportedEndpointTypes;

  let endpointCapabilities = readStringArray(raw.endpoint_capabilities);
  if (endpointCapabilities) normalized.endpointCapabilities = endpointCapabilities;

  let supportedParameters = readStringArray(raw.supported_parameters);
  if (supportedParameters) normalized.supportedParameters = supportedParameters;

  if (pricing) {
    let normalizedPricing: OrcaModelPricing = {};
    let prompt = readString(pricing.prompt);
    let completion = readString(pricing.completion);
    let promptPerMillion = readString(pricing.prompt_per_million);
    let completionPerMillion = readString(pricing.completion_per_million);

    if (prompt) normalizedPricing.prompt = prompt;
    if (completion) normalizedPricing.completion = completion;
    if (promptPerMillion) normalizedPricing.promptPerMillion = promptPerMillion;
    if (completionPerMillion) normalizedPricing.completionPerMillion = completionPerMillion;

    if (Object.keys(normalizedPricing).length > 0) normalized.pricing = normalizedPricing;
  }

  return normalized;
};

let endpointTypes = (model: OrcaModel) => model.supportedEndpointTypes ?? [];

/**
 * Capability filters. Chat requires at least one text-capable endpoint type and
 * rejects models that only advertise non-text routes. Embedding/image accept a
 * missing endpoint list because the live request already used the matching
 * `capability` query parameter; video and rerank are strict.
 */
export let isCapabilityCompatible = (model: OrcaModel, capability: OrcaCapability) => {
  let types = endpointTypes(model);
  let hasType = (type: string) => types.includes(type);

  switch (capability) {
    case 'chat': {
      if (!types.some(type => (CHAT_ENDPOINT_TYPES as readonly string[]).includes(type))) {
        return false;
      }

      return !types.every(type =>
        (NON_TEXT_ENDPOINT_TYPES as readonly string[]).includes(type)
      );
    }
    case 'embedding':
      return types.length === 0 || hasType('embeddings');
    case 'image':
      return types.length === 0 || hasType('image-generation');
    case 'video':
      return hasType('openai-video');
    case 'rerank':
      return hasType('jina-rerank');
    default:
      return false;
  }
};

export let filterByCapability = (models: OrcaModel[], capability: OrcaCapability) =>
  models.filter(model => isCapabilityCompatible(model, capability));

/**
 * Multimodal entries fail closed: a model is only listed when it explicitly
 * declares the requested non-text input modality.
 */
export let filterByInputModality = (models: OrcaModel[], modality: OrcaInputModality) =>
  models.filter(model => (model.inputModalities ?? []).includes(modality));

export let hasImageInput = (content: unknown) => {
  if (typeof content === 'string') return false;
  if (!Array.isArray(content)) return false;

  return content.some(part => {
    if (!isRecord(part)) return false;
    let type = readString(part.type);
    return type === 'image_url' || type === 'input_image' || type === 'image';
  });
};

export let modelSupportsImageInput = (model: OrcaModel) =>
  (model.inputModalities ?? []).includes('image');

/**
 * Small, hand-verified cold-start catalog. It is only served when live
 * discovery fails transiently, and it is always labelled as a fallback so a
 * caller never mistakes it for the authoritative catalog.
 */
export const VERIFIED_FALLBACK_MODELS: OrcaModel[] = [
  {
    modelId: 'openai/gpt-5.5',
    name: 'OpenAI: GPT-5.5',
    ownedBy: 'OpenAI',
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportedEndpointTypes: ['openai', 'openai-response', 'anthropic'],
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    catalogSource: 'verified_fallback'
  },
  {
    modelId: 'anthropic/claude-opus-4.8',
    name: 'Anthropic: Claude Opus 4.8',
    ownedBy: 'Anthropic',
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    supportedEndpointTypes: ['anthropic', 'openai'],
    catalogSource: 'verified_fallback'
  },
  {
    modelId: 'google/gemini-3.5-flash',
    name: 'Google: Gemini 3.5 Flash',
    ownedBy: 'Google',
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    supportedEndpointTypes: ['gemini', 'openai'],
    catalogSource: 'verified_fallback'
  },
  {
    modelId: 'deepseek/deepseek-v4-pro',
    name: 'DeepSeek: DeepSeek V4 Pro',
    ownedBy: 'DeepSeek',
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportedEndpointTypes: ['openai', 'anthropic'],
    catalogSource: 'verified_fallback'
  },
  {
    modelId: 'orcarouter/auto',
    name: 'OrcaRouter: Auto',
    ownedBy: 'OrcaRouter',
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportedEndpointTypes: ['openai', 'openai-response', 'anthropic', 'gemini'],
    catalogSource: 'verified_fallback'
  }
];

let catalogCache = new Map<string, { at: number; models: OrcaModel[] }>();
const CACHE_TTL_MS = 60_000;

export let readCachedCatalog = (cacheKey: string, now = Date.now()) => {
  let entry = catalogCache.get(cacheKey);
  if (!entry) return undefined;
  if (now - entry.at > CACHE_TTL_MS) {
    catalogCache.delete(cacheKey);
    return undefined;
  }

  return entry.models;
};

export let writeCachedCatalog = (cacheKey: string, models: OrcaModel[], now = Date.now()) => {
  catalogCache.set(cacheKey, { at: now, models });
};

export let clearCatalogCache = () => catalogCache.clear();

export let buildFallbackCatalog = (
  capability: OrcaCapability,
  inputModality?: OrcaInputModality
): ModelCatalogResult => {
  let models = filterByCapability(VERIFIED_FALLBACK_MODELS, capability);
  if (inputModality) {
    models = filterByInputModality(models, inputModality);
  }

  return {
    models,
    totalCount: models.length,
    catalogSource: 'verified_fallback',
    degraded: true,
    note:
      'Live OrcaRouter model discovery failed. Showing the small verified fallback catalog; ' +
      'refresh once the API is reachable to see every model this workspace can call.'
  };
};

/**
 * Applies the chat filter, then resolves detail metadata for multimodal
 * entries. Detail lookups are bounded and fail closed: a model whose metadata
 * cannot be read is not offered for a non-text input.
 */
export let filterCatalog = (
  models: OrcaModel[],
  capability: OrcaCapability,
  inputModality?: OrcaInputModality
) => {
  let filtered = filterByCapability(models, capability);

  if (!inputModality || inputModality === 'text') {
    return filtered;
  }

  return filterByInputModality(filtered, inputModality);
};
