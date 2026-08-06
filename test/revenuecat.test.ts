import { describe, expect, it } from 'vitest';
import { processRevenueCatEvent } from '../amplify/shared/domain.js';
import type { ApplyRevenueCatInput, PlatformRepository } from '../amplify/shared/repository.js';
import { revenueCatEvent } from './fixtures.js';

class InMemorySubscriptionRepository implements PlatformRepository {
  public readonly links = new Map<string, string>();
  public readonly webhooks = new Map<string, ApplyRevenueCatInput>();
  public readonly subscriptions = new Map<string, NonNullable<ApplyRevenueCatInput['subscription']>>();

  public async resolveUserByRevenueCatIds(ids: string[]): Promise<string | undefined> {
    return ids.map((id) => this.links.get(id)).find((id) => id !== undefined);
  }

  public async applyRevenueCatEvent(input: ApplyRevenueCatInput) {
    const previous = this.webhooks.get(input.event.id);
    if (previous !== undefined) {
      return { duplicate: true, status: previous.webhook.status, allocatedPoints: 0 as const, userId: previous.webhook.userId };
    }
    this.webhooks.set(input.event.id, input);
    if (input.subscription !== undefined) this.subscriptions.set(input.subscription.id, input.subscription);
    return { duplicate: false, status: input.webhook.status, allocatedPoints: 0 as const, userId: input.webhook.userId };
  }

  public async reconcileRevenueCatSubscription(input: {
    subscription: NonNullable<ApplyRevenueCatInput['subscription']>;
    now: string;
  }): Promise<void> {
    this.subscriptions.set(input.subscription.id, input.subscription);
  }

  public async linkRevenueCatCustomer(): Promise<{ linked: boolean; duplicate: boolean }> {
    return { linked: true, duplicate: false };
  }
}

describe('RevenueCat subscription entitlement processing', () => {
  it('updates entitlement state without granting points', async () => {
    const repository = new InMemorySubscriptionRepository();
    repository.links.set('user-1', 'cognito-1');
    const result = await processRevenueCatEvent(repository, revenueCatEvent(), '2026-07-01T00:00:02.000Z');
    expect(result).toMatchObject({ duplicate: false, allocatedPoints: 0, userId: 'cognito-1' });
    expect([...repository.subscriptions.values()][0]).toMatchObject({ status: 'ACTIVE', userId: 'cognito-1' });
  });

  it('makes a repeated webhook idempotent without granting points', async () => {
    const repository = new InMemorySubscriptionRepository();
    repository.links.set('user-1', 'cognito-1');
    const event = revenueCatEvent();
    await processRevenueCatEvent(repository, event, '2026-07-01T00:00:02.000Z');
    await expect(processRevenueCatEvent(repository, event, '2026-07-01T00:00:03.000Z')).resolves.toMatchObject({ duplicate: true, allocatedPoints: 0 });
  });
});
