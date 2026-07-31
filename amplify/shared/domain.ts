import { PLATFORM_CONFIG, type RevenueCatEnvironment } from './config.js';
import { expectedDonationMicroUsd, formatMicroUsd } from './money.js';
import type { AllocationWrite, PlatformRepository } from './repository.js';
import { sha256 } from './security.js';
import type {
  PointPeriod,
  PointTransaction,
  RevenueCatEvent,
  RevenueCatProcessingResult,
  SettlementCalculation,
  SettlementCandidate,
  SnoozeCommand,
  SnoozeResult,
  SubscriptionState,
  SubscriptionStatus,
  WebhookRecord,
} from './types.js';

const knownRevenueCatTypes = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'PRODUCT_CHANGE',
  'CANCELLATION',
  'UNCANCELLATION',
  'EXPIRATION',
  'BILLING_ISSUE',
  'TRANSFER',
  'SUBSCRIPTION_PAUSED',
]);

const unique = (values: Array<string | undefined>): string[] =>
  values
    .filter((value): value is string => value !== undefined)
    .filter((v, i, a) => a.indexOf(v) === i);

function statusForEvent(event: RevenueCatEvent, now: string): SubscriptionStatus {
  switch (event.type) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
    case 'UNCANCELLATION':
    case 'PRODUCT_CHANGE':
      return 'ACTIVE';
    case 'CANCELLATION':
    case 'SUBSCRIPTION_PAUSED':
      return event.expiresAt !== undefined && event.expiresAt > now
        ? 'CANCELLED_PENDING_EXPIRY'
        : 'EXPIRED';
    case 'BILLING_ISSUE':
      return event.gracePeriodExpiresAt !== undefined && event.gracePeriodExpiresAt > now
        ? 'GRACE_PERIOD'
        : 'BILLING_ISSUE';
    case 'EXPIRATION':
      return 'EXPIRED';
    default:
      return 'UNKNOWN';
  }
}

function canAllocate(event: RevenueCatEvent): boolean {
  return (
    (event.type === 'INITIAL_PURCHASE' || event.type === 'RENEWAL') &&
    event.productId === PLATFORM_CONFIG.monthlyProductId &&
    event.entitlementIds.includes(PLATFORM_CONFIG.entitlementId) &&
    event.purchasedAt !== undefined &&
    event.expiresAt !== undefined
  );
}

function buildSubscription(
  event: RevenueCatEvent,
  userId: string,
  now: string,
): SubscriptionState | undefined {
  if (
    event.type === 'TRANSFER' ||
    event.appUserId === undefined ||
    event.productId === undefined ||
    event.purchasedAt === undefined ||
    event.expiresAt === undefined ||
    !event.entitlementIds.includes(PLATFORM_CONFIG.entitlementId)
  ) {
    return undefined;
  }
  const status = statusForEvent(event, now);
  return {
    id: `${userId}:${PLATFORM_CONFIG.entitlementId}:${event.environment}`,
    userId,
    revenueCatAppUserId: event.appUserId,
    entitlementId: PLATFORM_CONFIG.entitlementId,
    productId: event.productId,
    status,
    environment: event.environment,
    originalPurchaseAt: event.purchasedAt,
    currentPeriodStart: event.purchasedAt,
    currentPeriodEnd: event.expiresAt,
    autoRenew: event.autoRenew,
    lastRevenueCatEventId: event.id,
    stateEventAt: event.eventAt,
    statusEffectiveAt: status === 'EXPIRED' ? (event.expiresAt ?? event.eventAt) : event.eventAt,
    updatedAt: now,
  };
}

function buildAllocation(
  event: RevenueCatEvent,
  userId: string,
  now: string,
): AllocationWrite | undefined {
  if (!canAllocate(event) || event.purchasedAt === undefined || event.expiresAt === undefined) {
    return undefined;
  }
  const idempotencyKey = `subscription-allocation:${userId}:${PLATFORM_CONFIG.entitlementId}:${event.purchasedAt}`;
  const periodId = sha256(idempotencyKey);
  const transactionId = sha256(`transaction:${idempotencyKey}`);
  const period: PointPeriod = {
    id: periodId,
    userId,
    entitlementId: PLATFORM_CONFIG.entitlementId,
    productId: PLATFORM_CONFIG.monthlyProductId,
    periodStart: event.purchasedAt,
    periodEnd: event.expiresAt,
    environment: event.environment,
    initialAllocation: PLATFORM_CONFIG.monthlyPointAllocation,
    currentRemaining: PLATFORM_CONFIG.monthlyPointAllocation,
    status: 'ACTIVE',
    allocationTransactionId: transactionId,
    createdAt: now,
    updatedAt: now,
  };
  const transaction: PointTransaction = {
    id: transactionId,
    userId,
    environment: event.environment,
    userEnvironment: `${userId}:${event.environment}`,
    pointPeriodId: periodId,
    amount: PLATFORM_CONFIG.monthlyPointAllocation,
    transactionType: 'MONTHLY_ALLOCATION',
    reasonCode: 'ELIGIBLE_MONTHLY_SUBSCRIPTION_PERIOD',
    source: 'REVENUECAT_WEBHOOK',
    idempotencyKey,
    sourceEventId: event.id,
    relatedEventId: undefined,
    balanceAfter: PLATFORM_CONFIG.monthlyPointAllocation,
    createdAt: now,
    metadataJson: JSON.stringify({ environment: event.environment }),
  };
  return { period, transaction };
}

