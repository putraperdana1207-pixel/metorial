import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * A fresh, high-entropy PKCE verifier for one authorization attempt.
 * It is produced by a cryptographic RNG and never leaves this process except
 * as the exchange request body.
 */
export let createCodeVerifier = () => randomBytes(32).toString('base64url');

/**
 * S256 challenge: base64url(sha256(verifier)) with no padding.
 */
export let createCodeChallenge = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');

export let createOAuthState = () => randomBytes(16).toString('base64url');

/**
 * Constant-time comparison for the state value echoed by the consent screen.
 */
export let safeCompare = (left: string, right: string) => {
  let leftBuffer = Buffer.from(left);
  let rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
};
