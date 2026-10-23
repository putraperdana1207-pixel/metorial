import { badRequestError, ServiceError } from '@lowerdeck/error';

type ErrorResponse = {
  status?: number;
  statusText?: string;
  data?: unknown;
};

type ErrorDetails = {
  status?: number;
  message: string;
};

let isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

let keyPattern = /sk-orca-[A-Za-z0-9._-]+/g;

/**
 * Removes OrcaRouter API keys from any text that is about to become a user
 * facing error message. Keys must never reach logs, traces, or error bodies.
 */
export let redactSecrets = (value: string) => value.replace(keyPattern, 'sk-orca-[redacted]');

let trimToLength = (value: string) => {
  let trimmed = value.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
};

let addDetail = (details: string[], value: unknown) => {
  if (typeof value !== 'string') return;

  let trimmed = redactSecrets(value.trim());
  if (trimmed && !details.includes(trimmed)) {
    details.push(trimToLength(trimmed));
  }
};

/**
 * Extracts a short, safe description from an upstream error. Only message-like
 * fields are read; request config (which carries the Authorization header) is
 * never inspected.
 */
export let extractErrorDetails = (error: unknown): ErrorDetails => {
  let response = isRecord(error) ? (error.response as ErrorResponse | undefined) : undefined;
  let data = response?.data;
  let details: string[] = [];

  if (isRecord(data)) {
    let nestedError = isRecord(data.error) ? data.error : undefined;
    for (let key of ['message', 'code', 'type']) {
      addDetail(details, nestedError?.[key]);
    }
    for (let key of ['error_description', 'error', 'message']) {
      addDetail(details, data[key]);
    }
  } else {
    addDetail(details, data);
  }

  let status = getStatus(error);

  return {
    status,
    message:
      details.length > 0
        ? details.join(' - ')
        : error instanceof Error
          ? redactSecrets(error.message || error.name)
          : 'Unknown error'
  };
};

export let getStatus = (error: unknown): number | undefined => {
  if (!isRecord(error)) return undefined;

  let response = error.response as ErrorResponse | undefined;
  let candidate =
    response?.status ?? error.status ?? (isRecord(error.data) ? error.data.status : undefined);

  return typeof candidate === 'number' ? candidate : undefined;
};

/**
 * Reads the machine-readable error code OrcaRouter returns, if any. Model
 * access is governed per API key, so a 403 can mean "this key may not call
 * this model" rather than "the credential expired". The two cases need
 * different user actions and must not be conflated.
 */
export let getUpstreamErrorCode = (error: unknown): string | undefined => {
  if (!isRecord(error)) return undefined;

  let response = error.response as ErrorResponse | undefined;
  let data = response?.data ?? (isRecord(error.data) ? error.data : undefined);
  if (!isRecord(data)) return undefined;

  let nested = isRecord(data.error) ? data.error : undefined;
  let code = nested?.code ?? data.code;

  return typeof code === 'string' ? code : undefined;
};

let isModelAccessError = (error: unknown) => {
  if (getUpstreamErrorCode(error) === 'model_access_denied') return true;

  let response = isRecord(error) ? (error.response as ErrorResponse | undefined) : undefined;
  if (isRecord(response?.data)) {
    let nested = isRecord(response.data.error) ? response.data.error : undefined;
    let metadata = isRecord((nested as Record<string, unknown> | undefined)?.metadata)
      ? ((nested as Record<string, unknown>).metadata as Record<string, unknown>)
      : undefined;

    if (metadata?.reason === 'block_key_scope') return true;
  }

  return false;
};

export let orcaServiceError = (message: string) =>
  new ServiceError(badRequestError({ message: redactSecrets(message) }));

export let orcaApiError = (error: unknown, operation = 'request') => {
  if (error instanceof ServiceError) return error;

  let response = isRecord(error) ? (error.response as ErrorResponse | undefined) : undefined;
  let details = extractErrorDetails(error);
  let status = details.status;
  let statusLabel =
    status !== undefined
      ? `HTTP ${status}${response?.statusText ? ` ${response.statusText}` : ''}: `
      : '';

  let modelAccessDenied = isModelAccessError(error);
  let isAuthFailure = !modelAccessDenied && (status === 401 || status === 403);

  let serviceError = orcaServiceError(
    modelAccessDenied
      ? `OrcaRouter denied this API key access to the requested model while trying to ${operation}. ` +
          "Update the key's model access in the OrcaRouter console and try again."
      : isAuthFailure
        ? `OrcaRouter rejected the stored credential while trying to ${operation}. ` +
          'Reconnect the OrcaRouter account or paste a new API key.'
        : `OrcaRouter API ${operation} failed: ${statusLabel}${details.message}`
  );

  serviceError.data.reason = modelAccessDenied
    ? 'orcarouter_model_access_denied'
    : isAuthFailure
      ? 'orcarouter_reauth_required'
      : 'orcarouter_api_error';
  serviceError.data.upstreamStatus = status;

  if (isAuthFailure) {
    // A durable OrcaRouter key is not a refresh token. There is no refresh
    // grant to call, so the host marks this credential as requiring a new
    // login instead of retrying.
    serviceError.data.needsReauth = true;
  }

  if (error instanceof Error) {
    serviceError.setParent(error);
  }

  return serviceError;
};

/**
 * Maps a failed PKCE exchange to an actionable message. The upstream body is
 * deliberately not echoed: it can contain fragments of a one-time code, and it
 * must never carry a verifier or a key into a user-facing error.
 */
export let orcaExchangeError = (error: unknown) => {
  if (error instanceof ServiceError) return error;

  let status = getStatus(error);
  let message: string;

  if (status === 400) {
    message =
      'OrcaRouter did not accept the PKCE method for this authorization. Start the login again.';
  } else if (status === 403) {
    message =
      'OrcaRouter rejected the authorization code. It may be expired, already used, or not bound to this login attempt. Start the login again.';
  } else if (status === 429) {
    message =
      'OrcaRouter is limiting new logins for this account. Wait a few minutes, then try again.';
  } else if (status !== undefined) {
    message = `OrcaRouter login failed (HTTP ${status}). Try again.`;
  } else {
    message =
      'Could not reach OrcaRouter to complete the login. Check your network connection and try again.';
  }

  let serviceError = orcaServiceError(message);
  serviceError.data.reason = 'orcarouter_pkce_exchange_error';
  serviceError.data.upstreamStatus = status;

  if (error instanceof Error) {
    serviceError.setParent(error);
  }

  return serviceError;
};

/**
 * Catalog discovery falls back to the verified seed only for transient
 * failures. Invalid credentials must surface instead of being masked by a
 * static list.
 */
export let isTransientCatalogError = (error: unknown) => {
  if (!(error instanceof ServiceError)) return true;

  let status = error.data?.upstreamStatus;
  if (typeof status === 'number') {
    return status === 429 || status >= 500;
  }

  return true;
};
