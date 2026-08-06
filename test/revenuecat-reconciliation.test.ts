import { describe, expect, it } from 'vitest';
import { subscriptionFromRevenueCatCustomerInfo } from '../amplify/shared/revenuecat-reconciliation.js';

const now = '2026-08-06T12:00:00.000Z';

describe('RevenueCat server reconciliation', () => {
  it('maps an active TestFlight entitlement to sandbox subscription state', () => {
    const subscription = subscriptionFromRevenueCatCustomerInfo(
      {
        request_date: now,
        entitlements: {
          snoozefine_plus: {
            product_identifier: 'snoozefine_plus_monthly',
            purchase_date: '2026-08-01T12:00:00Z',
            expires_date: '2026-09-01T12:00:00Z',
          },
        },
        subscriptions: {
          snoozefine_plus_monthly: {
            product_identifier: 'snoozefine_plus_monthly',
            original_purchase_date: '2026-08-01T12:00:00Z',
            purchase_date: '2026-08-01T12:00:00Z',
            expires_date: '2026-09-01T12:00:00Z',
            is_sandbox: true,
            will_renew: true,
          },
        },
      },
      'cognito-1',
      'cognito-1',
      now,
    );

    expect(subscription).toMatchObject({
      userId: 'cognito-1',
      environment: 'SANDBOX',
      status: 'ACTIVE',
      productId: 'snoozefine_plus_monthly',
      autoRenew: true,
    });
  });

  it('does not create state when the configured entitlement is absent', () => {
    expect(
      subscriptionFromRevenueCatCustomerInfo(
        { entitlements: {}, subscriptions: {} },
        'cognito-1',
        'cognito-1',
        now,
      ),
    ).toBeUndefined();
  });
});
