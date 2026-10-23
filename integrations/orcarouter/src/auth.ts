import { createAxios, SlateAuth } from 'slates';
import { z } from 'zod';
import { Client } from './lib/client';
import {
  buildAuthorizationUrl,
  buildExchangeUrl,
  normalizeBaseUrl,
  resolveOrigins,
  validateCallbackUrl
} from './lib/env';
import { orcaExchangeError, orcaServiceError } from './lib/errors';
import { createCodeChallenge, createCodeVerifier, safeCompare } from './lib/pkce';

const ORCA_KEY_PREFIX = 'sk-orca-';
const APP_NAME = 'Metorial';

type AuthConfig = { authBaseUrl?: string; apiBaseUrl?: string } | undefined;

let resolveAuthOrigins = (config: AuthConfig) => resolveOrigins(config ?? {});

let readCallbackState = (value: Record<string, any> | undefined) => {
  let state = value?.state;
  let codeVerifier = value?.codeVerifier;
  let codeChallenge = value?.codeChallenge;

  return {
    state: typeof state === 'string' && state ? state : undefined,
    codeVerifier: typeof codeVerifier === 'string' && codeVerifier ? codeVerifier : undefined,
    codeChallenge:
      typeof codeChallenge === 'string' && codeChallenge ? codeChallenge : undefined
  };
};

let exchangeCodeForApiKey = async (d: {
  authBaseUrl: string;
  code: string;
  codeVerifier: string;
}) => {
  let axios = createAxios({
    baseURL: d.authBaseUrl,
    headers: { 'Content-Type': 'application/json' }
  });

  let response: any;
  try {
    response = await axios.post('/api/v1/auth/keys', {
      code: d.code,
      code_verifier: d.codeVerifier,
      code_challenge_method: 'S256'
    });
  } catch (error) {
    throw orcaExchangeError(error);
  }

  let body = response?.data;
  let key = typeof body?.key === 'string' ? body.key : undefined;
  let scope = typeof body?.scope === 'string' ? body.scope : undefined;

  if (!key?.startsWith(ORCA_KEY_PREFIX)) {
    throw orcaServiceError(
      'OrcaRouter did not return an API key for this login. Start the login again.'
    );
  }

  if (scope !== 'api') {
    throw orcaServiceError(
      `OrcaRouter granted the "${scope ?? 'unknown'}" scope, which cannot call the inference API. ` +
        'Ask a workspace owner to grant the "api" scope and connect again.'
    );
  }

  return { token: key, scope };
};

let fetchProfile = async (token: string, config: AuthConfig) => {
  let origins = resolveAuthOrigins(config);
  let client = new Client({ token, apiBaseUrl: origins.apiBaseUrl });
  let models = await client.listModels();

  return {
    profile: {
      name: 'OrcaRouter API Key',
      modelsAvailable: models.length
    }
  };
};

let getTokenInput = (input: unknown) => {
  let token = (input as { token?: unknown } | null)?.token;
  if (typeof token !== 'string' || !token.trim()) {
    throw orcaServiceError('An OrcaRouter API key is required.');
  }

  return token.trim();
};

