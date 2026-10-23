import { orcaServiceError } from './errors';

export const DEFAULT_AUTH_BASE_URL = 'https://www.orcarouter.ai';
export const DEFAULT_API_BASE_URL = 'https://api.orcarouter.ai/v1';

export type OrcaOriginOverrides = {
  authBaseUrl?: string;
  apiBaseUrl?: string;
};

export type OrcaOrigins = {
  authBaseUrl: string;
  apiBaseUrl: string;
};

let isLoopbackHost = (hostname: string) => {
  let host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
};

let stripTrailingSlashes = (value: string) => value.replace(/\/+$/, '');

let parseAbsoluteUrl = (value: string, label: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw orcaServiceError(`${label} must be an absolute URL.`);
  }

  if (url.username || url.password) {
    throw orcaServiceError(`${label} must not contain credentials.`);
  }

  if (url.hash) {
    throw orcaServiceError(`${label} must not contain a fragment.`);
  }

  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLoopbackHost(url.hostname))
  ) {
    throw orcaServiceError(
      `${label} must use https. http is only allowed for loopback development hosts.`
    );
  }

  return url;
};

export let normalizeBaseUrl = (value: string | undefined, label: string) => {
  if (!value) return undefined;

  let trimmed = value.trim();
  if (!trimmed) return undefined;

  return stripTrailingSlashes(parseAbsoluteUrl(trimmed, label).toString());
};

export let validateCallbackUrl = (value: string, label = 'callback URL') => {
  let trimmed = value.trim();
  if (!trimmed) {
    throw orcaServiceError(`${label} is required to start an OrcaRouter login.`);
  }

  return stripTrailingSlashes(parseAbsoluteUrl(trimmed, label).toString());
};

let withV1Suffix = (baseUrl: string) => (baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`);

/**
 * Resolves the two public OrcaRouter origins.
 *
 * Precedence: explicit integration config, then the explicit environment
 * overrides, then the shared `ORCAROUTER_BASE_URL` fallback, then the public
 * defaults. The auth origin and the inference origin are never derived from
 * one another.
 */
export let resolveOrigins = (
  overrides: OrcaOriginOverrides = {},
  env: NodeJS.ProcessEnv = process.env
): OrcaOrigins => {
  let shared = normalizeBaseUrl(env.ORCAROUTER_BASE_URL, 'ORCAROUTER_BASE_URL');
  let envAuth = normalizeBaseUrl(env.ORCAROUTER_AUTH_BASE_URL, 'ORCAROUTER_AUTH_BASE_URL');
  let envApi = normalizeBaseUrl(env.ORCAROUTER_API_BASE_URL, 'ORCAROUTER_API_BASE_URL');
  let configAuth = normalizeBaseUrl(overrides.authBaseUrl, 'OrcaRouter auth base URL');
  let configApi = normalizeBaseUrl(overrides.apiBaseUrl, 'OrcaRouter API base URL');

  return {
    authBaseUrl: configAuth ?? envAuth ?? shared ?? DEFAULT_AUTH_BASE_URL,
    apiBaseUrl: configApi ?? envApi ?? (shared ? withV1Suffix(shared) : DEFAULT_API_BASE_URL)
  };
};

export let buildAuthorizationUrl = (d: {
  authBaseUrl: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  appName: string;
  scopes: string[];
}) => {
  let url = new URL(`${stripTrailingSlashes(d.authBaseUrl)}/auth`);

  url.searchParams.set('callback_url', d.redirectUri);
  url.searchParams.set('code_challenge', d.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', d.state);
  url.searchParams.set('app_name', d.appName);

  if (d.scopes.length > 0) {
    url.searchParams.set('scope', d.scopes.join(' '));
  }

  return url.toString();
};

/**
 * The exchange endpoint lives on the auth origin. `/v1/auth/keys` on the
 * inference origin is a 404 and must never be used.
 */
export let buildExchangeUrl = (authBaseUrl: string) =>
  `${stripTrailingSlashes(authBaseUrl)}/api/v1/auth/keys`;
