import type { RevenueCatEnvironment } from './config.js';

export type SubscriptionStatus = 'ACTIVE' | 'GRACE_PERIOD' | 'BILLING_ISSUE' | 'CANCELLED_PENDING_EXPIRY' | 'EXPIRED' | 'UNKNOWN';
export type WebhookStatus = 'PROCESSED' | 'UNRESOLVED' | 'IGNORED' | 'FAILED';
export interface RevenueCatEvent { id: string; type: string; appUserId: string | undefined; originalAppUserId: string | undefined; aliases: string[]; transferredFrom: string[]; transferredTo: string[]; productId: string | undefined; entitlementIds: string[]; eventAt: string; purchasedAt: string | undefined; expiresAt: string | undefined; gracePeriodExpiresAt: string | undefined; environment: RevenueCatEnvironment; autoRenew: boolean | undefined; payloadHash: string; rawMetadata: string; }
export interface WebhookRecord extends RevenueCatEvent { userId: string | undefined; status: WebhookStatus; error: string | undefined; receivedAt: string; processedAt: string; }
export interface SubscriptionState { id: string; userId: string; revenueCatAppUserId: string; entitlementId: string; productId: string; status: SubscriptionStatus; environment: RevenueCatEnvironment; originalPurchaseAt: string; currentPeriodStart: string; currentPeriodEnd: string; autoRenew: boolean | undefined; lastRevenueCatEventId: string; stateEventAt: string; statusEffectiveAt: string; updatedAt: string; }
export interface RevenueCatProcessingResult { duplicate: boolean; status: WebhookStatus; allocatedPoints: 0; userId: string | undefined; }
