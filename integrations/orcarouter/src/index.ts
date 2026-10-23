import { Slate } from 'slates';
import { spec } from './spec';
import {
  createEmbedding,
  createResponse,
  getModel,
  listModels,
  sendChatCompletion
} from './tools';

export let provider = Slate.create({
  spec,
  tools: [sendChatCompletion, createResponse, createEmbedding, listModels, getModel],
  triggers: []
});