export let auth = SlateAuth.create()
  .output(
    z.object({
      token: z.string()
    })
  )
  .addTokenAuth({
    type: 'auth.token',
    name: 'OrcaRouter - API Key',
    key: 'api_key',
    docs: [
      {
        type: 'docs.auth.token',
        name: 'OrcaRouter API keys',
        url: 'https://www.orcarouter.ai/console'
      }
    ],
    inputSchema: z.object({
      token: z.string().describe('OrcaRouter API key (starts with sk-orca-)')
    }),
    getOutput: async ctx => {
      return {
        output: {
          token: getTokenInput(ctx.input)
        }
      };
    },
    getProfile: async (ctx: {
      output: { token: string };
      input: { token: string };
      scopes: string[];
      config?: Record<string, any>;
    }) => {
      return await fetchProfile(getTokenInput(ctx.output), ctx.config as AuthConfig);
    }
  })
  .addOauth({
    type: 'auth.oauth',
    name: 'OrcaRouter - Auth',
    key: 'oauth_pkce',
    scopes: [],
    docs: [
      {
        type: 'docs.auth.oauth',
        name: 'OrcaRouter authorization',
        url: 'https://www.orcarouter.ai/auth'
      }
    ],
    getAuthorizationUrl: async ctx => {
      let origins = resolveAuthOrigins(ctx.config as AuthConfig);
      let redirectUri = validateCallbackUrl(ctx.redirectUri, 'OrcaRouter callback URL');
      let state = typeof ctx.state === 'string' ? ctx.state : '';
      if (!state) {
        throw orcaServiceError(
          'An OAuth state value is required to start an OrcaRouter login.'
        );
      }

      // Fresh verifier per attempt, from a cryptographic RNG. Only its S256
      // challenge is placed on the authorize URL; the verifier travels in the
      // host-side callback state and is used once at exchange time.
      let codeVerifier = createCodeVerifier();
      let codeChallenge = createCodeChallenge(codeVerifier);

      return {
        url: buildAuthorizationUrl({
          authBaseUrl: origins.authBaseUrl,
          redirectUri,
          state,
          codeChallenge,
          appName: APP_NAME,
          scopes: ['api']
        }),
        callbackState: {
          state,
          codeVerifier,
          codeChallenge
        }
      };
    },
    handleCallback: async ctx => {
      let origins = resolveAuthOrigins(ctx.config as AuthConfig);
      let callbackState = readCallbackState(ctx.callbackState);

      if (!callbackState.state) {
        throw orcaServiceError(
          'The OrcaRouter login state is missing. Start the login again from the beginning.'
        );
      }

      // Compare state before touching the authorization code.
      if (!safeCompare(typeof ctx.state === 'string' ? ctx.state : '', callbackState.state)) {
        throw orcaServiceError(
          'The OrcaRouter login state did not match this attempt. Start the login again.'
        );
      }

      if (!callbackState.codeVerifier) {
        throw orcaServiceError(
          'The OrcaRouter PKCE verifier for this login is missing. Start the login again.'
        );
      }

      if (
        callbackState.codeChallenge &&
        callbackState.codeChallenge !== createCodeChallenge(callbackState.codeVerifier)
      ) {
        throw orcaServiceError(
          'The OrcaRouter PKCE verifier does not match the challenge from this login. Start the login again.'
        );
      }

      if (typeof ctx.code !== 'string' || !ctx.code.trim()) {
        throw orcaServiceError('The OrcaRouter login did not return an authorization code.');
      }

      let exchanged = await exchangeCodeForApiKey({
        authBaseUrl: origins.authBaseUrl,
        code: ctx.code.trim(),
        codeVerifier: callbackState.codeVerifier
      });

      return {
        output: {
          token: exchanged.token
        },
        scopes: [exchanged.scope]
      };
    },
    getProfile: async (ctx: {
      output: { token: string };
      input: {};
      scopes: string[];
      config?: Record<string, any>;
    }) => {
      return await fetchProfile(String(ctx.output.token), ctx.config as AuthConfig);
    }
  });

/**
 * Exposed for tests and for callers that need to show the exact endpoints in
 * use. Both values are derived from the resolved origins; the exchange URL is
 * on the auth origin, never on the inference origin.
 */
export let describeAuthEndpoints = (config: AuthConfig) => {
  let origins = resolveAuthOrigins(config);

  return {
    authBaseUrl: normalizeBaseUrl(origins.authBaseUrl, 'auth base URL') ?? origins.authBaseUrl,
    exchangeUrl: buildExchangeUrl(origins.authBaseUrl),
    inferenceBaseUrl: origins.apiBaseUrl
  };
};
