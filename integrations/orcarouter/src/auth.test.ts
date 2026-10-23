import { createLocalSlateTestClient } from '@slates/test';
import { describe, expect, it } from 'vitest';
import { provider } from './index';
import { createCodeChallenge, createCodeVerifier, safeCompare } from './lib/pkce';
import { startFakeServer, withEnv } from './testing/fake-server';

let createClient = (config: { authBaseUrl?: string; apiBaseUrl?: string } = {}) =>
  createLocalSlateTestClient({
    slate: provider,
    state: { config }
  });

let withServers = async (
  run: (ctx: {
    auth: Awaited<ReturnType<typeof startFakeServer>>;
    api: Awaited<ReturnType<typeof startFakeServer>>;
    client: ReturnType<typeof createClient>;
  }) => Promise<void>,
  handler?: Parameters<typeof startFakeServer>[0]
) => {
  let auth = await startFakeServer(
    handler ??
      (() => ({
        body: { key: 'sk-orca-test-key', user_id: 'user-1', scope: 'api' }
      }))
  );
  let api = await startFakeServer(() => ({
    body: { data: [], object: 'list', success: true }
  }));

  try {
    await withEnv({}, async () => {
      let client = createClient({ authBaseUrl: auth.url, apiBaseUrl: `${api.url}/v1` });
      await run({ auth, api, client });
    });
  } finally {
    await auth.close();
    await api.close();
  }
};

let startLogin = async (client: ReturnType<typeof createClient>, state = 'host-state-1') =>
  await client.getAuthorizationUrl({
    authenticationMethodId: 'oauth_pkce',
    redirectUri: 'http://127.0.0.1:45873/callback',
    state,
    input: {},
    clientId: '',
    clientSecret: '',
    scopes: []
  });

let finishLogin = async (
  client: ReturnType<typeof createClient>,
  authorizationUrl: Awaited<ReturnType<typeof startLogin>>,
  code = 'code-1',
  state = 'host-state-1'
) =>
  await client.handleAuthorizationCallback({
    authenticationMethodId: 'oauth_pkce',
    code,
    state,
    redirectUri: 'http://127.0.0.1:45873/callback',
    input: {},
    clientId: '',
    clientSecret: '',
    scopes: [],
    callbackState: authorizationUrl.callbackState
  });

describe('PKCE helpers', () => {
  it('produces S256 challenges without padding', () => {
    let verifier = createCodeVerifier();
    let challenge = createCodeChallenge(verifier);

    expect(verifier).toHaveLength(43);
    expect(challenge).toHaveLength(43);
    expect(challenge).not.toContain('=');
    expect(challenge).not.toContain('+');
    expect(challenge).not.toContain('/');
  });

  it('creates a fresh verifier for every call', () => {
    let verifiers = new Set(Array.from({ length: 20 }, () => createCodeVerifier()));
    expect(verifiers.size).toBe(20);
  });

  it('compares state values safely', () => {
    expect(safeCompare('abc', 'abc')).toBe(true);
    expect(safeCompare('abc', 'abd')).toBe(false);
    expect(safeCompare('abc', 'abcd')).toBe(false);
  });
});

describe('registered auth methods', () => {
  it('exposes API key and OAuth PKCE as two independent choices', () => {
    let methods = provider.spec.auth.authStack;

    expect(methods.map(method => method.key)).toEqual(['api_key', 'oauth_pkce']);
    expect(methods.map(method => method.type)).toEqual(['auth.token', 'auth.oauth']);
    expect(methods.map(method => method.name)).toEqual([
      'OrcaRouter - API Key',
      'OrcaRouter - Auth'
    ]);
  });

  it('does not implement a refresh grant for the durable PKCE key', () => {
    let oauth = provider.spec.auth.authStack.find(
      method => method.key === 'oauth_pkce'
    ) as any;

    expect(oauth.handleTokenRefresh).toBeUndefined();
  });
});

