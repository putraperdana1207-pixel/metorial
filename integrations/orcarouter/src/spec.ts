import { SlateSpecification } from 'slates';
import { auth } from './auth';
import { config } from './config';

export let spec = SlateSpecification.create({
  key: 'orcarouter',
  name: 'OrcaRouter',
  description:
    'OpenAI-compatible AI gateway that routes many model providers behind one endpoint, with a live model catalog and per-model capability metadata.',
  metadata: {},
  config,
  auth
});
