import { SlateConfig } from 'slates';
import { z } from 'zod';

export let config = SlateConfig.create(
  z.object({
    authBaseUrl: z
      .string()
      .optional()
      .describe(
        'Optional override for the OrcaRouter authentication origin used by the OAuth login. Defaults to https://www.orcarouter.ai (or ORCAROUTER_AUTH_BASE_URL / ORCAROUTER_BASE_URL).'
      ),
    apiBaseUrl: z
      .string()
      .optional()
      .describe(
        'Optional override for the OrcaRouter inference origin used by tools and model discovery. Defaults to https://api.orcarouter.ai/v1 (or ORCAROUTER_API_BASE_URL / ORCAROUTER_BASE_URL).'
      )
  })
);