describe('API key auth', () => {
  it('accepts a pasted key through the project token adapter', async () => {
    let client = createClient();

    let output = await client.getAuthOutput({
      authenticationMethodId: 'api_key',
      input: { token: '  sk-orca-pasted-key  ' }
    });

    expect(output.output).toEqual({ token: 'sk-orca-pasted-key' });
  });

  it('rejects an empty key', async () => {
    let client = createClient();

    await expect(
      client.getAuthOutput({ authenticationMethodId: 'api_key', input: { token: '   ' } })
    ).rejects.toThrow(/API key is required/);
  });

  it('validates the key with a non-billing model listing and returns a profile', async () => {
    await withServers(async ({ api, client }) => {
      let profile = await client.getAuthProfile({
        authenticationMethodId: 'api_key',
        output: { token: 'sk-orca-pasted-key' },
        input: { token: 'sk-orca-pasted-key' },
        scopes: []
      });

      expect(profile.profile).toEqual({
        name: 'OrcaRouter API Key',
        modelsAvailable: 0
      });
      expect(api.requests[0]?.path).toBe('/v1/models');
      expect(api.requests[0]?.headers.authorization).toBe('Bearer sk-orca-pasted-key');
    });
  });
});

describe('OAuth 2.0 + PKCE login', () => {
  it('builds an S256 authorize URL on the auth origin without leaking the verifier', async () => {
    await withServers(async ({ auth, client }) => {
      let authorization = await startLogin(client);
      let url = new URL(authorization.authorizationUrl);
      let verifier = (authorization.callbackState as any).codeVerifier as string;

      expect(url.origin).toBe(auth.url);
      expect(url.pathname).toBe('/auth');
      expect(url.searchParams.get('callback_url')).toBe('http://127.0.0.1:45873/callback');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toBe(createCodeChallenge(verifier));
      expect(url.searchParams.get('state')).toBe('host-state-1');
      expect(url.searchParams.get('app_name')).toBe('Metorial');
      expect(url.searchParams.get('scope')).toBe('api');

      expect(authorization.authorizationUrl).not.toContain(verifier);
      expect(authorization.authorizationUrl).not.toContain('client_secret');
      expect(auth.requests).toHaveLength(0);
    });
  });

  it('uses a fresh verifier for every attempt', async () => {
    await withServers(async ({ client }) => {
      let first = await startLogin(client, 'state-a');
      let second = await startLogin(client, 'state-b');

      let firstVerifier = (first.callbackState as any).codeVerifier;
      let secondVerifier = (second.callbackState as any).codeVerifier;

      expect(firstVerifier).not.toBe(secondVerifier);
      expect((first.callbackState as any).state).toBe('state-a');
      expect((second.callbackState as any).state).toBe('state-b');
    });
  });

  it('exchanges the code at /api/v1/auth/keys on the auth origin and persists the key', async () => {
    await withServers(async ({ auth, api, client }) => {
      let authorization = await startLogin(client);
      let output = await finishLogin(client, authorization);

      expect(output.output).toEqual({ token: 'sk-orca-test-key' });
      expect(output.scopes).toEqual(['api']);

      expect(auth.requests).toHaveLength(1);
      let exchange = auth.requests[0]!;
      expect(exchange.method).toBe('POST');
      expect(exchange.path).toBe('/api/v1/auth/keys');
      expect(exchange.body).toMatchObject({
        code: 'code-1',
        code_verifier: (authorization.callbackState as any).codeVerifier,
        code_challenge_method: 'S256'
      });

      // Inference traffic must never be used for the credential exchange.
      expect(api.requests).toHaveLength(0);
    });
  });

  it('refuses a state mismatch before exchanging the code', async () => {
    await withServers(async ({ auth, client }) => {
      let authorization = await startLogin(client);

      await expect(
        finishLogin(client, authorization, 'code-1', 'attacker-state')
      ).rejects.toThrow(/state did not match/);
      expect(auth.requests).toHaveLength(0);
    });
  });

  it('refuses a callback without the PKCE callback state', async () => {
    await withServers(async ({ client }) => {
      await expect(
        client.handleAuthorizationCallback({
          authenticationMethodId: 'oauth_pkce',
          code: 'code-1',
          state: 'host-state-1',
          redirectUri: 'http://127.0.0.1:45873/callback',
          input: {},
          clientId: '',
          clientSecret: '',
          scopes: [],
          callbackState: {}
        })
      ).rejects.toThrow(/login state is missing/);
    });
  });

  it('rejects a granted scope that cannot call the inference API', async () => {
    await withServers(
      async ({ client }) => {
        let authorization = await startLogin(client);

        await expect(finishLogin(client, authorization)).rejects.toThrow(/connector/);
      },
      () => ({ body: { key: 'sk-orca-test-key', user_id: 'user-1', scope: 'connector' } })
    );
  });

  it('rejects a response that does not contain a real OrcaRouter key', async () => {
    await withServers(
      async ({ client }) => {
        let authorization = await startLogin(client);

        await expect(finishLogin(client, authorization)).rejects.toThrow(
          /did not return an API key/
        );
      },
      () => ({ body: { key: 'not-a-key', scope: 'api' } })
    );
  });

  it('classifies an expired or reused code without echoing secrets', async () => {
    await withServers(
      async ({ client }) => {
        let authorization = await startLogin(client);
        let verifier = (authorization.callbackState as any).codeVerifier as string;

        let error = await finishLogin(client, authorization).catch(caught => caught);

        expect(error.message).toMatch(/rejected the authorization code/);
        expect(error.message).not.toContain(verifier);
        expect(error.message).not.toContain('code-1');
        expect(error.message).not.toContain('sk-orca-');
        expect(error.data?.baggage?.serviceError?.reason).toBe(
          'orcarouter_pkce_exchange_error'
        );
      },
      () => ({ status: 403, body: { error: 'Invalid code or code_verifier' } })
    );
  });

  it('classifies a 400 PKCE downgrade', async () => {
    await withServers(
      async ({ client }) => {
        let authorization = await startLogin(client);

        await expect(finishLogin(client, authorization)).rejects.toThrow(/PKCE method/);
      },
      () => ({ status: 400, body: { error: 'invalid_request' } })
    );
  });

  it('explains a 429 rate limit instead of retrying forever', async () => {
    await withServers(
      async ({ client }) => {
        let authorization = await startLogin(client);

        await expect(finishLogin(client, authorization)).rejects.toThrow(
          /limiting new logins/
        );
      },
      () => ({ status: 429, body: { error: 'rate_limited' } })
    );
  });

  it('reports a network failure as actionable', async () => {
    await withEnv({}, async () => {
      let client = createClient({
        authBaseUrl: 'http://127.0.0.1:1',
        apiBaseUrl: 'http://127.0.0.1:1/v1'
      });

      let authorization = await startLogin(client);
      let error = await finishLogin(client, authorization).catch(caught => caught);

      expect(error.message).toMatch(/Could not reach OrcaRouter/);
      expect(JSON.stringify(error.data ?? {})).not.toContain('sk-orca-');
    });
  });

  it('routes inference through the API origin and auth through the auth origin', async () => {
    await withServers(async ({ auth, api, client }) => {
      let authorization = await startLogin(client);
      await finishLogin(client, authorization);

      let profile = await client.getAuthProfile({
        authenticationMethodId: 'oauth_pkce',
        output: { token: 'sk-orca-test-key' },
        input: {},
        scopes: ['api']
      });

      expect(profile.profile).toMatchObject({ name: 'OrcaRouter API Key' });
      expect(auth.requests.every(request => request.path === '/api/v1/auth/keys')).toBe(true);
      expect(api.requests.every(request => request.path === '/v1/models')).toBe(true);
    });
  });

  it('keeps both auth methods usable independently', async () => {
    let client = createClient();

    let tokenOutput = await client.getAuthOutput({
      authenticationMethodId: 'api_key',
      input: { token: 'sk-orca-existing' }
    });

    expect(tokenOutput.output.token).toBe('sk-orca-existing');
  });
});