export async function processRevenueCatEvent(
  repository: PlatformRepository,
  event: RevenueCatEvent,
  now = new Date().toISOString(),
): Promise<RevenueCatProcessingResult> {
  const candidateIds =
    event.type === 'TRANSFER'
      ? unique([...event.transferredTo, event.appUserId, event.originalAppUserId, ...event.aliases])
      : unique([
          event.appUserId,
          event.originalAppUserId,
          ...event.aliases,
          ...event.transferredTo,
          ...event.transferredFrom,
        ]);
  const userId = await repository.resolveUserByRevenueCatIds(candidateIds);
  const known = knownRevenueCatTypes.has(event.type);
  const webhook: WebhookRecord = {
    ...event,
    userId,
    status: userId === undefined ? 'UNRESOLVED' : known ? 'PROCESSED' : 'IGNORED',
    error:
      userId === undefined ? 'No linked Cognito user matched RevenueCat identifiers' : undefined,
    receivedAt: now,
    processedAt: now,
  };

  return repository.applyRevenueCatEvent({
    event,
    webhook,
    subscription:
      userId === undefined || !known ? undefined : buildSubscription(event, userId, now),
    allocation: userId === undefined || !known ? undefined : buildAllocation(event, userId, now),
  });
}

export async function recordSnooze(
  repository: PlatformRepository,
  command: SnoozeCommand,
  now = new Date().toISOString(),
): Promise<SnoozeResult> {
  const occurredAt = Date.parse(command.occurredAt);
  const serverTime = Date.parse(now);
  if (!Number.isFinite(occurredAt)) throw new DomainError('INVALID_TIMESTAMP');
  if (occurredAt > serverTime + PLATFORM_CONFIG.snoozeFutureToleranceMs) {
    throw new DomainError('FUTURE_EVENT');
  }
  if (occurredAt < serverTime - PLATFORM_CONFIG.snoozeMaxAgeMs) {
    throw new DomainError('STALE_EVENT');
  }
  return repository.recordSnooze(command, now);
}

export function previousUtcMonth(reference = new Date()): {
  month: string;
  cutoff: string;
} {
  const startOfCurrentMonth = new Date(
    Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 1),
  );
  const previous = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() - 1, 1));
  return {
    month: `${previous.getUTCFullYear()}-${(previous.getUTCMonth() + 1).toString().padStart(2, '0')}`,
    cutoff: new Date(startOfCurrentMonth.getTime() - 1).toISOString(),
  };
}

export function calculateSettlement(
  candidates: SettlementCandidate[],
  environment: RevenueCatEnvironment,
  cutoff: string,
): SettlementCalculation {
  const eligibleStatuses: SubscriptionStatus[] = [
    'ACTIVE',
    'GRACE_PERIOD',
    'BILLING_ISSUE',
    'CANCELLED_PENDING_EXPIRY',
  ];
  const byUser = new Map<string, SettlementCandidate>();
  for (const candidate of candidates) {
    if (
      !candidate.resolved ||
      candidate.environment !== environment ||
      (!eligibleStatuses.includes(candidate.subscriptionStatus) &&
        !(
          candidate.subscriptionStatus === 'EXPIRED' &&
          candidate.subscriptionStatusEffectiveAt > cutoff
        )) ||
      candidate.periodStart > cutoff ||
      candidate.periodEnd <= cutoff
    ) {
      continue;
    }
    const previous = byUser.get(candidate.userId);
    if (previous === undefined || candidate.periodStart > previous.periodStart) {
      byUser.set(candidate.userId, candidate);
    }
  }
  let allocated = 0;
  let remaining = 0;
  for (const candidate of byUser.values()) {
    allocated += Math.max(0, candidate.allocated);
    remaining += Math.max(0, Math.min(candidate.allocated, candidate.remaining));
  }
  return {
    eligibleUserCount: byUser.size,
    totalAllocatedPoints: allocated,
    totalDeductedPoints: allocated - remaining,
    totalRemainingPoints: remaining,
    expectedDonationMicroUsd: expectedDonationMicroUsd(remaining, PLATFORM_CONFIG.microUsdPerPoint),
  };
}

export async function runSettlement(
  repository: PlatformRepository,
  month: string,
  environment: RevenueCatEnvironment,
  cutoff: string,
  now = new Date().toISOString(),
): Promise<{ duplicate: boolean; calculation: SettlementCalculation }> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new DomainError('INVALID_MONTH');
  const candidates = await repository.listSettlementCandidates(month, environment, cutoff);
  const calculation = calculateSettlement(candidates, environment, cutoff);
  const id = `${month}:${environment}:${PLATFORM_CONFIG.settlementCalculationVersion}`;
  const saved = await repository.saveSettlement({
    id,
    month,
    environment,
    cutoff,
    calculation,
    expectedDonationDisplay: formatMicroUsd(calculation.expectedDonationMicroUsd),
    now,
  });
  return { duplicate: saved.duplicate, calculation };
}

export class DomainError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = 'DomainError';
  }
}
