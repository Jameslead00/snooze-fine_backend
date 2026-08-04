import { PLATFORM_CONFIG } from '../../amplify/shared/config.js';
import { DomainError } from '../../amplify/shared/domain.js';
import { expectedDonationMicroUsd } from '../../amplify/shared/money.js';
import type { CommunityDonationProjection } from '../../amplify/shared/community-types.js';
import type {
  ApplyRevenueCatInput,
  PlatformRepository,
  TransactionPage,
} from '../../amplify/shared/repository.js';
import type {
  PointAccount,
  PointAccountView,
  PointPeriod,
  PointTransaction,
  RevenueCatProcessingResult,
  SettlementCandidate,
  SnoozeCommand,
  SnoozeResult,
  SubscriptionState,
  WebhookRecord,
} from '../../amplify/shared/types.js';

interface StoredSnooze {
  userId: string;
  result: SnoozeResult;
}

export class InMemoryRepository implements PlatformRepository {
  public readonly links = new Map<string, string>();
  public readonly creatorAttributions = new Map<string, string>();
  public readonly webhooks = new Map<string, WebhookRecord>();
  public readonly subscriptions = new Map<string, SubscriptionState>();
  public readonly periods = new Map<string, PointPeriod>();
  public readonly accounts = new Map<string, PointAccount>();
  public readonly transactions = new Map<string, PointTransaction>();
  public readonly snoozes = new Map<string, StoredSnooze>();
  public readonly settlements = new Map<string, object>();

  public link(userId: string, ...revenueCatIds: string[]): void {
    for (const id of revenueCatIds) this.links.set(id, userId);
  }

  public async resolveUserByRevenueCatIds(ids: string[]): Promise<string | undefined> {
    for (const id of ids) {
      const userId = this.links.get(id);
      if (userId !== undefined) return userId;
    }
    return undefined;
  }

  public async applyRevenueCatEvent(
    input: ApplyRevenueCatInput,
  ): Promise<RevenueCatProcessingResult> {
    const existing = this.webhooks.get(input.event.id);
    if (existing !== undefined) {
      return {
        duplicate: true,
        status: existing.status,
        allocatedPoints: 0,
        userId: existing.userId,
      };
    }
    this.webhooks.set(input.event.id, input.webhook);
    if (input.subscription !== undefined) {
      this.subscriptions.set(input.subscription.userId, input.subscription);
    }
    let allocatedPoints = 0;
    if (input.allocation !== undefined && !this.periods.has(input.allocation.period.id)) {
      const { period, transaction } = input.allocation;
      this.periods.set(period.id, period);
      const previous = this.accounts.get(period.userId);
      const currentPeriod =
        previous?.activePeriodId === undefined
          ? undefined
          : this.periods.get(previous.activePeriodId);
      const shouldActivatePeriod =
        currentPeriod === undefined || period.periodStart > currentPeriod.periodStart;
      const account: PointAccount = {
        id: period.userId,
        userId: period.userId,
        environment: period.environment,
        currentBalance: shouldActivatePeriod
          ? period.initialAllocation
          : (previous?.currentBalance ?? period.initialAllocation),
        activePeriodId: shouldActivatePeriod ? period.id : previous?.activePeriodId,
        lifetimeAllocated: (previous?.lifetimeAllocated ?? 0) + period.initialAllocation,
        lifetimeDeducted: previous?.lifetimeDeducted ?? 0,
        version: (previous?.version ?? 0) + 1,
        updatedAt: input.webhook.processedAt,
      };
      this.accounts.set(period.userId, account);
      this.transactions.set(transaction.id, {
        ...transaction,
        balanceAfter: period.initialAllocation,
      });
      allocatedPoints = period.initialAllocation;
    }
    return {
      duplicate: false,
      status: input.webhook.status,
      allocatedPoints,
      userId: input.webhook.userId,
    };
  }

  public async recordSnooze(command: SnoozeCommand, now: string): Promise<SnoozeResult> {
    const key = `snooze:${command.userId}:${command.snoozeEventId}`;
    const existing = this.snoozes.get(key);
    if (existing !== undefined) return { ...existing.result, duplicate: true };
    const result: SnoozeResult = {
      accepted: true,
      duplicate: false,
      pointsDeducted: 0,
      officialBalance: 0,
      activePointPeriodId: 'earned-points',
      serverTimestamp: now,
    };
    this.snoozes.set(key, { userId: command.userId, result });
    return result;
  }

