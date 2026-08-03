import { BatchGetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import {
  DynamoPlatformRepository,
  type PlatformTableNames,
} from '../amplify/shared/dynamo-repository.js';

const tables: PlatformTableNames = {
  userProfile: 'UserProfile',
  customerLink: 'RevenueCatCustomerLink',
  webhook: 'RevenueCatWebhookEvent',
  subscription: 'SubscriptionState',
  period: 'PointPeriod',
  account: 'PointAccount',
  transaction: 'PointTransaction',
  snooze: 'SnoozeEvent',
  settlement: 'MonthlySettlement',
};

const now = '2026-08-03T12:00:00.000Z';

function period(
  id: string,
  userId: string,
  currentRemaining: number,
  periodStart: string,
  periodEnd = '2026-09-01T00:00:00.000Z',
) {
  return {
    id,
    userId,
    entitlementId: 'snoozefine_plus',
    productId: 'snoozefine_plus_monthly',
    periodStart,
    periodEnd,
    environment: 'SANDBOX',
    initialAllocation: 2_000,
    currentRemaining,
    status: 'ACTIVE',
    allocationTransactionId: `allocation-${id}`,
    createdAt: periodStart,
    updatedAt: now,
  };
}

function subscription(
  userId: string,
  status: string,
  currentPeriodEnd = '2026-09-01T00:00:00.000Z',
) {
  return {
    id: `${userId}:snoozefine_plus:SANDBOX`,
    userId,
    revenueCatAppUserId: userId,
    entitlementId: 'snoozefine_plus',
    productId: 'snoozefine_plus_monthly',
    status,
    environment: 'SANDBOX',
    originalPurchaseAt: '2026-08-01T00:00:00.000Z',
    currentPeriodStart: '2026-08-01T00:00:00.000Z',
    currentPeriodEnd,
    autoRenew: true,
    lastRevenueCatEventId: `event-${userId}`,
    stateEventAt: '2026-08-01T00:00:00.000Z',
    statusEffectiveAt: '2026-08-01T00:00:00.000Z',
    updatedAt: now,
  };
}

class ProjectionClient {
  private readonly periodPages = [
    {
      Items: [
        period('period-old', 'eligible-user', 1_000, '2026-07-01T00:00:00.000Z'),
        period('period-current', 'eligible-user', 1_500, '2026-08-01T00:00:00.000Z'),
      ],
      LastEvaluatedKey: { id: 'period-current' },
    },
    {
      Items: [
        period('period-expired-user', 'expired-user', 1_800, '2026-08-01T00:00:00.000Z'),
        period(
          'period-ended-user',
          'ended-user',
          1_700,
          '2026-08-01T00:00:00.000Z',
          '2026-08-03T11:59:59.000Z',
        ),
      ],
    },
  ];
  private periodPage = 0;

  public async send(command: unknown): Promise<Record<string, unknown>> {
    if (command instanceof QueryCommand) {
      return this.periodPages[this.periodPage++] ?? { Items: [] };
    }
    if (command instanceof BatchGetCommand) {
      const keys = command.input.RequestItems?.SubscriptionState?.Keys ?? [];
      const subscriptions = keys.flatMap((key) => {
        const userId = String(key.id).split(':')[0] ?? '';
        if (userId === 'expired-user') return [subscription(userId, 'EXPIRED')];
        if (userId === 'ended-user') {
          return [subscription(userId, 'ACTIVE', '2026-08-03T11:59:59.000Z')];
        }
        return [subscription(userId, 'ACTIVE')];
      });
      return { Responses: { SubscriptionState: subscriptions } };
    }
    throw new Error(`Unexpected command: ${String(command)}`);
  }
}

describe('community donation projection', () => {
  it('sums one current period per eligible member and excludes stale periods', async () => {
    const repository = new DynamoPlatformRepository(
      tables,
      'SANDBOX',
      new ProjectionClient() as unknown as DynamoDBDocumentClient,
    );

    await expect(repository.getCommunityDonationProjection(now)).resolves.toEqual({
      eligibleMemberCount: 1,
      remainingPoints: 1_500,
      expectedDonationMicroUsd: 1_500_000,
    });
  });
});
