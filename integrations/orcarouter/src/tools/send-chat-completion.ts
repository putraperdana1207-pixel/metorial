import { SlateTool } from 'slates';
import { z } from 'zod';
import { Client } from '../lib/client';
import { resolveOrigins } from '../lib/env';
import { orcaServiceError } from '../lib/errors';
import { hasImageInput, normalizeModel } from '../lib/models';
import { spec } from '../spec';

let messageSchema = z.object({
  role: z
    .enum(['system', 'developer', 'user', 'assistant', 'tool'])
    .describe('The role of the message sender'),
  content: z
    .union([z.string(), z.array(z.looseObject({}))])
    .describe(
      'Message content — a string for text, or an array of content parts for image or file input'
    ),
  name: z.string().optional().describe('Optional name for the message sender'),
  toolCallId: z
    .string()
    .optional()
    .describe('Required for tool role — the ID of the tool call this message responds to'),
  toolCalls: z.array(z.any()).optional().describe('Tool calls made by the assistant')
});

let toolDefinitionSchema = z.object({
  type: z.literal('function').describe('Tool type, currently only "function" is supported'),
  function: z.object({
    name: z.string().describe('Function name'),
    description: z.string().optional().describe('What the function does'),
    parameters: z
      .looseObject({})
      .optional()
      .describe('JSON Schema describing the function parameters')
  })
});

let responseFormatSchema = z.object({
  type: z.enum(['json_object', 'json_schema', 'text']).describe('Response format type'),
  json_schema: z
    .object({
      name: z.string().describe('Schema name'),
      strict: z.boolean().optional().describe('Whether to enforce strict schema compliance'),
      schema: z.looseObject({}).describe('The JSON Schema to enforce')
    })
    .optional()
    .describe('JSON schema definition (required when type is json_schema)')
});

let assertModelAcceptsImage = async (client: Client, modelId: string) => {
  let raw: Record<string, unknown>;
  try {
    raw = await client.getModel(modelId);
  } catch {
    throw orcaServiceError(
      `Could not verify that model "${modelId}" accepts image input, so the request was not sent.`
    );
  }

  let model = normalizeModel(raw, 'live');
  if (!model || !(model.inputModalities ?? []).includes('image')) {
    throw orcaServiceError(
      `Model "${modelId}" does not declare image input support. Pick a model whose input modalities include "image".`
    );
  }
};

