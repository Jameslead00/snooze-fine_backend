import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { accountApiFunction } from '../functions/account-api/resource.js';
import { habitApiFunction } from '../functions/habit-api/resource.js';
import { linkRevenueCatCustomerFunction } from '../functions/link-revenuecat-customer/resource.js';
import { requestAccountDeletionFunction } from '../functions/request-account-deletion/resource.js';

const schema = a.schema({
  UserProfile: a
    .model({
      userId: a.id().required(),
      email: a.email(),
      displayName: a.string(),
      username: a.string(),
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

  // The earned-points ledger has no monetary fields and records only positive,
  // idempotent qualification events.
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
      kind: a.enum([
        'WATER',
        'READING',
        'MEDITATION',
        'BED',
        'STEPS',
        'CALORIES',
        'EXERCISE_MINUTES',
        'STAND_MINUTES',
        'SLEEP_MINUTES',
        'CUSTOM',
      ]),
      title: a.string().required(),
      targetValue: a.integer().required(),
      // Optional for backwards compatibility with habits created before
      // per-habit progress steps were introduced.
      stepValue: a.integer(),
      unit: a.enum(['MILLILITRES', 'MINUTES', 'COUNT', 'CHECKMARK', 'KILOCALORIES']),
      weekdays: a.integer().array().required(),
      deadlineMinutes: a.integer().required(),
      timezone: a.string().required(),
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
      unit: a.enum(['MILLILITRES', 'MINUTES', 'COUNT', 'CHECKMARK', 'KILOCALORIES']),
      progressValue: a.integer().required(),
      status: a.enum(['PENDING', 'COMPLETED', 'MISSED', 'SKIPPED_INELIGIBLE']),
      completedAt: a.datetime(),
      missedAt: a.datetime(),
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

  // A normalized username is atomically reserved by this id-keyed record.
  UsernameReservation: a
    .model({
      id: a.id().required(),
      userId: a.id().required(),
      createdAt: a.datetime().required(),
    })
    .authorization((allow) => [allow.group('ADMINS').to(['read'])]),

  FriendRequest: a
    .model({
      id: a.id().required(),
      requesterUserId: a.id().required(),
      recipientUserId: a.id().required(),
      requesterUsername: a.string().required(),
      requesterDisplayName: a.string().required(),
      recipientUsername: a.string().required(),
      recipientDisplayName: a.string().required(),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      requesterEnvironment: a.string().required(),
      recipientEnvironment: a.string().required(),
      status: a.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED']),
      acceptedAt: a.datetime(),
      createdAt: a.datetime().required(),
      updatedAt: a.datetime().required(),
    })
    .secondaryIndexes((index) => [
      index('requesterEnvironment')
        .sortKeys(['updatedAt'])
        .name('byRequesterEnvironmentAndUpdatedAt'),
      index('recipientEnvironment')
        .sortKeys(['updatedAt'])
        .name('byRecipientEnvironmentAndUpdatedAt'),
    ])
    .authorization((allow) => [allow.group('ADMINS').to(['read'])]),

  // Each accepted friendship is stored twice, once for each participant.
  FriendConnection: a
    .model({
      id: a.id().required(),
      userId: a.id().required(),
      friendUserId: a.id().required(),
      environment: a.enum(['SANDBOX', 'PRODUCTION']),
      userEnvironment: a.string().required(),
      createdAt: a.datetime().required(),
    })
    .secondaryIndexes((index) => [
      index('userEnvironment').sortKeys(['createdAt']).name('byUserEnvironmentAndCreatedAt'),
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

  EarnedPointAccountResult: a.customType({
    isEligible: a.boolean().required(),
    earnedPointsTotal: a.integer().required(),
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
    createdAt: a.datetime().required(),
  }),
  PointAwardPage: a.customType({
    items: a.ref('PointAwardResult').array().required(),
    nextToken: a.string(),
  }),
  LinkRevenueCatResult: a.customType({
    linked: a.boolean().required(),
    duplicate: a.boolean().required(),
  }),
  SaveHabitInput: a.customType({
    habitId: a.id().required(),
    kind: a.enum([
      'WATER',
      'READING',
      'MEDITATION',
      'BED',
      'STEPS',
      'CALORIES',
      'EXERCISE_MINUTES',
      'STAND_MINUTES',
      'SLEEP_MINUTES',
    ]),
    title: a.string().required(),
    targetValue: a.integer().required(),
    stepValue: a.integer(),
    unit: a.enum(['MILLILITRES', 'MINUTES', 'COUNT', 'CHECKMARK', 'KILOCALORIES']),
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
    activeState: a.string().required(),
    scheduledToday: a.boolean().required(),
    todayProgress: a.integer().required(),
    todayStatus: a.string().required(),
    todayDueAt: a.datetime(),
    // Informational only: a fixed, server-configured award for completing this
    // habit. It is never a balance, penalty, or monetary conversion.
    completionAwardPoints: a.integer().required(),
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
  SocialProfileResult: a.customType({
    usernameRequired: a.boolean().required(),
    username: a.string(),
    displayName: a.string().required(),
    serverTimestamp: a.datetime().required(),
  }),
  SetUsernameResult: a.customType({
    username: a.string().required(),
    duplicate: a.boolean().required(),
    serverTimestamp: a.datetime().required(),
  }),
  FriendRequestResult: a.customType({
    requestId: a.id().required(),
    status: a.string().required(),
    direction: a.string().required(),
    counterpartUsername: a.string().required(),
    counterpartDisplayName: a.string().required(),
    createdAt: a.datetime().required(),
    updatedAt: a.datetime().required(),
    serverTimestamp: a.datetime().required(),
  }),
  FriendRequestPage: a.customType({
    incoming: a.ref('FriendRequestResult').array().required(),
    outgoing: a.ref('FriendRequestResult').array().required(),
    serverTimestamp: a.datetime().required(),
  }),
  SendFriendRequestResult: a.customType({
    sent: a.boolean().required(),
    request: a.ref('FriendRequestResult'),
    duplicate: a.boolean().required(),
    serverTimestamp: a.datetime().required(),
  }),
  FriendResult: a.customType({
    friendId: a.id().required(),
    username: a.string().required(),
    displayName: a.string().required(),
    friendsSince: a.datetime().required(),
  }),
  FriendPage: a.customType({
    items: a.ref('FriendResult').array().required(),
  }),
  AcceptFriendRequestResult: a.customType({
    accepted: a.boolean().required(),
    duplicate: a.boolean().required(),
    friend: a.ref('FriendResult').required(),
    serverTimestamp: a.datetime().required(),
  }),
  RemoveFriendResult: a.customType({
    removed: a.boolean().required(),
    serverTimestamp: a.datetime().required(),
  }),
  FriendLeaderboardEntry: a.customType({
    friendId: a.id(),
    username: a.string().required(),
    displayName: a.string().required(),
    currentMonthPoints: a.integer().required(),
    rank: a.integer().required(),
    isCurrentUser: a.boolean().required(),
  }),
  FriendsLeaderboardResult: a.customType({
    period: a.string().required(),
    periodStart: a.datetime().required(),
    periodEnd: a.datetime().required(),
    entries: a.ref('FriendLeaderboardEntry').array().required(),
    serverTimestamp: a.datetime().required(),
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

  getMyEarnedPointAccount: a
    .query()
    .returns(a.ref('EarnedPointAccountResult'))
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

  setMyUsername: a
    .mutation()
    .arguments({ username: a.string().required() })
    .returns(a.ref('SetUsernameResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  getMySocialProfile: a
    .query()
    .returns(a.ref('SocialProfileResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  sendFriendRequest: a
    .mutation()
    .arguments({ username: a.string().required() })
    .returns(a.ref('SendFriendRequestResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  listMyFriendRequests: a
    .query()
    .returns(a.ref('FriendRequestPage'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  acceptFriendRequest: a
    .mutation()
    .arguments({ requestId: a.id().required() })
    .returns(a.ref('AcceptFriendRequestResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  declineFriendRequest: a
    .mutation()
    .arguments({ requestId: a.id().required() })
    .returns(a.ref('FriendRequestResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  cancelFriendRequest: a
    .mutation()
    .arguments({ requestId: a.id().required() })
    .returns(a.ref('FriendRequestResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  listMyFriends: a
    .query()
    .returns(a.ref('FriendPage'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  removeMyFriend: a
    .mutation()
    .arguments({ friendId: a.id().required() })
    .returns(a.ref('RemoveFriendResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(accountApiFunction)),

  getMyFriendsLeaderboard: a
    .query()
    .returns(a.ref('FriendsLeaderboardResult'))
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
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
  },
});
