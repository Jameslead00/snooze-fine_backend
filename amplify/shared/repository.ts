import type { RevenueCatEvent, RevenueCatProcessingResult, SubscriptionState, WebhookRecord } from './types.js';

export interface ApplyRevenueCatInput { event: RevenueCatEvent; webhook: WebhookRecord; subscription: SubscriptionState | undefined; }

export interface PlatformRepository {
  resolveUserByRevenueCatIds(revenueCatIds: string[]): Promise<string | undefined>;
  applyRevenueCatEvent(input: ApplyRevenueCatInput): Promise<RevenueCatProcessingResult>;
  linkRevenueCatCustomer(input: { userId: string; revenueCatAppUserId: string; originalAnonymousAppUserId: string | undefined; timezone: string; creatorCode: string | undefined; now: string }): Promise<{ linked: boolean; duplicate: boolean }>;
}
