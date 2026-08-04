import { createHash, timingSafeEqual } from 'node:crypto';

export function constantTimeTokenMatches(actual: string | undefined, expected: string): boolean {
  if (actual === undefined || expected.length === 0) return false;

  // RevenueCat's webhook setting is an Authorization header. Depending on
  // whether the value is entered through the dashboard or API, it may be
  // stored as either `token` or `Bearer token`, and copy/paste can add
  // surrounding whitespace. Compare the credential itself while retaining a
  // constant-time digest comparison.
  const normalize = (value: string): string => {
    const trimmed = value.trim();
    return /^Bearer\s+/i.test(trimmed)
      ? trimmed.replace(/^Bearer\s+/i, '').trim()
      : trimmed;
  };
  const actualDigest = createHash('sha256').update(normalize(actual), 'utf8').digest();
  const expectedDigest = createHash('sha256').update(normalize(expected), 'utf8').digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
