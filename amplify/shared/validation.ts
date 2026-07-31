import { z } from 'zod';
import { PLATFORM_CONFIG } from './config.js';
import { sha256 } from './security.js';
import type { RevenueCatEvent } from './types.js';

const maxJavaScriptTimestampMs = 8_640_000_000_000_000;
const optionalMillis = z
  .number()
  .int()
  .nonnegative()
  .max(maxJavaScriptTimestampMs)
  .nullable()
  .optional();

const revenueCatEnvelopeSchema = z.object({
  api_version: z.string(),
  event: z
    .object({
      id: z.string().min(1).max(200),
      type: z.string().min(1).max(100),
      app_user_id: z.string().min(1).max(512).nullable().optional(),
      original_app_user_id: z.string().min(1).max(512).nullable().optional(),
      aliases: z.array(z.string().min(1).max(512)).max(100).nullable().optional(),
      transferred_from: z.array(z.string().min(1).max(512)).max(100).nullable().optional(),
      transferred_to: z.array(z.string().min(1).max(512)).max(100).nullable().optional(),
      product_id: z.string().min(1).max(512).nullable().optional(),
      entitlement_id: z.string().min(1).max(512).nullable().optional(),
      entitlement_ids: z.array(z.string().min(1).max(512)).max(100).nullable().optional(),
      event_timestamp_ms: z.number().int().nonnegative().max(maxJavaScriptTimestampMs),
      purchased_at_ms: optionalMillis,
      expiration_at_ms: optionalMillis,
      grace_period_expiration_at_ms: optionalMillis,
      environment: z.enum(['SANDBOX', 'PRODUCTION']).nullable().optional(),
      auto_renew_status: z.boolean().nullable().optional(),
      store: z.string().max(100).nullable().optional(),
      period_type: z.string().max(100).nullable().optional(),
      cancel_reason: z.string().max(100).nullable().optional(),
      expiration_reason: z.string().max(100).nullable().optional(),
      transaction_id: z.string().max(512).nullable().optional(),
      original_transaction_id: z.string().max(512).nullable().optional(),
      new_product_id: z.string().max(512).nullable().optional(),
    })
    .passthrough(),
});

const toIso = (value: number | null | undefined): string | undefined =>
  value === undefined || value === null ? undefined : new Date(value).toISOString();

export function parseRevenueCatPayload(
  rawBody: string,
  defaultEnvironment: 'SANDBOX' | 'PRODUCTION' = 'SANDBOX',
): RevenueCatEvent {
  if (Buffer.byteLength(rawBody, 'utf8') > PLATFORM_CONFIG.webhookMaxPayloadBytes) {
    throw new PayloadTooLargeError();
  }
  const parsedJson: unknown = JSON.parse(rawBody);
  const parsed = revenueCatEnvelopeSchema.parse(parsedJson);
  const event = parsed.event;
  const entitlementIds = [
    ...(event.entitlement_ids ?? []),
    ...(event.entitlement_id === undefined || event.entitlement_id === null
      ? []
      : [event.entitlement_id]),
  ].filter((value, index, all) => all.indexOf(value) === index);

  const metadata = {
    apiVersion: parsed.api_version,
    store: event.store ?? undefined,
    periodType: event.period_type ?? undefined,
    cancelReason: event.cancel_reason ?? undefined,
    expirationReason: event.expiration_reason ?? undefined,
    transactionId: event.transaction_id ?? undefined,
    originalTransactionId: event.original_transaction_id ?? undefined,
    newProductId: event.new_product_id ?? undefined,
  };

  return {
    id: event.id,
    type: event.type,
    appUserId: event.app_user_id ?? undefined,
    originalAppUserId: event.original_app_user_id ?? undefined,
    aliases: event.aliases ?? [],
    transferredFrom: event.transferred_from ?? [],
    transferredTo: event.transferred_to ?? [],
    productId: event.product_id ?? undefined,
    entitlementIds,
    eventAt: new Date(event.event_timestamp_ms).toISOString(),
    purchasedAt: toIso(event.purchased_at_ms),
    expiresAt: toIso(event.expiration_at_ms),
    gracePeriodExpiresAt: toIso(event.grace_period_expiration_at_ms),
    environment: event.environment ?? defaultEnvironment,
    autoRenew: event.auto_renew_status ?? undefined,
    payloadHash: sha256(rawBody),
    rawMetadata: JSON.stringify(metadata),
  };
}

export class PayloadTooLargeError extends Error {
  public constructor() {
    super('Payload exceeds maximum size');
    this.name = 'PayloadTooLargeError';
  }
}

export const recordSnoozeArgumentsSchema = z.object({
  alarmId: z.string().min(1).max(200),
  alarmOccurrenceId: z.string().min(1).max(200),
  snoozeEventId: z.string().uuid(),
  occurredAt: z.iso.datetime({ offset: true }),
  legacyPurchaseReference: z.string().min(1).max(512).optional(),
  clientAppVersion: z.string().min(1).max(100).optional(),
});

export const linkRevenueCatArgumentsSchema = z.object({
  revenueCatAppUserId: z.string().min(1).max(512),
  originalAnonymousAppUserId: z.string().min(1).max(512).optional(),
  timezone: z.string().min(1).max(100),
});

export const listTransactionsArgumentsSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .nullish()
    .transform((value) => value ?? undefined),
  nextToken: z
    .string()
    .max(4096)
    .nullish()
    .transform((value) => value ?? undefined),
});
