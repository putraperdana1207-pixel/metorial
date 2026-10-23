import { createAxios } from 'slates';
import { DEFAULT_API_BASE_URL } from './env';
import { orcaApiError, orcaServiceError } from './errors';

export interface ClientConfig {
  token: string;
  apiBaseUrl?: string;
}

type JsonRecord = Record<string, unknown>;

let isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

let listFrom = (body: unknown): JsonRecord[] => {
  if (Array.isArray(body)) return body.filter(isRecord);
  if (isRecord(body) && Array.isArray(body.data)) return body.data.filter(isRecord);
  return [];
};

let compact = (body: JsonRecord) => {
  let result: JsonRecord = {};
  for (let [key, value] of Object.entries(body)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
};

/**
 * OrcaRouter model IDs keep their vendor namespace, e.g. `openai/gpt-5.5`.
 * They are forwarded verbatim; only path segments are encoded.
 */
export let modelPath = (modelId: string) => {
  let trimmed = modelId.trim();
  let separatorIndex = trimmed.indexOf('/');

  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    throw orcaServiceError(
      'OrcaRouter model IDs must include a vendor namespace, for example "openai/gpt-5.5".'
    );
  }

  let vendor = trimmed.slice(0, separatorIndex);
  let slug = trimmed.slice(separatorIndex + 1);
  return `${encodeURIComponent(vendor)}/${encodeURIComponent(slug)}`;
};

export class Client {
  private axios: ReturnType<typeof createAxios>;

  constructor(config: ClientConfig) {
    this.axios = createAxios({
      baseURL: config.apiBaseUrl ?? DEFAULT_API_BASE_URL,
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json'
      }
    });
  }

  private async request<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw orcaApiError(error, operation);
    }
  }

  async listModels(params?: { capability?: string }): Promise<JsonRecord[]> {
    return await this.request('list models', async () => {
      let response = await this.axios.get('/models', {
        params: compact({ capability: params?.capability })
      });

      return listFrom(response.data);
    });
  }

  async getModel(modelId: string): Promise<JsonRecord> {
    return await this.request('get model', async () => {
      let response = await this.axios.get(`/models/${modelPath(modelId)}`);
      let body = response.data;
      return (isRecord(body?.data) ? body.data : isRecord(body) ? body : {}) as JsonRecord;
    });
  }

  async createChatCompletion(params: {
    model: string;
    messages: Array<{
      role: string;
      content: string | JsonRecord[];
      name?: string;
      toolCallId?: string;
      toolCalls?: JsonRecord[];
    }>;
    temperature?: number;
    maxTokens?: number;
    maxCompletionTokens?: number;
    topP?: number;
    stop?: string | string[];
    seed?: number;
    tools?: JsonRecord[];
    toolChoice?: string | JsonRecord;
    parallelToolCalls?: boolean;
    responseFormat?: JsonRecord;
    reasoningEffort?: string;
    user?: string;
  }): Promise<JsonRecord> {
    return await this.request('create chat completion', async () => {
      let response = await this.axios.post(
        '/chat/completions',
        compact({
          model: params.model,
          messages: params.messages.map(message =>
            compact({
              role: message.role,
              content: message.content,
              name: message.name,
              tool_call_id: message.toolCallId,
              tool_calls: message.toolCalls
            })
          ),
          temperature: params.temperature,
          max_tokens: params.maxTokens,
          max_completion_tokens: params.maxCompletionTokens,
          top_p: params.topP,
          stop: params.stop,
          seed: params.seed,
          tools: params.tools,
          tool_choice: params.toolChoice,
          parallel_tool_calls: params.parallelToolCalls,
          response_format: params.responseFormat,
          reasoning: params.reasoningEffort ? { effort: params.reasoningEffort } : undefined,
          user: params.user
        })
      );

      return (response.data ?? {}) as JsonRecord;
    });
  }

  async createResponse(params: {
    model: string;
    input: string | JsonRecord[];
    instructions?: string;
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    tools?: JsonRecord[];
    toolChoice?: string | JsonRecord;
    parallelToolCalls?: boolean;
    responseFormat?: JsonRecord;
    reasoningEffort?: string;
    previousResponseId?: string;
    user?: string;
  }): Promise<JsonRecord> {
    return await this.request('create response', async () => {
      let response = await this.axios.post(
        '/responses',
        compact({
          model: params.model,
          input: params.input,
          instructions: params.instructions,
          max_output_tokens: params.maxOutputTokens,
          temperature: params.temperature,
          top_p: params.topP,
          tools: params.tools,
          tool_choice: params.toolChoice,
          parallel_tool_calls: params.parallelToolCalls,
          text: params.responseFormat ? { format: params.responseFormat } : undefined,
          reasoning: params.reasoningEffort ? { effort: params.reasoningEffort } : undefined,
          previous_response_id: params.previousResponseId,
          user: params.user
        })
      );

      return (response.data ?? {}) as JsonRecord;
    });
  }

  async createEmbedding(params: {
    model: string;
    input: string | string[];
    dimensions?: number;
    encodingFormat?: string;
    user?: string;
  }): Promise<JsonRecord> {
    return await this.request('create embedding', async () => {
      let response = await this.axios.post(
        '/embeddings',
        compact({
          model: params.model,
          input: params.input,
          dimensions: params.dimensions,
          encoding_format: params.encodingFormat,
          user: params.user
        })
      );

      return (response.data ?? {}) as JsonRecord;
    });
  }
}
