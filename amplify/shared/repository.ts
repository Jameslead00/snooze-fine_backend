import type {
  PointAccountView,
  PointPeriod,
  PointTransaction,
  RevenueCatEvent,
  RevenueCatProcessingResult,
  SettlementCalculation,
  SettlementCandidate,
  SnoozeCommand,
  SnoozeResult,
  SubscriptionState,
  WebhookRecord,
} from './types.js';
import type { CommunityDonationProjection } from './community-types.js';

export interface AllocationWrite {
  period: PointPeriod;
  transaction: PointTransaction;
}

export interface ApplyRevenueCatInput {
  event: RevenueCatEvent;
  webhook: WebhookRecord;
  subscription: SubscriptionState | undefined;
  allocation: AllocationWrite | undefined;
}

export interface TransactionPage {
  items: PointTransaction[];
  nextToken: string | undefined;
}

export interface PlatformRepository {
  resolveUserByRevenueCatIds(revenueCatIds: string[]): Promise<string | undefined>;
  applyRevenueCatEvent(input: ApplyRevenueCatInput): Promise<RevenueCatProcessingResult>;
  recordSnooze(command: SnoozeCommand, now: string): Promise<SnoozeResult>;
  linkRevenueCatCustomer(input: {
    userId: string;
    revenueCatAppUserId: string;
    originalAnonymousAppUserId: string | undefined;
    timezone: string;
    creatorCode: string | undefined;
    now: string;
  }): Promise<{ linked: boolean; duplicate: boolean }>;
  getPointAccountView(userId: string, now: string): Promise<PointAccountView>;
  getCommunityDonationProjection(now: string): Promise<CommunityDonationProjection>;
  listPointTransactions(
    userId: string,
    limit: number,
    nextToken: string | undefined,
  ): Promise<TransactionPage>;
  listSettlementCandidates(
    month: string,
    environment: 'SANDBOX' | 'PRODUCTION',
    cutoff: string,
  ): Promise<SettlementCandidate[]>;
  saveSettlement(input: {
    id: string;
    month: string;
    environment: 'SANDBOX' | 'PRODUCTION';
    cutoff: string;
    calculation: SettlementCalculation;
    expectedDonationDisplay: string;
    now: string;
  }): Promise<{ duplicate: boolean }>;
}
