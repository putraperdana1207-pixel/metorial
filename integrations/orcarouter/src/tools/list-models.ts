import { SlateTool } from 'slates';
import { z } from 'zod';
import { Client } from '../lib/client';
import { resolveOrigins } from '../lib/env';
import { isTransientCatalogError, orcaServiceError } from '../lib/errors';
import {
  buildFallbackCatalog,
  clearCatalogCache,
  filterByCapability,
  filterByInputModality,
  type ModelCatalogResult,
  normalizeModel,
  type OrcaCapability,
  type OrcaInputModality,
  type OrcaModel,
  readCachedCatalog,
  writeCachedCatalog
} from '../lib/models';
import { spec } from '../spec';

const MAX_DETAIL_LOOKUPS = 40;
const DETAIL_CONCURRENCY = 6;

export let modelSchema = z.object({
  modelId: z
    .string()
    .describe('Model identifier with its vendor namespace, e.g. "openai/gpt-5.5"'),
  name: z.string().optional().describe('Human-readable model name'),
  ownedBy: z.string().optional().describe('Vendor that owns the model'),
  contextLength: z.number().optional().describe('Maximum context window in tokens'),
  maxCompletionTokens: z.number().optional().describe('Maximum output tokens'),
  inputModalities: z
    .array(z.string())
    .optional()
    .describe('Declared input modalities. Absent means the catalog did not declare them.'),
  outputModalities: z.array(z.string()).optional().describe('Declared output modalities'),
  supportedEndpointTypes: z
    .array(z.string())
    .optional()
    .describe('Wire protocols the model can be served with (openai, anthropic, gemini, …)'),
  endpointCapabilities: z
    .array(z.string())
    .optional()
    .describe('Endpoint capabilities reported by OrcaRouter'),
  supportedParameters: z
    .array(z.string())
    .optional()
    .describe('Request parameters the model accepts'),
  reasoningEfforts: z
    .array(z.string())
    .optional()
    .describe('Reasoning effort levels, when the catalog declares them'),
  pricing: z
    .object({
      prompt: z.string().optional().describe('Cost per prompt token'),
      completion: z.string().optional().describe('Cost per completion token'),
      promptPerMillion: z.string().optional().describe('Cost per million prompt tokens'),
      completionPerMillion: z
        .string()
        .optional()
        .describe('Cost per million completion tokens')
    })
    .optional()
    .describe('Pricing metadata'),
  catalogSource: z
    .enum(['live', 'verified_fallback'])
    .describe('Whether this entry came from the live catalog or the verified fallback')
});

let toModelOutput = (model: OrcaModel) => ({
  ...model,
  pricing: model.pricing,
  catalogSource: model.catalogSource
});

/**
 * Resolves catalog entries that are missing architecture metadata so a
 * multimodal filter can be applied honestly. Lookups are bounded; a model
 * whose detail request fails keeps no modalities and is therefore excluded.
 */
let hydrateInputModalities = async (client: Client, models: OrcaModel[]) => {
  let candidates = models.filter(model => !model.inputModalities).slice(0, MAX_DETAIL_LOOKUPS);

  for (let index = 0; index < candidates.length; index += DETAIL_CONCURRENCY) {
    let batch = candidates.slice(index, index + DETAIL_CONCURRENCY);

    await Promise.all(
      batch.map(async model => {
        try {
          let detail = await client.getModel(model.modelId);
          let normalized = normalizeModel(detail, 'live');
          if (normalized?.inputModalities) {
            model.inputModalities = normalized.inputModalities;
          }
          if (normalized?.supportedEndpointTypes) {
            model.supportedEndpointTypes = normalized.supportedEndpointTypes;
          }
        } catch {
          // Fail closed: unknown metadata never qualifies for a non-text
          // modality filter.
        }
      })
    );
  }

  return models;
};

let loadCatalog = async (d: {
  client: Client;
  cacheKey: string;
  capability: OrcaCapability;
  inputModality?: OrcaInputModality;
  refresh?: boolean;
}): Promise<ModelCatalogResult> => {
  let cached = d.refresh ? undefined : readCachedCatalog(d.cacheKey);
  if (cached) {
    let models = filterByCapability(cached, d.capability);
    if (d.inputModality && d.inputModality !== 'text') {
      models = await hydrateInputModalities(d.client, models);
      models = filterByInputModality(models, d.inputModality);
    }

    return {
      models,
      totalCount: models.length,
      catalogSource: 'live',
      degraded: false
    };
  }

  try {
    let raw = await d.client.listModels({ capability: d.capability });
    let models = raw
      .map(entry => normalizeModel(entry, 'live'))
      .filter((entry): entry is OrcaModel => entry !== null);

    writeCachedCatalog(d.cacheKey, models);

    let filtered = filterByCapability(models, d.capability);
    if (d.inputModality && d.inputModality !== 'text') {
      filtered = await hydrateInputModalities(d.client, filtered);
      filtered = filterByCapability(filtered, d.capability);
      filtered = filterByInputModality(filtered, d.inputModality);
    }

    return {
      models: filtered,
      totalCount: filtered.length,
      catalogSource: 'live',
      degraded: false
    };
  } catch (error) {
    if (!isTransientCatalogError(error)) {
      throw error;
    }

    return buildFallbackCatalog(d.capability, d.inputModality);
  }
};

