import { describe, expect, it } from 'vitest';
import {
  buildAuthorizationUrl,
  buildExchangeUrl,
  DEFAULT_API_BASE_URL,
  DEFAULT_AUTH_BASE_URL,
  resolveOrigins,
  validateCallbackUrl
} from './env';

describe('resolveOrigins', () => {
  it('uses the public defaults with no overrides', () => {
    expect(resolveOrigins({}, {})).toEqual({
      authBaseUrl: DEFAULT_AUTH_BASE_URL,
      apiBaseUrl: DEFAULT_API_BASE_URL
    });
  });

  it('honours explicit overrides ahead of the shared base', () => {
    expect(
      resolveOrigins(
        { authBaseUrl: 'https://auth.example.com', apiBaseUrl: 'https://api.example.com/v1' },
        { ORCAROUTER_BASE_URL: 'https://shared.example.com' }
      )
    ).toEqual({
      authBaseUrl: 'https://auth.example.com',
      apiBaseUrl: 'https://api.example.com/v1'
    });
  });

  it('honours explicit environment overrides ahead of the shared base', () => {
    expect(
      resolveOrigins(
        {},
        {
          ORCAROUTER_BASE_URL: 'https://shared.example.com',
          ORCAROUTER_AUTH_BASE_URL: 'https://auth.example.com',
          ORCAROUTER_API_BASE_URL: 'https://api.example.com/v1'
        }
      )
    ).toEqual({
      authBaseUrl: 'https://auth.example.com',
      apiBaseUrl: 'https://api.example.com/v1'
    });
  });

  it('derives both origins from a shared self-hosted base without swapping hosts', () => {
    expect(resolveOrigins({}, { ORCAROUTER_BASE_URL: 'https://gateway.internal' })).toEqual({
      authBaseUrl: 'https://gateway.internal',
      apiBaseUrl: 'https://gateway.internal/v1'
    });
  });

  it('does not double the /v1 suffix on a shared base that already has one', () => {
    expect(
      resolveOrigins({}, { ORCAROUTER_BASE_URL: 'https://gateway.internal/v1' }).apiBaseUrl
    ).toBe('https://gateway.internal/v1');
  });

  it('allows http only for loopback development origins', () => {
    expect(
      resolveOrigins({}, { ORCAROUTER_API_BASE_URL: 'http://127.0.0.1:8080/v1' }).apiBaseUrl
    ).toBe('http://127.0.0.1:8080/v1');
    expect(
      resolveOrigins({}, { ORCAROUTER_AUTH_BASE_URL: 'http://localhost:8080' }).authBaseUrl
    ).toBe('http://localhost:8080');
  });

  it('rejects plain http for a remote origin', () => {
    expect(() =>
      resolveOrigins({}, { ORCAROUTER_AUTH_BASE_URL: 'http://evil.example.com' })
    ).toThrow(/https/);
  });

  it('rejects credentials and fragments in an override', () => {
    expect(() => resolveOrigins({ authBaseUrl: 'https://user:pass@example.com' })).toThrow(
      /credentials/
    );
    expect(() => resolveOrigins({ apiBaseUrl: 'https://example.com/v1#frag' })).toThrow(
      /fragment/
    );
  });
});

describe('authorize and exchange URLs', () => {
  it('builds the authorize URL on the auth origin with S256 and the callback', () => {
    let url = new URL(
      buildAuthorizationUrl({
        authBaseUrl: 'https://www.orcarouter.ai',
        redirectUri: 'http://127.0.0.1:45873/callback',
        state: 'state-1',
        codeChallenge: 'challenge-1',
        appName: 'Metorial',
        scopes: ['api']
      })
    );

    expect(url.origin).toBe('https://www.orcarouter.ai');
    expect(url.pathname).toBe('/auth');
    expect(url.searchParams.get('callback_url')).toBe('http://127.0.0.1:45873/callback');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('app_name')).toBe('Metorial');
    expect(url.searchParams.get('scope')).toBe('api');
  });

  it('puts the exchange on the auth origin path, never on the inference origin', () => {
    let exchangeUrl = buildExchangeUrl('https://www.orcarouter.ai');

    expect(exchangeUrl).toBe('https://www.orcarouter.ai/api/v1/auth/keys');
    expect(new URL(exchangeUrl).origin).toBe('https://www.orcarouter.ai');
    expect(exchangeUrl).not.toContain('api.orcarouter.ai');
  });
});

describe('validateCallbackUrl', () => {
  it('accepts https callbacks and loopback http callbacks', () => {
    expect(validateCallbackUrl('https://app.example.com/cb')).toBe(
      'https://app.example.com/cb'
    );
    expect(validateCallbackUrl('http://127.0.0.1:51733/cb')).toBe('http://127.0.0.1:51733/cb');
  });

  it('rejects remote http callbacks and empty values', () => {
    expect(() => validateCallbackUrl('http://app.example.com/cb')).toThrow(/https/);
    expect(() => validateCallbackUrl('')).toThrow(/required/);
  });
});
