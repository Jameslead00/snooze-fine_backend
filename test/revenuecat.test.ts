import { describe, expect, it } from 'vitest';
import { processRevenueCatEvent } from '../amplify/shared/domain.js';
import { revenueCatEvent } from './fixtures.js';
import { InMemoryRepository } from './support/in-memory-repository.js';

const now = '2026-07-01T00:00:02.000Z';

describe('RevenueCat processing', () => {
  it('allocates exactly 2,000 points on an eligible initial purchase', async () => {
    const repository = new InMemoryRepository();
    repository.link('cognito-1', 'user-1');

    const result = await processRevenueCatEvent(repository, revenueCatEvent(), now);

    expect(result.allocatedPoints).toBe(2_000);
    expect(repository.accounts.get('cognito-1')?.currentBalance).toBe(2_000);
    expect([...repository.transactions.values()]).toHaveLength(1);
  });

  it('does not process or allocate a duplicate webhook twice', async () => {
    const repository = new InMemoryRepository();
    repository.link('cognito-1', 'user-1');
    const event = revenueCatEvent();

    await processRevenueCatEvent(repository, event, now);
    const duplicate = await processRevenueCatEvent(repository, event, now);

    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.allocatedPoints).toBe(0);
    expect(repository.accounts.get('cognito-1')?.lifetimeAllocated).toBe(2_000);
  });

  it('allocates a renewal period once', async () => {
    const repository = new InMemoryRepository();
    repository.link('cognito-1', 'user-1');
    await processRevenueCatEvent(repository, revenueCatEvent(), now);
    const renewal = revenueCatEvent({
      id: 'rc-event-renewal',
      type: 'RENEWAL',
      purchasedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-09-01T00:00:00.000Z',
      eventAt: '2026-08-01T00:00:01.000Z',
    });

    await processRevenueCatEvent(repository, renewal, '2026-08-01T00:00:02.000Z');
    await processRevenueCatEvent(repository, renewal, '2026-08-01T00:00:03.000Z');

    expect(repository.periods.size).toBe(2);
    expect(repository.accounts.get('cognito-1')).toMatchObject({
      currentBalance: 2_000,
      lifetimeAllocated: 4_000,
    });
  });

  it('never rolls the active account backward when an older allocation arrives late', async () => {
    const repository = new InMemoryRepository();
    repository.link('cognito-1', 'user-1');
    const renewal = revenueCatEvent({
      id: 'newer-renewal',
      type: 'RENEWAL',
      purchasedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-09-01T00:00:00.000Z',
      eventAt: '2026-08-01T00:00:01.000Z',
    });
    await processRevenueCatEvent(repository, renewal, '2026-08-01T00:00:02.000Z');
    const newerPeriodID = repository.accounts.get('cognito-1')?.activePeriodId;

    await processRevenueCatEvent(
      repository,
      revenueCatEvent({ id: 'late-initial', eventAt: '2026-07-01T00:00:01.000Z' }),
      '2026-08-01T00:01:00.000Z',
    );

    expect(repository.accounts.get('cognito-1')).toMatchObject({
      activePeriodId: newerPeriodID,
      currentBalance: 2_000,
      lifetimeAllocated: 4_000,
    });
  });

  it('keeps an unexpired cancelled subscription and its points eligible', async () => {
    const repository = new InMemoryRepository();
    repository.link('cognito-1', 'user-1');
    await processRevenueCatEvent(repository, revenueCatEvent(), now);
    await processRevenueCatEvent(
      repository,
      revenueCatEvent({ id: 'cancel-1', type: 'CANCELLATION' }),
      '2026-07-15T00:00:00.000Z',
    );

    expect(repository.subscriptions.get('cognito-1')?.status).toBe('CANCELLED_PENDING_EXPIRY');
    expect(repository.accounts.get('cognito-1')?.currentBalance).toBe(2_000);
    await expect(
      repository.getPointAccountView('cognito-1', '2026-07-15T00:00:01.000Z'),
    ).resolves.toMatchObject({ isEligible: true });
  });

  it('expiration performs no allocation and marks the subscription expired', async () => {
    const repository = new InMemoryRepository();
    repository.link('cognito-1', 'user-1');
    await processRevenueCatEvent(repository, revenueCatEvent(), now);

    const result = await processRevenueCatEvent(
      repository,
      revenueCatEvent({ id: 'expire-1', type: 'EXPIRATION' }),
      '2026-08-01T00:00:01.000Z',
    );

    expect(result.allocatedPoints).toBe(0);
    expect(repository.periods.size).toBe(1);
    expect(repository.subscriptions.get('cognito-1')?.status).toBe('EXPIRED');
    await expect(
      repository.getPointAccountView('cognito-1', '2026-08-01T00:00:02.000Z'),
    ).resolves.toMatchObject({ isEligible: false });
  });

  it('stores unknown users as unresolved instead of dropping the event', async () => {
    const repository = new InMemoryRepository();

    const result = await processRevenueCatEvent(repository, revenueCatEvent(), now);

    expect(result.status).toBe('UNRESOLVED');
    expect(repository.webhooks.get('rc-event-1')?.error).toMatch(/No linked Cognito user/);
  });

  it('records an unknown event type as a safe no-op', async () => {
    const repository = new InMemoryRepository();
    repository.link('cognito-1', 'user-1');

    const result = await processRevenueCatEvent(
      repository,
      revenueCatEvent({ type: 'FUTURE_EVENT' }),
      now,
    );

    expect(result.status).toBe('IGNORED');
    expect(repository.accounts.size).toBe(0);
  });

  it('audits a transfer against the destination without allocating points', async () => {
    const repository = new InMemoryRepository();
    repository.link('source-user', 'source-rc');
    repository.link('destination-user', 'destination-rc');

    const result = await processRevenueCatEvent(
      repository,
      revenueCatEvent({
        id: 'transfer-1',
        type: 'TRANSFER',
        appUserId: undefined,
        originalAppUserId: undefined,
        aliases: [],
        transferredFrom: ['source-rc'],
        transferredTo: ['destination-rc'],
        productId: undefined,
        entitlementIds: [],
        purchasedAt: undefined,
        expiresAt: undefined,
      }),
      now,
    );

    expect(result).toMatchObject({
      userId: 'destination-user',
      status: 'PROCESSED',
      allocatedPoints: 0,
    });
    expect(repository.periods.size).toBe(0);
  });
});