export let listModels = SlateTool.create(spec, {
  name: 'List Models',
  key: 'list_models',
  description: `List the models this OrcaRouter workspace can call. The catalog comes from OrcaRouter's live GET /v1/models endpoint and can be filtered by capability (chat, embedding, image, video, rerank) and by the input modality a request will send. Use it to pick a model ID before sending a completion or embedding request.`,
  instructions: [
    'Call this tool before choosing a model; IDs keep their vendor namespace such as "openai/gpt-5.5" or "orcarouter/auto".',
    'Set inputModality when the request will include an image, audio, or video part. Only models that explicitly declare that modality are returned.',
    'A result with catalogSource "verified_fallback" means live discovery failed; it is a small verified seed, not the full catalog.'
  ],
  tags: {
    readOnly: true
  }
})
  .input(
    z.object({
      capability: z
        .enum(['chat', 'embedding', 'image', 'video', 'rerank'])
        .optional()
        .describe('Capability to list models for (default: chat)'),
      inputModality: z
        .enum(['text', 'image', 'audio', 'video'])
        .optional()
        .describe(
          'Required input modality. Non-text values are enforced strictly against declared model metadata.'
        ),
      search: z
        .string()
        .optional()
        .describe('Case-insensitive filter over model ID and display name'),
      maxResults: z
        .number()
        .min(1)
        .max(200)
        .optional()
        .describe('Maximum entries to return (default: 50)'),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass the short-lived catalog cache and force a fresh discovery request')
    })
  )
  .output(
    z.object({
      models: z
        .array(modelSchema)
        .describe('Models matching the requested capability and modality'),
      totalCount: z
        .number()
        .describe('Number of matching models before maxResults is applied'),
      catalogSource: z
        .enum(['live', 'verified_fallback'])
        .describe('Authoritative live catalog, or the degraded verified fallback'),
      degraded: z
        .boolean()
        .describe('True when live discovery failed and a fallback was served'),
      note: z.string().optional().describe('Human-readable discovery status')
    })
  )
  .handleInvocation(async ctx => {
    let capability = (ctx.input.capability ?? 'chat') as OrcaCapability;
    let inputModality = ctx.input.inputModality as OrcaInputModality | undefined;
    let origins = resolveOrigins({
      authBaseUrl: ctx.config.authBaseUrl,
      apiBaseUrl: ctx.config.apiBaseUrl
    });

    let client = new Client({ token: ctx.auth.token, apiBaseUrl: origins.apiBaseUrl });
    let cacheKey = `${origins.apiBaseUrl}|${capability}|${inputModality ?? 'any'}`;

    let catalog = await loadCatalog({
      client,
      cacheKey,
      capability,
      inputModality,
      refresh: ctx.input.refresh
    });

    let models = catalog.models;

    if (ctx.input.search) {
      let needle = ctx.input.search.toLowerCase();
      models = models.filter(
        model =>
          model.modelId.toLowerCase().includes(needle) ||
          model.name?.toLowerCase().includes(needle)
      );
    }

    let totalCount = models.length;
    let maxResults = ctx.input.maxResults ?? 50;
    let page = models.slice(0, maxResults);

    let message = `Found **${totalCount}** ${capability} model(s)${ctx.input.search ? ` matching "${ctx.input.search}"` : ''}. Showing ${page.length}.`;
    if (catalog.degraded) {
      message += ` ${catalog.note ?? 'Live discovery failed; showing the verified fallback catalog.'}`;
    }

    return {
      output: {
        models: page.map(toModelOutput),
        totalCount,
        catalogSource: catalog.catalogSource,
        degraded: catalog.degraded,
        note: catalog.note
      },
      message
    };
  })
  .build();

/**
 * Used by the chat tool as a second line of defence: a request that carries an
 * image part is refused when the target model does not explicitly declare
 * image input support.
 */
export let assertModelSupportsModality = async (
  client: Client,
  modelId: string,
  modality: OrcaInputModality
) => {
  let detail: Record<string, unknown>;
  try {
    detail = await client.getModel(modelId);
  } catch {
    throw orcaServiceError(
      `Could not verify that model "${modelId}" accepts ${modality} input, so the request was not sent.`
    );
  }

  let normalized = normalizeModel(detail, 'live');
  if (!normalized) {
    throw orcaServiceError(
      `OrcaRouter returned no metadata for model "${modelId}", so its ${modality} input support could not be verified.`
    );
  }

  if (!(normalized.inputModalities ?? []).includes(modality)) {
    throw orcaServiceError(
      `Model "${modelId}" does not declare ${modality} input support. Choose a model that lists "${modality}" in its input modalities.`
    );
  }
};

export let resetModelCatalogCache = () => clearCatalogCache();
