import type { AppSyncIdentity } from 'aws-lambda';
import { DomainError } from './domain.js';

export function cognitoSub(identity: AppSyncIdentity | null | undefined): string {
  if (identity === null || identity === undefined || !('claims' in identity)) {
    throw new DomainError('AUTHENTICATION_REQUIRED');
  }
  const identityRecord = identity as unknown as { claims?: unknown };
  const claims = identityRecord.claims;
  if (typeof claims !== 'object' || claims === null || !('sub' in claims)) {
    throw new DomainError('AUTHENTICATION_REQUIRED');
  }
  const claim = claims.sub;
  if (typeof claim !== 'string' || claim.length === 0) {
    throw new DomainError('AUTHENTICATION_REQUIRED');
  }
  return claim;
}

export function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
