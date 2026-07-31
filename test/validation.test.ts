import { describe, expect, it } from 'vitest';
import { parseRevenueCatPayload } from '../amplify/shared/validation.js';

describe('RevenueCat payload validation', () => {
  it('accepts RevenueCat dashboard TEST events with null entitlement_ids', () => {
    const event = parseRevenueCatPayload(
      JSON.stringify({
        api_version: '1.0',
        event: {
          aliases: ['6969840a-12c2-4bd4-acbf-27e46d4c7889'],
          app_id: 'appa4aad09f0b',
          app_user_id: '6969840a-12c2-4bd4-acbf-27e46d4c7889',
          entitlement_id: null,
          entitlement_ids: null,
          environment: 'SANDBOX',
          event_timestamp_ms: 1785506766774,
          expiration_at_ms: 1785513966774,
          id: 'D3CC81CA-9DD7-4FC3-8FAD-C33B85EFEEC2',
          original_app_user_id: '6969840a-12c2-4bd4-acbf-27e46d4c7889',
          period_type: 'NORMAL',
          product_id: 'test_product',
          purchased_at_ms: 1785506766774,
          store: 'PLAY_STORE',
          transaction_id: null,
          original_transaction_id: null,
          type: 'TEST',
        },
      }),
    );

    expect(event).toMatchObject({
      id: 'D3CC81CA-9DD7-4FC3-8FAD-C33B85EFEEC2',
      type: 'TEST',
      environment: 'SANDBOX',
      entitlementIds: [],
    });
  });
});
