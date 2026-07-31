import { describe, expect, it } from 'vitest';
import { constantTimeTokenMatches } from '../amplify/shared/security.js';

describe('RevenueCat webhook authorization', () => {
  it('accepts the exact configured token', () => {
    expect(constantTimeTokenMatches('Bearer webhook-secret', 'Bearer webhook-secret')).toBe(true);
  });

  it('rejects missing and invalid tokens', () => {
    expect(constantTimeTokenMatches('Bearer wrong', 'Bearer webhook-secret')).toBe(false);
    expect(constantTimeTokenMatches(undefined, 'Bearer webhook-secret')).toBe(false);
  });
});
