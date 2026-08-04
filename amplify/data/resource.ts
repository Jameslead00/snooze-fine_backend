import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { accountApiFunction } from '../functions/account-api/resource.js';
import { habitApiFunction } from '../functions/habit-api/resource.js';
import { linkRevenueCatCustomerFunction } from '../functions/link-revenuecat-customer/resource.js';
import { monthlySettlementFunction } from '../functions/monthly-settlement/resource.js';
import { recordSnoozeFunction } from '../functions/record-snooze/resource.js';
import { requestAccountDeletionFunction } from '../functions/request-account-deletion/resource.js';

const schema = a.schema({
  UserProfile: a
    .model({
      userId: a.id().required(),
      email: a.email(),
      displayName: a.string(),
      creatorCode: a.string(),
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
      transactionType: a.enum([
        'MONTHLY_ALLOCATION',
        'SNOOZE_DEDUCTION',
        'HABIT_DEDUCTION',
        'ADMIN_ADJUSTMENT',
      ]),
      reasonCode: a.string().required(),
      source: a.enum(['REVENUECAT_WEBHOOK', 'IOS_APP', 'ACCOUNTABILITY_ENGINE', 'ADMIN']),
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

  // The earned-points ledger is the App Store-safe successor to the legacy
  // subscription allocation and deduction records above. It has no monetary
  // fields and only records positive, idempotent qualification events.
  DisciPointAccount: a
    .model({
      id: a.id().required(),
      userId: a.id().required(),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      userEnvironment: a.string().required(),
      currentPoints: a.integer().required(),
      lifetimeEarned: a.integer().required(),
      version: a.integer().required(),
      createdAt: a.datetime().required(),
      updatedAt: a.datetime().required(),
    })
    .secondaryIndexes((index) => [
      index('userEnvironment').sortKeys(['updatedAt']).name('byUserEnvironmentAndUpdatedAt'),
    ])
    .authorization((allow) => [allow.group('ADMINS').to(['read'])]),

  DisciPointEarnEvent: a
    .model({
      id: a.id().required(),
      userId: a.id().required(),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      userEnvironment: a.string().required(),
      qualification: a.enum(['WAKE_COMPLETION', 'HABIT_COMPLETION']),
      sourceEventId: a.string().required(),
      pointsEarned: a.integer().required(),
      pointsAfter: a.integer().required(),
      createdAt: a.datetime().required(),
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

  SyncedAlarm: a
    .model({
      id: a.id().required(),
      userId: a.id().required(),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      userEnvironment: a.string().required(),
      hour: a.integer().required(),
      minute: a.integer().required(),
      repeatWeekdays: a.integer().array().required(),
      snoozeDurationMinutes: a.integer().required(),
      label: a.string().required(),
      isEnabled: a.boolean().required(),
      timezone: a.string().required(),
      version: a.integer().required(),
      createdAt: a.datetime().required(),
      updatedAt: a.datetime().required(),
    })
    .secondaryIndexes((index) => [
      index('userEnvironment').sortKeys(['updatedAt']).name('byUserEnvironmentAndUpdatedAt'),
    ])
    .authorization((allow) => [allow.group('ADMINS').to(['read'])]),

  WakeCompletion: a
    .model({
      id: a.id().required(),
      userId: a.id().required(),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      userEnvironment: a.string().required(),
      alarmId: a.string().required(),
      alarmOccurrenceId: a.string().required(),
      scheduledAt: a.datetime().required(),
      completedAt: a.datetime().required(),
      snoozeCount: a.integer().required(),
      createdAt: a.datetime().required(),
    })
    .secondaryIndexes((index) => [
      index('userEnvironment').sortKeys(['completedAt']).name('byUserEnvironmentAndCompletedAt'),
    ])
    .authorization((allow) => [allow.group('ADMINS').to(['read'])]),

  EngagementEvent: a
    .model({
      id: a.id().required(),
      userId: a.id().required(),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      userEnvironment: a.string().required(),
      sessionId: a.id().required(),
      name: a.enum([
        'SESSION_STARTED',
        'SUBSCRIPTION_GATE_VIEWED',
        'TODAY_VIEWED',
        'HABITS_VIEWED',
        'COMMUNITY_VIEWED',
        'ACCOUNT_VIEWED',
      ]),
      occurredAt: a.datetime().required(),
      receivedAt: a.datetime().required(),
      appVersion: a.string(),
      platform: a.enum(['IOS']),
    })
    .secondaryIndexes((index) => [
      index('userEnvironment').sortKeys(['receivedAt']).name('byUserEnvironmentAndReceivedAt'),
    ])
    .authorization((allow) => [allow.group('ADMINS').to(['read'])]),

  HabitDefinition: a
    .model({
      id: a.id().required(),
      userId: a.id().required(),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      userEnvironment: a.string().required(),
      environmentState: a.string().required(),
      // CUSTOM remains readable for legacy records, but all new fixed habits
      // use their own explicit enum value, including BED.
      kind: a.enum(['WATER', 'READING', 'MEDITATION', 'BED', 'CUSTOM']),
      title: a.string().required(),
      targetValue: a.integer().required(),
      // Optional for backwards compatibility with habits created before
      // per-habit progress steps were introduced.
      stepValue: a.integer(),
      unit: a.enum(['MILLILITRES', 'MINUTES', 'COUNT', 'CHECKMARK']),
      weekdays: a.integer().array().required(),
      deadlineMinutes: a.integer().required(),
      timezone: a.string().required(),
      penaltyPoints: a.integer().required(),
      startDate: a.date().required(),
      activeState: a.enum(['ACTIVE', 'ARCHIVED']),
      version: a.integer().required(),
      createdAt: a.datetime().required(),
      updatedAt: a.datetime().required(),
    })
    .secondaryIndexes((index) => [
      index('userEnvironment').sortKeys(['updatedAt']).name('byUserEnvironmentAndUpdatedAt'),
      index('environmentState').sortKeys(['updatedAt']).name('byEnvironmentStateAndUpdatedAt'),
    ])
    .authorization((allow) => [allow.group('ADMINS').to(['read'])]),

  HabitOccurrence: a
    .model({
      id: a.id().required(),
      userId: a.id().required(),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      userEnvironmentDate: a.string().required(),
      habitId: a.id().required(),
      localDate: a.date().required(),
      dueAt: a.datetime().required(),
      targetValue: a.integer().required(),
      unit: a.enum(['MILLILITRES', 'MINUTES', 'COUNT', 'CHECKMARK']),
      progressValue: a.integer().required(),
      status: a.enum(['PENDING', 'COMPLETED', 'MISSED', 'SKIPPED_INELIGIBLE']),
      completedAt: a.datetime(),
      missedAt: a.datetime(),
      ledgerTransactionId: a.string(),
      pointsDeducted: a.integer().required(),
      officialBalance: a.integer().required(),
      version: a.integer().required(),
      createdAt: a.datetime().required(),
      updatedAt: a.datetime().required(),
    })
    .secondaryIndexes((index) => [
      index('userEnvironmentDate').sortKeys(['habitId']).name('byUserEnvironmentDateAndHabitId'),
    ])
    .authorization((allow) => [allow.group('ADMINS').to(['read'])]),

  HabitProgressEvent: a
    .model({
      id: a.id().required(),
      userId: a.id().required(),
      habitId: a.id().required(),
      occurrenceId: a.id().required(),
      amount: a.integer().required(),
      occurredAt: a.datetime().required(),
      progressAfter: a.integer().required(),
      completed: a.boolean().required(),
      createdAt: a.datetime().required(),
    })
    .secondaryIndexes((index) => [
      index('userId').sortKeys(['createdAt']).name('byUserAndCreatedAt'),
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

  Charity: a
    .model({
      id: a.id().required(),
      name: a.string().required(),
      summary: a.string().required(),
      websiteUrl: a.url(),
      impactLabel: a.string(),
      active: a.boolean().required(),
      activeState: a.string().required(),
      sortOrder: a.integer().required(),
      updatedAt: a.datetime().required(),
    })
    .secondaryIndexes((index) => [
      index('activeState').sortKeys(['sortOrder']).name('byActiveStateAndSortOrder'),
    ])
    .authorization((allow) => [allow.group('ADMINS').to(['read'])]),

  CommunityBallot: a
    .model({
      id: a.id().required(),
      month: a.string().required(),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      environmentStatus: a.string().required(),
      status: a.enum(['OPEN', 'CLOSED']),
      opensAt: a.datetime().required(),
      closesAt: a.datetime().required(),
      charityIds: a.string().array().required(),
      tallies: a.json().required(),
      totalVotes: a.integer().required(),
      winnerCharityId: a.id(),
      donationRecordId: a.id(),
      companyContributionId: a.id(),
      totalAllocatedPoints: a.integer(),
      version: a.integer().required(),
      updatedAt: a.datetime().required(),
    })
    .secondaryIndexes((index) => [
      index('environmentStatus').sortKeys(['closesAt']).name('byEnvironmentStatusAndClosesAt'),
    ])
    .authorization((allow) => [allow.group('ADMINS').to(['read'])]),

  DailyCharityVote: a
    .model({
      id: a.id().required(),
      userId: a.id().required(),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      ballotId: a.id().required(),
      charityId: a.id().required(),
      localVoteDate: a.date().required(),
      timezone: a.string().required(),
      createdAt: a.datetime().required(),
    })
    .secondaryIndexes((index) => [
      index('ballotId').sortKeys(['createdAt']).name('byBallotAndCreatedAt'),
      index('userId').sortKeys(['createdAt']).name('byUserAndCreatedAt'),
    ])
    .authorization((allow) => [allow.group('ADMINS').to(['read'])]),

  CharityBallotAllocation: a
    .model({
      id: a.id().required(),
      userId: a.id().required(),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      userEnvironmentBallot: a.string().required(),
      ballotId: a.id().required(),
      charityId: a.id().required(),
      pointsAllocated: a.integer().required(),
      version: a.integer().required(),
      createdAt: a.datetime().required(),
      updatedAt: a.datetime().required(),
    })
    .secondaryIndexes((index) => [
      index('userEnvironmentBallot').sortKeys(['updatedAt']).name('byUserEnvironmentBallot'),
      index('ballotId').sortKeys(['updatedAt']).name('byBallotAndUpdatedAt'),
    ])
    .authorization((allow) => [allow.group('ADMINS').to(['read'])]),

  CompanyContribution: a
    .model({
      id: a.id().required(),
      ballotId: a.id().required(),
      month: a.string().required(),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      charityId: a.id().required(),
      commitmentType: a.enum(['FIXED', 'CAPPED']),
      currency: a.string().required(),
      maximumAmountMinor: a.integer().required(),
      approvedAmountMinor: a.integer(),
      paidAmountMinor: a.integer(),
      status: a.enum(['PLANNED', 'APPROVED', 'PAID', 'EVIDENCED', 'VOID']),
      paidAt: a.datetime(),
      evidenceUrl: a.url(),
      ownerNote: a.string(),
      updatedAt: a.datetime().required(),
    })
    .secondaryIndexes((index) => [
      index('environment').sortKeys(['month']).name('byEnvironmentAndMonth'),
    ])
    .authorization((allow) => [allow.group('ADMINS').to(['read'])]),

  DonationRecord: a
    .model({
      id: a.id().required(),
      month: a.string().required(),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      charityId: a.id().required(),
      status: a.enum(['EXPECTED', 'APPROVED', 'PAID', 'EVIDENCED', 'VOID']),
      expectedDonationMicroUsd: a.string().required(),
      approvedDonationMicroUsd: a.string(),
      paidDonationMicroUsd: a.string(),
      paidAt: a.datetime(),
      evidenceUrl: a.url(),
      ownerNote: a.string(),
      updatedAt: a.datetime().required(),
    })
    .secondaryIndexes((index) => [
      index('environment').sortKeys(['month']).name('byEnvironmentAndMonth'),
    ])
    .authorization((allow) => [allow.group('ADMINS').to(['read'])]),

  AccountDeletionRequest: a
    .model({
      id: a.id().required(),
      userId: a.id().required(),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      status: a.enum(['REQUESTED', 'PROCESSING', 'COMPLETED', 'FAILED']),
      requestedAt: a.datetime().required(),
      completedAt: a.datetime(),
      ownerNote: a.string(),
      updatedAt: a.datetime().required(),
    })
    .secondaryIndexes((index) => [
      index('status').sortKeys(['requestedAt']).name('byStatusAndRequestedAt'),
    ])
    .authorization((allow) => [allow.group('ADMINS').to(['read', 'update'])]),

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
    snoozeCount: a.integer().required(),
    serverTimestamp: a.datetime().required(),
  }),
  PointAccountResult: a.customType({
    isEligible: a.boolean().required(),
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
  EarnedPointAccountResult: a.customType({
    isEligible: a.boolean().required(),
    earnedPointsTotal: a.integer().required(),
    activeBallotId: a.id(),
    activeBallotEarnedPoints: a.integer().required(),
    activeBallotAllocatedVotes: a.integer().required(),
    subscriptionStatus: a.string().required(),
    serverTimestamp: a.datetime().required(),
  }),
  PointAwardResult: a.customType({
    id: a.id().required(),
    achievementType: a.string().required(),
    pointsAwarded: a.integer().required(),
    reasonCode: a.string().required(),
    source: a.string().required(),
    sourceEventId: a.string().required(),
    relatedEventId: a.string(),
    earnedPointsTotalAfter: a.integer().required(),
    ballotId: a.id(),
    createdAt: a.datetime().required(),
  }),
  PointAwardPage: a.customType({
    items: a.ref('PointAwardResult').array().required(),
    nextToken: a.string(),
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
  SaveHabitInput: a.customType({
    habitId: a.id().required(),
    kind: a.enum(['WATER', 'READING', 'MEDITATION', 'BED']),
    title: a.string().required(),
    targetValue: a.integer().required(),
    stepValue: a.integer(),
    unit: a.enum(['MILLILITRES', 'MINUTES', 'COUNT', 'CHECKMARK']),
    weekdays: a.integer().array().required(),
    deadlineMinutes: a.integer().required(),
    timezone: a.string().required(),
  }),
  HabitResult: a.customType({
    id: a.id().required(),
    kind: a.string().required(),
    title: a.string().required(),
    targetValue: a.integer().required(),
    stepValue: a.integer().required(),
    unit: a.string().required(),
    weekdays: a.integer().array().required(),
    deadlineMinutes: a.integer().required(),
    timezone: a.string().required(),
    penaltyPoints: a.integer().required(),
    activeState: a.string().required(),
    scheduledToday: a.boolean().required(),
    todayProgress: a.integer().required(),
    todayStatus: a.string().required(),
    todayDueAt: a.datetime(),
    createdAt: a.datetime().required(),
    updatedAt: a.datetime().required(),
  }),
  ArchiveHabitResult: a.customType({
    id: a.id().required(),
    archived: a.boolean().required(),
    serverTimestamp: a.datetime().required(),
  }),
  HabitProgressInput: a.customType({
    habitId: a.id().required(),
    progressEventId: a.id().required(),
    amount: a.integer().required(),
    occurredAt: a.datetime().required(),
  }),
  HabitProgressResult: a.customType({
    accepted: a.boolean().required(),
    duplicate: a.boolean().required(),
    completed: a.boolean().required(),
    localDate: a.date().required(),
    progressValue: a.integer().required(),
    targetValue: a.integer().required(),
    status: a.string().required(),
    officialBalance: a.integer().required(),
    pointsAwarded: a.integer().required(),
    earnedPointsTotal: a.integer().required(),
    serverTimestamp: a.datetime().required(),
  }),
  SaveSyncedAlarmInput: a.customType({
    alarmId: a.id().required(),
    expectedVersion: a.integer().required(),
    hour: a.integer().required(),
    minute: a.integer().required(),
    repeatWeekdays: a.integer().array().required(),
    snoozeDurationMinutes: a.integer().required(),
    label: a.string().required(),
    isEnabled: a.boolean().required(),
    timezone: a.string().required(),
  }),
  SyncedAlarmResult: a.customType({
    id: a.id().required(),
    hour: a.integer().required(),
    minute: a.integer().required(),
    repeatWeekdays: a.integer().array().required(),
    snoozeDurationMinutes: a.integer().required(),
    label: a.string().required(),
    isEnabled: a.boolean().required(),
    timezone: a.string().required(),
    version: a.integer().required(),
    createdAt: a.datetime().required(),
    updatedAt: a.datetime().required(),
  }),
  ArchiveSyncedAlarmResult: a.customType({
    id: a.id().required(),
    version: a.integer().required(),
    archived: a.boolean().required(),
    serverTimestamp: a.datetime().required(),
  }),
  RecordWakeCompletionInput: a.customType({
    wakeEventId: a.id().required(),
    alarmId: a.string().required(),
    alarmOccurrenceId: a.string().required(),
    scheduledAt: a.datetime().required(),
    completedAt: a.datetime().required(),
  }),
  RecordWakeCompletionResult: a.customType({
    accepted: a.boolean().required(),
    duplicate: a.boolean().required(),
    snoozeCount: a.integer().required(),
    pointsAwarded: a.integer().required(),
    earnedPointsTotal: a.integer().required(),
    serverTimestamp: a.datetime().required(),
  }),
  AccountabilityStatisticsResult: a.customType({
    weekSnoozes: a.integer().required(),
    weekWakeUps: a.integer().required(),
    weekNoSnoozeMornings: a.integer().required(),
    allTimeSnoozes: a.integer().required(),
    allTimeWakeUps: a.integer().required(),
    allTimeNoSnoozeMornings: a.integer().required(),
    earnedPointsTotal: a.integer().required(),
    activeBallotEarnedPoints: a.integer().required(),
    timezone: a.string().required(),
    serverTimestamp: a.datetime().required(),
  }),
  WeeklyRecapHabitResult: a.customType({
    kind: a.string().required(),
    title: a.string().required(),
    unit: a.string().required(),
    scheduledDays: a.integer().required(),
    completedDays: a.integer().required(),
    progressValue: a.integer().required(),
    targetValue: a.integer().required(),
    progressPercentage: a.float().required(),
  }),
  WeeklyProgressRecapResult: a.customType({
    period: a.string().required(),
    periodStart: a.date().required(),
    periodEnd: a.date().required(),
    includedDays: a.integer().required(),
    timezone: a.string().required(),
    habits: a.ref('WeeklyRecapHabitResult').array().required(),
    promisesScheduled: a.integer().required(),
    promisesKept: a.integer().required(),
    promisesPercentage: a.float().required(),
    wakeUps: a.integer().required(),
    noSnoozeMornings: a.integer().required(),
    serverTimestamp: a.datetime().required(),
  }),
  CommunityCharityResult: a.customType({
    id: a.id().required(),
    name: a.string().required(),
    summary: a.string().required(),
    websiteUrl: a.url(),
    impactLabel: a.string(),
    votes: a.integer().required(),
    votePercentage: a.float().required(),
    myAllocatedVotes: a.integer().required(),
  }),
  CommunityDashboardResult: a.customType({
    ballotId: a.id(),
    month: a.string(),
    status: a.string().required(),
    opensAt: a.datetime(),
    closesAt: a.datetime(),
    charities: a.ref('CommunityCharityResult').array().required(),
    totalVotes: a.integer().required(),
    myVoteCharityId: a.id(),
    canVoteToday: a.boolean().required(),
    earnedVotes: a.integer().required(),
    allocatedVotes: a.integer().required(),
    availableVotes: a.integer().required(),
    canAllocateVotes: a.boolean().required(),
    contributionStatus: a.string(),
    winnerCharityId: a.id(),
    donationStatus: a.string(),
    projectedDonationMicroUsd: a.string(),
    expectedDonationMicroUsd: a.string(),
    paidDonationMicroUsd: a.string(),
    evidenceUrl: a.url(),
    serverTimestamp: a.datetime().required(),
  }),
  CommunityVoteResult: a.customType({
    accepted: a.boolean().required(),
    duplicate: a.boolean().required(),
    ballotId: a.id().required(),
    charityId: a.id().required(),
    charityAllocatedVotes: a.integer().required(),
    allocatedVotes: a.integer().required(),
    availableVotes: a.integer().required(),
    totalVotes: a.integer().required(),
    serverTimestamp: a.datetime().required(),
  }),
  AllocateCharityVotesInput: a.customType({
    allocationEventId: a.id().required(),
    ballotId: a.id().required(),
    charityId: a.id().required(),
    allocatedVotes: a.integer().required(),
  }),
  AccountDeletionRequestResult: a.customType({
    accepted: a.boolean().required(),
    serverTimestamp: a.datetime().required(),
  }),
  RecordEngagementInput: a.customType({
    eventId: a.id().required(),
    sessionId: a.id().required(),
    name: a.enum([
      'SESSION_STARTED',
      'SUBSCRIPTION_GATE_VIEWED',
      'TODAY_VIEWED',
      'HABITS_VIEWED',
      'COMMUNITY_VIEWED',
      'ACCOUNT_VIEWED',
    ]),
    occurredAt: a.datetime().required(),
    appVersion: a.string(),
  }),
  RecordEngagementResult: a.customType({
    accepted: a.boolean().required(),
    duplicate: a.boolean().required(),
    serverTimestamp: a.datetime().required(),
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
      creatorCode: a.string(),
    })
    .returns(a.ref('LinkRevenueCatResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(linkRevenueCatCustomerFunction)),

  getMyPointAccount: a
    .query()
    .returns(a.ref('PointAccountResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  getMyEarnedPointAccount: a
    .query()
    .returns(a.ref('EarnedPointAccountResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  listMyPointTransactions: a
    .query()
    .arguments({ limit: a.integer(), nextToken: a.string() })
    .returns(a.ref('PointTransactionPage'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  listMyPointAwards: a
    .query()
    .arguments({ limit: a.integer(), nextToken: a.string() })
    .returns(a.ref('PointAwardPage'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  getMyHabits: a
    .query()
    .returns(a.ref('HabitResult').array())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(habitApiFunction)),

  saveMyHabit: a
    .mutation()
    .arguments({ input: a.ref('SaveHabitInput').required() })
    .returns(a.ref('HabitResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(habitApiFunction)),

  archiveMyHabit: a
    .mutation()
    .arguments({ habitId: a.id().required() })
    .returns(a.ref('ArchiveHabitResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(habitApiFunction)),

  reportHabitProgress: a
    .mutation()
    .arguments({ input: a.ref('HabitProgressInput').required() })
    .returns(a.ref('HabitProgressResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(habitApiFunction)),

  listMySyncedAlarms: a
    .query()
    .returns(a.ref('SyncedAlarmResult').array())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  saveMySyncedAlarm: a
    .mutation()
    .arguments({ input: a.ref('SaveSyncedAlarmInput').required() })
    .returns(a.ref('SyncedAlarmResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  archiveMySyncedAlarm: a
    .mutation()
    .arguments({ alarmId: a.id().required(), expectedVersion: a.integer().required() })
    .returns(a.ref('ArchiveSyncedAlarmResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  recordWakeCompletion: a
    .mutation()
    .arguments({ input: a.ref('RecordWakeCompletionInput').required() })
    .returns(a.ref('RecordWakeCompletionResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  getMyAccountabilityStatistics: a
    .query()
    .returns(a.ref('AccountabilityStatisticsResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  getMyWeeklyProgressRecap: a
    .query()
    .returns(a.ref('WeeklyProgressRecapResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  getCommunityDashboard: a
    .query()
    .returns(a.ref('CommunityDashboardResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  castMyDailyCharityVote: a
    .mutation()
    .arguments({ charityId: a.id().required() })
    .returns(a.ref('CommunityVoteResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  allocateMyCharityVotes: a
    .mutation()
    .arguments({ input: a.ref('AllocateCharityVotesInput').required() })
    .returns(a.ref('CommunityVoteResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  recordMyEngagement: a
    .mutation()
    .arguments({ input: a.ref('RecordEngagementInput').required() })
    .returns(a.ref('RecordEngagementResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  requestMyAccountDeletion: a
    .mutation()
    .arguments({ confirmation: a.string().required() })
    .returns(a.ref('AccountDeletionRequestResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(requestAccountDeletionFunction)),

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
