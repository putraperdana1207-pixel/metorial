import { describe, expect, it } from 'vitest';
import { getUpstreamErrorCode, orcaApiError, redactSecrets } from './errors';

let axiosError = (status: number, data: unknown) => ({
  isAxiosError: true,
  response: { status, statusText: 'Forbidden', data }
});

describe('error classification', () => {
  it('marks a 401 as a reauthentication requirement without a refresh attempt', () => {
    let error = orcaApiError(
      axiosError(401, { error: { message: 'Invalid API key', type: 'authentication_error' } }),
      'list models'
    );

    expect(error.data.reason).toBe('orcarouter_reauth_required');
    expect(error.data.needsReauth).toBe(true);
    expect(error.data.upstreamStatus).toBe(401);
  });

  it('treats a model-scoped 403 as an access policy problem, not an expired credential', () => {
    let error = orcaApiError(
      axiosError(403, {
        error: {
          code: 'model_access_denied',
          message: 'This API key does not have access to model vendor/blocked',
          metadata: { reason: 'block_key_scope', model: 'vendor/blocked' }
        }
      }),
      'create chat completion'
    );

    expect(error.data.reason).toBe('orcarouter_model_access_denied');
    expect(error.data.needsReauth).toBeUndefined();
    expect(error.message).toMatch(/denied this API key access/);
    expect(
      getUpstreamErrorCode(axiosError(403, { error: { code: 'model_access_denied' } }))
    ).toBe('model_access_denied');
  });

  it('keeps a credential 403 as a reauthentication requirement', () => {
    let error = orcaApiError(
      axiosError(403, { error: { code: 'key_disabled', message: 'Key disabled' } }),
      'list models'
    );

    expect(error.data.reason).toBe('orcarouter_reauth_required');
    expect(error.data.needsReauth).toBe(true);
  });

  it('redacts key material from upstream messages', () => {
    let error = orcaApiError(
      axiosError(500, { error: { message: 'boom with sk-orca-abc123 leaked' } }),
      'create response'
    );

    expect(error.message).not.toContain('sk-orca-abc123');
    expect(redactSecrets('key sk-orca-abc123 here')).toBe('key sk-orca-[redacted] here');
  });
});
