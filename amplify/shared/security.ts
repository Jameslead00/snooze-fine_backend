import { createHash, timingSafeEqual } from 'node:crypto';

export function constantTimeTokenMatches(actual: string | undefined, expected: string): boolean {
  if (actual === undefined || expected.length === 0) return false;
  const actualDigest = createHash('sha256').update(actual, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