  public async linkRevenueCatCustomer(input: {
    userId: string;
    revenueCatAppUserId: string;
    originalAnonymousAppUserId: string | undefined;
    timezone: string;
    creatorCode: string | undefined;
    now: string;
  }): Promise<{ linked: boolean; duplicate: boolean }> {
    const stableOwner = this.links.get(input.revenueCatAppUserId);
    const aliasOwner =
      input.originalAnonymousAppUserId === undefined
        ? undefined
        : this.links.get(input.originalAnonymousAppUserId);
    if (
      (stableOwner !== undefined && stableOwner !== input.userId) ||
      (aliasOwner !== undefined && aliasOwner !== input.userId)
    ) {
      throw new DomainError('REVENUECAT_ID_ALREADY_LINKED');
    }
    const duplicate = stableOwner === input.userId && (aliasOwner ?? input.userId) === input.userId;
    this.links.set(input.revenueCatAppUserId, input.userId);
    if (input.originalAnonymousAppUserId !== undefined) {
      this.links.set(input.originalAnonymousAppUserId, input.userId);
    }
    if (input.creatorCode !== undefined && !this.creatorAttributions.has(input.userId)) {
      this.creatorAttributions.set(input.userId, input.creatorCode);
    }
    return { linked: true, duplicate };
  }

  public async getPointAccountView(userId: string, now: string): Promise<PointAccountView> {
    const account = this.accounts.get(userId);
    const subscription = this.subscriptions.get(userId);
    const period =
      account?.activePeriodId === undefined ? undefined : this.periods.get(account.activePeriodId);
    const balance = account?.currentBalance ?? 0;
    const isEligible =
      account?.activePeriodId !== undefined &&
      subscription !== undefined &&
      ['ACTIVE', 'GRACE_PERIOD', 'BILLING_ISSUE', 'CANCELLED_PENDING_EXPIRY'].includes(
        subscription.status,
      ) &&
      subscription.currentPeriodEnd > now &&
      period !== undefined &&
      period.userId === userId &&
      period.environment === account.environment &&
      period.status === 'ACTIVE' &&
      period.periodEnd > now;
    return {
      isEligible,
      officialBalance: balance,
      activePointPeriodId: period?.id,
      initialAllocation: period?.initialAllocation ?? 0,
      pointsDeducted: (period?.initialAllocation ?? 0) - (period?.currentRemaining ?? 0),
      periodStart: period?.periodStart,
      periodEnd: period?.periodEnd,
      subscriptionStatus: subscription?.status ?? 'UNKNOWN',
      donationMicroUsd: expectedDonationMicroUsd(balance, PLATFORM_CONFIG.microUsdPerPoint),
      serverTimestamp: now,
    };
  }

  public async getCommunityDonationProjection(now: string): Promise<CommunityDonationProjection> {
    const views = await Promise.all(
      [...this.accounts.values()].map((account) => this.getPointAccountView(account.userId, now)),
    );
    const eligibleViews = views.filter((view) => view.isEligible);
    const remainingPoints = eligibleViews.reduce((total, view) => total + view.officialBalance, 0);
    return {
      eligibleMemberCount: eligibleViews.length,
      remainingPoints,
      expectedDonationMicroUsd: expectedDonationMicroUsd(
        remainingPoints,
        PLATFORM_CONFIG.microUsdPerPoint,
      ),
    };
  }

  public async listPointTransactions(
    userId: string,
    limit: number,
    nextToken: string | undefined,
  ): Promise<TransactionPage> {
    const offset = nextToken === undefined ? 0 : Number.parseInt(nextToken, 10);
    const matches = [...this.transactions.values()]
      .filter((transaction) => transaction.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const items = matches.slice(offset, offset + limit);
    return {
      items,
      nextToken: offset + items.length < matches.length ? String(offset + items.length) : undefined,
    };
  }

  public async listSettlementCandidates(
    _month: string,
    environment: 'SANDBOX' | 'PRODUCTION',
    _cutoff: string,
  ): Promise<SettlementCandidate[]> {
    return [...this.periods.values()].map((period) => {
      const subscription = this.subscriptions.get(period.userId);
      return {
        userId: period.userId,
        environment,
        resolved: true,
        subscriptionStatus: subscription?.status ?? 'UNKNOWN',
        subscriptionStatusEffectiveAt: subscription?.statusEffectiveAt ?? period.periodStart,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        allocated: period.initialAllocation,
        remaining: period.currentRemaining,
      };
    });
  }

  public async saveSettlement(input: { id: string }): Promise<{ duplicate: boolean }> {
    if (this.settlements.has(input.id)) return { duplicate: true };
    this.settlements.set(input.id, input);
    return { duplicate: false };
  }
}
