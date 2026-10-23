import { SlateTool } from 'slates';
import { z } from 'zod';
import { Client } from '../lib/client';
import { resolveOrigins } from '../lib/env';
import { orcaServiceError } from '../lib/errors';
import { normalizeModel } from '../lib/models';
import { spec } from '../spec';
import { modelSchema } from './list-models';

export let getModel = SlateTool.create(spec, {
  name: 'Get Model',
  key: 'get_model',
  description: `Read the full metadata OrcaRouter publishes for one model: context window, output limit, declared input/output modalities, endpoint types, supported parameters, and pricing. Use it to confirm a model can accept the content you plan to send before making the request.`,
  tags: {
    readOnly: true
  }
})
  .input(
    z.object({
      modelId: z
        .string()
        .describe(
          'Model identifier with its vendor namespace, e.g. "deepseek/deepseek-v4-pro"'
        )
    })
  )
  .output(
    z.object({
      model: modelSchema.describe('Model metadata from the live OrcaRouter catalog')
    })
  )
  .handleInvocation(async ctx => {
    let origins = resolveOrigins({
      authBaseUrl: ctx.config.authBaseUrl,
      apiBaseUrl: ctx.config.apiBaseUrl
    });

    let client = new Client({ token: ctx.auth.token, apiBaseUrl: origins.apiBaseUrl });
    let raw = await client.getModel(ctx.input.modelId);
    let model = normalizeModel(raw, 'live');

    if (!model) {
      throw orcaServiceError(
        `OrcaRouter returned no usable metadata for model "${ctx.input.modelId}".`
      );
    }

    return {
      output: { model },
      message: `Retrieved model **${model.name ?? model.modelId}** — context: ${model.contextLength ?? 'N/A'} tokens.`
    };
  })
  .build();
