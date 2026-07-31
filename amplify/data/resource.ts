import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { accountApiFunction } from '../functions/account-api/resource.js';
import { linkRevenueCatCustomerFunction } from '../functions/link-revenuecat-customer/resource.js';
import { monthlySettlementFunction } from '../functions/monthly-settlement/resource.js';
import { recordSnoozeFunction } from '../functions/record-snooze/resource.js';

const schema = a.schema({
  UserProfile: a
    .model({
      userId: a.id().required(),
      email: a.email(),
      displayName: a.string(),
      timezone: a.string().required(),
    })
    .authorization((allow) => [
      allow.ownerDefinedIn('userId').identityClaim('sub').to(['read']),
      allow.group('ADMINS').to(['read']),
    ]),

  RevenueCatCustomerLink: a
    .model({
      id: a.id().required(),
      userId: a.id().required(),
      revenueCatAppUserId: a.string().required(),
      originalAnonymousAppUserId: a.string(),
    })
    .secondaryIndexes((index) => [index('userId').name('byCanonicalUser')])
    .authorization((allow) => [allow.group('ADMINS').to(['read'])]),

  RevenueCatWebhookEvent: a
    .model({
      id: a.id().required(),
      eventType: a.string().required(),
      userId: a.id(),
      appUserId: a.string(),
      originalAppUserId: a.string(),
      aliases: a.string().array(),
      transferredFrom: a.string().array(),
      transferredTo: a.string().array(),
      productId: a.string(),
      entitlementIds: a.string().array(),
      eventAt: a.datetime().required(),
      expirationAt: a.datetime(),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      status: a.enum(['PROCESSED', 'UNRESOLVED', 'IGNORED', 'FAILED']),
      processingError: a.string(),
      payloadHash: a.string().required(),
      rawMetadata: a.json(),
      receivedAt: a.datetime().required(),
      processedAt: a.datetime().required(),
    })
    .secondaryIndexes((index) => [
      index('status').sortKeys(['receivedAt']).name('byStatusAndReceivedAt'),
    ])
    .authorization((allow) => [allow.group('ADMINS').to(['read'])]),

  SubscriptionState: a
    .model({
      id: a.id().required(),
      userId: a.id().required(),
      revenueCatAppUserId: a.string().required(),
      entitlementId: a.string().required(),
      productId: a.string().required(),
      status: a.enum([
        'ACTIVE',
        'GRACE_PERIOD',
        'BILLING_ISSUE',
        'CANCELLED_PENDING_EXPIRY',
        'EXPIRED',
        'UNKNOWN',
      ]),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      originalPurchaseAt: a.datetime().required(),
      currentPeriodStart: a.datetime().required(),
      currentPeriodEnd: a.datetime().required(),
      autoRenew: a.boolean(),
      lastRevenueCatEventId: a.string().required(),
      stateEventAt: a.datetime().required(),
      statusEffectiveAt: a.datetime().required(),
    })
    .secondaryIndexes((index) => [
      index('userId').sortKeys(['environment']).name('byUserAndEnvironment'),
    ])
    .authorization((allow) => [allow.group('ADMINS').to(['read'])]),

  PointPeriod: a
    .model({
      id: a.id().required(),
      userId: a.id().required(),
      entitlementId: a.string().required(),
      productId: a.string().required(),
      periodStart: a.datetime().required(),
      periodEnd: a.datetime().required(),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      initialAllocation: a.integer().required(),
      currentRemaining: a.integer().required(),
      status: a.enum(['ACTIVE', 'EXPIRED']),
      allocationTransactionId: a.string().required(),
    })
    .secondaryIndexes((index) => [
      index('userId').sortKeys(['periodStart']).name('byUserAndPeriodStart'),
      index('environment').sortKeys(['periodEnd']).name('byEnvironmentAndPeriodEnd'),
    ])
    .authorization((allow) => [allow.group('ADMINS').to(['read'])]),

  PointAccount: a
    .model({
      id: a.id().required(),
      userId: a.id().required(),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      currentBalance: a.integer().required(),
      activePeriodId: a.id(),
      lifetimeAllocated: a.integer().required(),
      lifetimeDeducted: a.integer().required(),
      version: a.integer().required(),
    })
    .authorization((allow) => [allow.group('ADMINS').to(['read'])]),

  PointTransaction: a
    .model({
      id: a.id().required(),
      userId: a.id().required(),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      userEnvironment: a.string().required(),
      pointPeriodId: a.id().required(),
      amount: a.integer().required(),
      transactionType: a.enum(['MONTHLY_ALLOCATION', 'SNOOZE_DEDUCTION', 'ADMIN_ADJUSTMENT']),
      reasonCode: a.string().required(),
      source: a.enum(['REVENUECAT_WEBHOOK', 'IOS_APP', 'ADMIN']),
      idempotencyKey: a.string().required(),
      sourceEventId: a.string().required(),
      relatedEventId: a.string(),
      balanceAfter: a.integer().required(),
      createdAt: a.datetime().required(),
      metadataJson: a.json(),
    })
    .secondaryIndexes((index) => [
      index('userEnvironment').sortKeys(['createdAt']).name('byUserEnvironmentAndCreatedAt'),
    ])
    .authorization((allow) => [allow.group('ADMINS').to(['read'])]),

  SnoozeEvent: a
    .model({
      id: a.id().required(),
      userId: a.id().required(),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      alarmId: a.string().required(),
      alarmOccurrenceId: a.string().required(),
      occurredAt: a.datetime().required(),
      receivedAt: a.datetime().required(),
      status: a.enum(['ACCEPTED', 'REJECTED']),
      ledgerTransactionId: a.string(),
      pointsDeducted: a.integer().required(),
      officialBalance: a.integer().required(),
      clientAppVersion: a.string(),
      legacyPurchaseReference: a.string(),
    })
    .secondaryIndexes((index) => [
      index('userId').sortKeys(['receivedAt']).name('byUserAndReceivedAt'),
    ])
    .authorization((allow) => [allow.group('ADMINS').to(['read'])]),

  MonthlySettlement: a
    .model({
      id: a.id().required(),
      calendarMonth: a.string().required(),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      mode: a.enum(['TEST']),
      eligibleUserCount: a.integer().required(),
      totalAllocatedPoints: a.integer().required(),
      totalDeductedPoints: a.integer().required(),
      totalRemainingPoints: a.integer().required(),
      donationRateMicroUsdPerPoint: a.integer().required(),
      expectedDonationMicroUsd: a.string().required(),
      expectedDonationDisplay: a.string().required(),
      calculationVersion: a.string().required(),
      cutoffAt: a.datetime().required(),
      status: a.enum(['CALCULATING', 'CALCULATED', 'FAILED', 'VOID']),
      completedAt: a.datetime(),
      errorSummary: a.string(),
      calculationMetadata: a.json(),
    })
    .secondaryIndexes((index) => [
      index('environment').sortKeys(['calendarMonth']).name('byEnvironmentAndMonth'),
    ])
    .authorization((allow) => [allow.group('ADMINS').to(['read'])]),

  RecordSnoozeInput: a.customType({
    alarmId: a.string().required(),
    alarmOccurrenceId: a.string().required(),
    snoozeEventId: a.id().required(),
    occurredAt: a.datetime().required(),
    legacyPurchaseReference: a.string(),
    clientAppVersion: a.string(),
  }),
  RecordSnoozeResult: a.customType({
    accepted: a.boolean().required(),
    duplicate: a.boolean().required(),
    pointsDeducted: a.integer().required(),
    officialBalance: a.integer().required(),
    activePointPeriodId: a.id().required(),
    serverTimestamp: a.datetime().required(),
  }),
  PointAccountResult: a.customType({
    officialBalance: a.integer().required(),
    activePointPeriodId: a.id(),
    initialAllocation: a.integer().required(),
    pointsDeducted: a.integer().required(),
    periodStart: a.datetime(),
    periodEnd: a.datetime(),
    subscriptionStatus: a.string().required(),
    donationMicroUsd: a.string().required(),
    serverTimestamp: a.datetime().required(),
  }),
  PointTransactionResult: a.customType({
    id: a.id().required(),
    pointPeriodId: a.id().required(),
    amount: a.integer().required(),
    transactionType: a.string().required(),
    reasonCode: a.string().required(),
    source: a.string().required(),
    sourceEventId: a.string().required(),
    relatedEventId: a.string(),
    balanceAfter: a.integer().required(),
    createdAt: a.datetime().required(),
  }),
  PointTransactionPage: a.customType({
    items: a.ref('PointTransactionResult').array().required(),
    nextToken: a.string(),
  }),
  LinkRevenueCatResult: a.customType({
    linked: a.boolean().required(),
    duplicate: a.boolean().required(),
  }),
  SettlementResult: a.customType({
    duplicate: a.boolean().required(),
    eligibleUserCount: a.integer().required(),
    totalRemainingPoints: a.integer().required(),
    expectedDonationMicroUsd: a.string().required(),
    warning: a.string().required(),
  }),

  recordSnooze: a
    .mutation()
    .arguments({ input: a.ref('RecordSnoozeInput').required() })
    .returns(a.ref('RecordSnoozeResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(recordSnoozeFunction)),

  linkRevenueCatCustomer: a
    .mutation()
    .arguments({
      revenueCatAppUserId: a.string().required(),
      originalAnonymousAppUserId: a.string(),
      timezone: a.string().required(),
    })
    .returns(a.ref('LinkRevenueCatResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(linkRevenueCatCustomerFunction)),

  getMyPointAccount: a
    .query()
    .returns(a.ref('PointAccountResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  listMyPointTransactions: a
    .query()
    .arguments({ limit: a.integer(), nextToken: a.string() })
    .returns(a.ref('PointTransactionPage'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  rerunMonthlySettlement: a
    .mutation()
    .arguments({
      month: a.string().required(),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      cutoff: a.datetime().required(),
    })
    .returns(a.ref('SettlementResult'))
    .authorization((allow) => [allow.group('ADMINS')])
    .handler(a.handler.function(monthlySettlementFunction)),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
  },
});
