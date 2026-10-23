import { SlateTool } from 'slates';
import { z } from 'zod';
import { Client } from '../lib/client';
import { resolveOrigins } from '../lib/env';
import { spec } from '../spec';

export let createEmbedding = SlateTool.create(spec, {
  name: 'Create Embedding',
  key: 'create_embedding',
  description: `Generate vector embeddings through OrcaRouter's OpenAI-compatible embeddings endpoint. Use list_models with capability "embedding" first to see which embedding models this workspace can call.`,
  instructions: [
    'Embedding model IDs keep their vendor namespace, e.g. "openai/text-embedding-3-small".',
    'Check list_models with capability "embedding" before assuming a model is available to this workspace.'
  ],
  tags: {
    readOnly: true
  }
})
  .input(
    z.object({
      model: z.string().describe('Embedding model ID with its vendor namespace'),
      input: z
        .union([z.string(), z.array(z.string())])
        .describe('Text to embed — a single string or an array for batch processing'),
      dimensions: z
        .number()
        .min(1)
        .optional()
        .describe('Requested embedding dimensions, when the model supports it'),
      encodingFormat: z
        .enum(['float', 'base64'])
        .optional()
        .describe('Embedding encoding returned by the API'),
      user: z.string().optional().describe('Stable end-user identifier')
    })
  )
  .output(
    z.object({
      model: z.string().optional().describe('Model used for the embeddings'),
      embeddings: z
        .array(
          z.object({
            index: z.number().describe('Index of the embedding in the batch'),
            embedding: z.array(z.number()).describe('The embedding vector')
          })
        )
        .describe('Embedding results'),
      usage: z
        .object({
          promptTokens: z.number().describe('Prompt tokens'),
          totalTokens: z.number().describe('Total tokens')
        })
        .optional()
        .describe('Token usage')
    })
  )
  .handleInvocation(async ctx => {
    let origins = resolveOrigins({
      authBaseUrl: ctx.config.authBaseUrl,
      apiBaseUrl: ctx.config.apiBaseUrl
    });
    let client = new Client({ token: ctx.auth.token, apiBaseUrl: origins.apiBaseUrl });

    let result = await client.createEmbedding({
      model: ctx.input.model,
      input: ctx.input.input,
      dimensions: ctx.input.dimensions,
      encodingFormat: ctx.input.encodingFormat,
      user: ctx.input.user
    });

    let data = Array.isArray(result.data) ? (result.data as Record<string, unknown>[]) : [];
    let embeddings = data.map(item => ({
      index: typeof item.index === 'number' ? item.index : 0,
      embedding: Array.isArray(item.embedding) ? (item.embedding as number[]) : []
    }));
    let usage = result.usage as Record<string, unknown> | undefined;

    return {
      output: {
        model: (result.model as string) || undefined,
        embeddings,
        usage: usage
          ? {
              promptTokens: (usage.prompt_tokens as number) || 0,
              totalTokens: (usage.total_tokens as number) || 0
            }
          : undefined
      },
      message: `Generated ${embeddings.length} embedding(s) using **${(result.model as string) || ctx.input.model}**.`
    };
  })
  .build();
