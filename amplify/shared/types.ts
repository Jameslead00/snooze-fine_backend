import type { RevenueCatEnvironment } from './config.js';

export type SubscriptionStatus =
  'ACTIVE' | 'GRACE_PERIOD' | 'BILLING_ISSUE' | 'CANCELLED_PENDING_EXPIRY' | 'EXPIRED' | 'UNKNOWN';

export type WebhookStatus = 'PROCESSED' | 'UNRESOLVED' | 'IGNORED' | 'FAILED';

export type PointTransactionType =
  'MONTHLY_ALLOCATION' | 'SNOOZE_DEDUCTION' | 'HABIT_DEDUCTION' | 'ADMIN_ADJUSTMENT';

export type PointTransactionSource =
  'REVENUECAT_WEBHOOK' | 'IOS_APP' | 'ACCOUNTABILITY_ENGINE' | 'ADMIN';

export interface RevenueCatEvent {
  id: string;
  type: string;
  appUserId: string | undefined;
  originalAppUserId: string | undefined;
  aliases: string[];
  transferredFrom: string[];
  transferredTo: string[];
  productId: string | undefined;
  entitlementIds: string[];
  eventAt: string;
  purchasedAt: string | undefined;
  expiresAt: string | undefined;
  gracePeriodExpiresAt: string | undefined;
  environment: RevenueCatEnvironment;
  autoRenew: boolean | undefined;
  payloadHash: string;
  rawMetadata: string;
}

export interface WebhookRecord extends RevenueCatEvent {
  userId: string | undefined;
  status: WebhookStatus;
  error: string | undefined;
  receivedAt: string;
  processedAt: string;
}

export interface SubscriptionState {
  id: string;
  userId: string;
  revenueCatAppUserId: string;
  entitlementId: string;
  productId: string;
  status: SubscriptionStatus;
  environment: RevenueCatEnvironment;
  originalPurchaseAt: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  autoRenew: boolean | undefined;
  lastRevenueCatEventId: string;
  stateEventAt: string;
  statusEffectiveAt: string;
  updatedAt: string;
}

export interface PointPeriod {
  id: string;
  userId: string;
  entitlementId: string;
  productId: string;
  periodStart: string;
  periodEnd: string;
  environment: RevenueCatEnvironment;
  initialAllocation: number;
  currentRemaining: number;
  status: 'ACTIVE' | 'EXPIRED';
  allocationTransactionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PointAccount {
  id: string;
  userId: string;
  environment: RevenueCatEnvironment;
  currentBalance: number;
  activePeriodId: string | undefined;
  lifetimeAllocated: number;
  lifetimeDeducted: number;
  version: number;
  updatedAt: string;
}

export interface PointTransaction {
  id: string;
  userId: string;
  environment: RevenueCatEnvironment;
  userEnvironment: string;
  pointPeriodId: string;
  amount: number;
  transactionType: PointTransactionType;
  reasonCode: string;
  source: PointTransactionSource;
  idempotencyKey: string;
  sourceEventId: string;
  relatedEventId: string | undefined;
  balanceAfter: number;
  createdAt: string;
  metadataJson: string | undefined;
}

export interface SnoozeCommand {
  userId: string;
  alarmId: string;
  alarmOccurrenceId: string;
  snoozeEventId: string;
  occurredAt: string;
  legacyPurchaseReference?: string | undefined;
  clientAppVersion?: string | undefined;
}

export interface SnoozeResult {
  accepted: boolean;
  duplicate: boolean;
  pointsDeducted: number;
  officialBalance: number;
  activePointPeriodId: string;
  serverTimestamp: string;
}

export interface PointAccountView {
  isEligible: boolean;
  officialBalance: number;
  activePointPeriodId: string | undefined;
  initialAllocation: number;
  pointsDeducted: number;
  periodStart: string | undefined;
  periodEnd: string | undefined;
  subscriptionStatus: SubscriptionStatus;
  donationMicroUsd: number;
  serverTimestamp: string;
}

export interface SettlementCandidate {
  userId: string;
  environment: RevenueCatEnvironment;
  resolved: boolean;
  subscriptionStatus: SubscriptionStatus;
  subscriptionStatusEffectiveAt: string;
  periodStart: string;
  periodEnd: string;
  allocated: number;
  remaining: number;
}

export interface SettlementCalculation {
  eligibleUserCount: number;
  totalAllocatedPoints: number;
  totalDeductedPoints: number;
  totalRemainingPoints: number;
  expectedDonationMicroUsd: number;
}

export interface RevenueCatProcessingResult {
  duplicate: boolean;
  status: WebhookStatus;
  allocatedPoints: number;
  userId: string | undefined;
}
