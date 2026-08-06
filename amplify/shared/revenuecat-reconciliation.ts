import { PLATFORM_CONFIG, configuredEnvironment, type RevenueCatEnvironment } from './config.js';
import { sha256 } from './security.js';
import type { SubscriptionState, SubscriptionStatus } from './types.js';

type JsonRecord = Record<string, unknown>;

export interface RevenueCatEntitlementInfo {
  product_identifier?: unknown;
  purchase_date?: unknown;
  expires_date?: unknown;
  grace_period_expires_date?: unknown;
  store?: unknown;
}

export interface RevenueCatSubscriptionInfo {
  product_identifier?: unknown;
  purchase_date?: unknown;
  original_purchase_date?: unknown;
  expires_date?: unknown;
  grace_period_expires_date?: unknown;
  unsubscribe_detected_at?: unknown;
  billing_issues_detected_at?: unknown;
  is_sandbox?: unknown;
  will_renew?: unknown;
  auto_renew_status?: unknown;
}

export interface RevenueCatCustomerInfo {
  request_date?: unknown;
  entitlements?: unknown;
  subscriptions?: unknown;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const booleanValue = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const dateValue = (value: unknown): string | undefined => {
  const valueAsString = stringValue(value);
  if (valueAsString === undefined || Number.isNaN(Date.parse(valueAsString))) return undefined;
  return new Date(valueAsString).toISOString();
};

const hasPassed = (value: string | undefined, now: string): boolean =>
  value !== undefined && Date.parse(value) <= Date.parse(now);

function environmentForSubscription(
  subscription: RevenueCatSubscriptionInfo | undefined,
): RevenueCatEnvironment {
  if (subscription?.is_sandbox === true) return 'SANDBOX';
  if (subscription?.is_sandbox === false) return 'PRODUCTION';
  return configuredEnvironment();
}

function statusForCustomerInfo(
  entitlement: RevenueCatEntitlementInfo,
  subscription: RevenueCatSubscriptionInfo | undefined,
  expiresAt: string | undefined,
  now: string,
): SubscriptionStatus {
  if (hasPassed(expiresAt, now)) return 'EXPIRED';

  const gracePeriodExpiresAt = dateValue(
    entitlement.grace_period_expires_date ?? subscription?.grace_period_expires_date,
  );
  if (gracePeriodExpiresAt !== undefined && !hasPassed(gracePeriodExpiresAt, now)) {
    return 'GRACE_PERIOD';
  }

  if (stringValue(subscription?.billing_issues_detected_at) !== undefined) {
    return 'BILLING_ISSUE';
  }
  if (stringValue(subscription?.unsubscribe_detected_at) !== undefined) {
    return 'CANCELLED_PENDING_EXPIRY';
  }
  return 'ACTIVE';
}

function subscriptionForProduct(
  subscriptions: unknown,
  productId: string,
): RevenueCatSubscriptionInfo | undefined {
  if (!isRecord(subscriptions)) return undefined;
  const matching = Object.values(subscriptions).find((value) => {
    if (!isRecord(value)) return false;
    return stringValue(value.product_identifier) === productId;
  });
  return isRecord(matching) ? matching : undefined;
}

/**
 * Convert RevenueCat's server-side Customer Info response into the same
 * subscription state used by webhook processing. This is intentionally based
 * on the configured entitlement, not on a client-supplied eligibility flag.
 */
export function subscriptionFromRevenueCatCustomerInfo(
  customerInfo: RevenueCatCustomerInfo,
  userId: string,
  revenueCatAppUserId: string,
  now: string,
): SubscriptionState | undefined {
  if (!isRecord(customerInfo.entitlements)) return undefined;
  const entitlementValue = customerInfo.entitlements[PLATFORM_CONFIG.entitlementId];
  if (!isRecord(entitlementValue)) return undefined;
  const entitlement = entitlementValue as RevenueCatEntitlementInfo;
  const productId = stringValue(entitlement.product_identifier);
  if (productId === undefined) return undefined;

  const subscription = subscriptionForProduct(customerInfo.subscriptions, productId);
  const purchasedAt = dateValue(subscription?.purchase_date ?? entitlement.purchase_date);
  const originalPurchaseAt = dateValue(
    subscription?.original_purchase_date ?? subscription?.purchase_date ?? entitlement.purchase_date,
  );
  const expiresAt = dateValue(subscription?.expires_date ?? entitlement.expires_date);
  if (purchasedAt === undefined || originalPurchaseAt === undefined || expiresAt === undefined) {
    return undefined;
  }

  const environment = environmentForSubscription(subscription);
  const status = statusForCustomerInfo(entitlement, subscription, expiresAt, now);
  const stateEventAt = dateValue(customerInfo.request_date) ?? now;
  const reconciliationKey = JSON.stringify({
    appUserId: revenueCatAppUserId,
    entitlementId: PLATFORM_CONFIG.entitlementId,
    productId,
    environment,
    purchasedAt,
    expiresAt,
    status,
    stateEventAt,
  });

  return {
    id: `${userId}:${PLATFORM_CONFIG.entitlementId}:${environment}`,
    userId,
    revenueCatAppUserId,
    entitlementId: PLATFORM_CONFIG.entitlementId,
    productId,
    status,
    environment,
    originalPurchaseAt,
    currentPeriodStart: purchasedAt,
    currentPeriodEnd: expiresAt,
    autoRenew:
      booleanValue(subscription?.will_renew) ?? booleanValue(subscription?.auto_renew_status),
    lastRevenueCatEventId: `RECONCILIATION:${sha256(reconciliationKey)}`,
    stateEventAt,
    statusEffectiveAt: status === 'EXPIRED' ? expiresAt : stateEventAt,
    updatedAt: now,
  };
}

export class RevenueCatApiError extends Error {
  public constructor(public readonly status: number) {
    super(`RevenueCat customer lookup failed with HTTP ${status}`);
    this.name = 'RevenueCatApiError';
  }
}

function customerInfoFromResponse(body: unknown): RevenueCatCustomerInfo {
  if (!isRecord(body)) throw new Error('RevenueCat customer lookup returned an invalid response');
  const directSubscriber = body.subscriber;
  const wrappedValue = isRecord(body.value) ? body.value.subscriber : undefined;
  const subscriber = isRecord(directSubscriber) ? directSubscriber : wrappedValue;
  if (!isRecord(subscriber)) {
    throw new Error('RevenueCat customer lookup returned no subscriber');
  }
  return subscriber;
}

export async function fetchRevenueCatCustomerInfo(
  appUserId: string,
  apiKey = process.env.REVENUECAT_SECRET_API_KEY,
  fetchImplementation: typeof fetch = fetch,
): Promise<RevenueCatCustomerInfo | undefined> {
  if (apiKey === undefined || apiKey.trim().length === 0) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetchImplementation(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`,
      {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new RevenueCatApiError(response.status);
    return customerInfoFromResponse(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}