export let sendChatCompletion = SlateTool.create(spec, {
  name: 'Send Chat Completion',
  key: 'send_chat_completion',
  description: `Send a chat completion to any model this OrcaRouter workspace can call. OrcaRouter is OpenAI-compatible, so messages, tool calling, structured outputs, and multimodal content parts use the OpenAI wire format. Text and image content parts are supported; image requests are refused unless the target model explicitly declares image input.`,
  instructions: [
    'Use a model ID from list_models, keeping its vendor namespace, for example "openai/gpt-5.5" or "orcarouter/auto".',
    'For image input, pass content parts such as { type: "image_url", image_url: { url } } and select a model whose input modalities include "image".',
    'Streaming is not supported through this tool; responses are returned in full.'
  ],
  tags: {
    readOnly: false
  }
})
  .input(
    z.object({
      model: z.string().describe('Model ID with its vendor namespace, e.g. "openai/gpt-5.5"'),
      messages: z.array(messageSchema).describe('Conversation messages'),
      temperature: z.number().min(0).max(2).optional().describe('Sampling temperature (0-2)'),
      maxTokens: z.number().optional().describe('Maximum tokens to generate (legacy field)'),
      maxCompletionTokens: z
        .number()
        .optional()
        .describe('Maximum tokens to generate in the completion'),
      topP: z.number().min(0).max(1).optional().describe('Nucleus sampling threshold'),
      stop: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe('Stop sequence(s)'),
      seed: z.number().optional().describe('Random seed for deterministic sampling'),
      tools: z.array(toolDefinitionSchema).optional().describe('Tools the model may call'),
      toolChoice: z
        .union([
          z.enum(['auto', 'none', 'required']),
          z.object({ type: z.literal('function'), function: z.object({ name: z.string() }) })
        ])
        .optional()
        .describe('Controls tool selection'),
      parallelToolCalls: z
        .boolean()
        .optional()
        .describe('Whether the model may emit parallel tool calls'),
      responseFormat: responseFormatSchema
        .optional()
        .describe('Structured output configuration'),
      reasoningEffort: z
        .enum(['low', 'medium', 'high', 'xhigh'])
        .optional()
        .describe('Reasoning effort for models that support it'),
      user: z.string().optional().describe('Stable end-user identifier')
    })
  )
  .output(
    z.object({
      id: z.string().optional().describe('Completion ID'),
      model: z.string().optional().describe('Model that served the request'),
      created: z.number().optional().describe('Creation timestamp'),
      choices: z
        .array(
          z.object({
            index: z.number().describe('Choice index'),
            finishReason: z.string().nullable().optional().describe('Stop reason'),
            message: z.object({
              role: z.string().describe('Message role'),
              content: z.string().nullable().optional().describe('Text content'),
              reasoning: z
                .string()
                .nullable()
                .optional()
                .describe('Reasoning content, when returned'),
              toolCalls: z
                .array(
                  z.object({
                    callId: z.string().describe('Tool call ID'),
                    type: z.string().describe('Tool call type'),
                    name: z.string().describe('Function name'),
                    arguments: z.string().describe('Raw JSON arguments')
                  })
                )
                .optional()
                .describe('Tool calls requested by the model')
            })
          })
        )
        .describe('Generated choices'),
      usage: z
        .object({
          promptTokens: z.number().describe('Prompt tokens'),
          completionTokens: z.number().describe('Completion tokens'),
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

    let carriesImage = ctx.input.messages.some(message => hasImageInput(message.content));
    if (carriesImage) {
      // Second line of defence: the selector should already be filtered, but a
      // request must never reach a model that cannot see the attachment.
      await assertModelAcceptsImage(client, ctx.input.model);
    }

    let result = await client.createChatCompletion({
      model: ctx.input.model,
      messages: ctx.input.messages,
      temperature: ctx.input.temperature,
      maxTokens: ctx.input.maxTokens,
      maxCompletionTokens: ctx.input.maxCompletionTokens,
      topP: ctx.input.topP,
      stop: ctx.input.stop,
      seed: ctx.input.seed,
      tools: ctx.input.tools,
      toolChoice: ctx.input.toolChoice,
      parallelToolCalls: ctx.input.parallelToolCalls,
      responseFormat: ctx.input.responseFormat,
      reasoningEffort: ctx.input.reasoningEffort,
      user: ctx.input.user
    });

    let choices = Array.isArray(result.choices) ? (result.choices as any[]) : [];
    let usage = result.usage as Record<string, unknown> | undefined;

    return {
      output: {
        id: (result.id as string) || undefined,
        model: (result.model as string) || undefined,
        created: typeof result.created === 'number' ? result.created : undefined,
        choices: choices.map(choice => ({
          index: typeof choice?.index === 'number' ? choice.index : 0,
          finishReason: choice?.finish_reason ?? undefined,
          message: {
            role: (choice?.message?.role as string) || 'assistant',
            content: (choice?.message?.content as string | null) ?? undefined,
            reasoning: (choice?.message?.reasoning as string | null) ?? undefined,
            toolCalls: Array.isArray(choice?.message?.tool_calls)
              ? choice.message.tool_calls.map((call: any) => ({
                  callId: String(call?.id ?? ''),
                  type: String(call?.type ?? 'function'),
                  name: String(call?.function?.name ?? ''),
                  arguments: String(call?.function?.arguments ?? '')
                }))
              : undefined
          }
        })),
        usage: usage
          ? {
              promptTokens: (usage.prompt_tokens as number) || 0,
              completionTokens: (usage.completion_tokens as number) || 0,
              totalTokens: (usage.total_tokens as number) || 0
            }
          : undefined
      },
      message: `Completed with **${(result.model as string) || ctx.input.model}**.`
    };
  })
  .build();
