import { SlateTool } from 'slates';
import { z } from 'zod';
import { Client } from '../lib/client';
import { resolveOrigins } from '../lib/env';
import { spec } from '../spec';

let toolDefinitionSchema = z.object({
  type: z.literal('function').describe('Tool type, currently only "function" is supported'),
  name: z.string().describe('Function name'),
  description: z.string().optional().describe('What the function does'),
  parameters: z
    .looseObject({})
    .optional()
    .describe('JSON Schema describing the function parameters')
});

export let createResponse = SlateTool.create(spec, {
  name: 'Create Response',
  key: 'create_response',
  description: `Create a response with OrcaRouter's OpenAI Responses API endpoint. Use it for instruction-driven generations, multi-turn input items, tool calling, and structured text output when the model advertises the "openai-response" endpoint type.`,
  instructions: [
    'Prefer list_models or get_model to confirm the model advertises "openai-response" in its endpoint types before relying on this endpoint.',
    'Streaming is not supported through this tool; responses are returned in full.'
  ],
  tags: {
    readOnly: false
  }
})
  .input(
    z.object({
      model: z.string().describe('Model ID with its vendor namespace, e.g. "openai/gpt-5.5"'),
      input: z
        .union([z.string(), z.array(z.looseObject({}))])
        .describe('Input text, or an array of Responses API input items'),
      instructions: z
        .string()
        .optional()
        .describe('System-level instructions for the response'),
      maxOutputTokens: z.number().optional().describe('Maximum output tokens'),
      temperature: z.number().min(0).max(2).optional().describe('Sampling temperature'),
      topP: z.number().min(0).max(1).optional().describe('Nucleus sampling threshold'),
      tools: z.array(toolDefinitionSchema).optional().describe('Tools the model may call'),
      toolChoice: z
        .union([z.enum(['auto', 'none', 'required']), z.string()])
        .optional()
        .describe('Controls tool selection'),
      parallelToolCalls: z.boolean().optional().describe('Allow parallel tool calls'),
      responseFormat: z
        .looseObject({})
        .optional()
        .describe('Responses API text.format configuration'),
      reasoningEffort: z
        .enum(['low', 'medium', 'high', 'xhigh'])
        .optional()
        .describe('Reasoning effort for models that support it'),
      previousResponseId: z
        .string()
        .optional()
        .describe('Continue from a previous response ID'),
      user: z.string().optional().describe('Stable end-user identifier')
    })
  )
  .output(
    z.object({
      id: z.string().optional().describe('Response ID'),
      model: z.string().optional().describe('Model that served the request'),
      status: z.string().optional().describe('Terminal status reported by OrcaRouter'),
      outputText: z
        .string()
        .optional()
        .describe('Concatenated text from output_text content parts'),
      output: z.array(z.any()).optional().describe('Raw Responses API output items'),
      usage: z
        .object({
          inputTokens: z.number().describe('Input tokens'),
          outputTokens: z.number().describe('Output tokens'),
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

    let result = await client.createResponse({
      model: ctx.input.model,
      input: ctx.input.input,
      instructions: ctx.input.instructions,
      maxOutputTokens: ctx.input.maxOutputTokens,
      temperature: ctx.input.temperature,
      topP: ctx.input.topP,
      tools: ctx.input.tools,
      toolChoice: ctx.input.toolChoice,
      parallelToolCalls: ctx.input.parallelToolCalls,
      responseFormat: ctx.input.responseFormat,
      reasoningEffort: ctx.input.reasoningEffort,
      previousResponseId: ctx.input.previousResponseId,
      user: ctx.input.user
    });

    let output = Array.isArray(result.output)
      ? (result.output as Record<string, unknown>[])
      : [];
    let outputText = output
      .flatMap(item => (Array.isArray(item.content) ? (item.content as any[]) : []))
      .filter(part => part?.type === 'output_text' && typeof part.text === 'string')
      .map(part => part.text as string)
      .join('');

    let usage = result.usage as Record<string, unknown> | undefined;

    return {
      output: {
        id: (result.id as string) || undefined,
        model: (result.model as string) || undefined,
        status: (result.status as string) || undefined,
        outputText: outputText || undefined,
        output: output.length > 0 ? output : undefined,
        usage: usage
          ? {
              inputTokens: (usage.input_tokens as number) || 0,
              outputTokens: (usage.output_tokens as number) || 0,
              totalTokens: (usage.total_tokens as number) || 0
            }
          : undefined
      },
      message: `Created a response with **${(result.model as string) || ctx.input.model}**.`
    };
  })
  .build();
