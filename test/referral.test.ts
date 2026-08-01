import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from './support/in-memory-repository.js';

describe('creator signup attribution', () => {
  it('records one creator code and never replaces it during later identity links', async () => {
    const repository = new InMemoryRepository();
    const baseInput = {
      userId: 'cognito-1',
      revenueCatAppUserId: 'cognito-1',
      originalAnonymousAppUserId: '$RCAnonymousID:signup',
      timezone: 'Europe/Zurich',
      now: '2026-07-31T18:00:00.000Z',
    };

    await repository.linkRevenueCatCustomer({ ...baseInput, creatorCode: 'CREATOR1' });
    await repository.linkRevenueCatCustomer({
      ...baseInput,
      creatorCode: 'CREATOR2',
      now: '2026-07-31T18:01:00.000Z',
    });

    expect(repository.creatorAttributions.get('cognito-1')).toBe('CREATOR1');
  });
});
