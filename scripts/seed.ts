import { DynamoPlatformRepository } from '../amplify/shared/dynamo-repository.js';
import { processRevenueCatEvent, recordSnooze, runSettlement } from '../amplify/shared/domain.js';
import { sha256 } from '../amplify/shared/security.js';
import type { RevenueCatEvent } from '../amplify/shared/types.js';
import {
  loadPlatformOutputs,
  monthCutoff,
  parseOptions,
  requestedEnvironment,
  stringOption,
} from './shared.js';

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const environment = requestedEnvironment(options);
  if (environment !== 'SANDBOX') {
    throw new Error('Production seeding is disabled by design; use a sandbox environment');
  }
  const userId = stringOption(options, 'user-id');
  if (userId === undefined) {
    throw new Error(
      'Create a Cognito sandbox user first, then pass its sub with --user-id <cognito-sub>',
    );
  }
  const revenueCatAppUserId =
    stringOption(options, 'revenuecat-user-id') ?? `seed-revenuecat-${userId}`;
  const originalAnonymousAppUserId =
    stringOption(options, 'anonymous-user-id') ?? `seed-anonymous-${userId}`;
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const month = `${start.getUTCFullYear()}-${(start.getUTCMonth() + 1)
    .toString()
    .padStart(2, '0')}`;
  const nowIso = now.toISOString();
  const { tables } = await loadPlatformOutputs();
  const repository = new DynamoPlatformRepository(tables, 'SANDBOX');

  await repository.linkRevenueCatCustomer({
    userId,
    revenueCatAppUserId,
    originalAnonymousAppUserId,
    timezone: stringOption(options, 'timezone') ?? 'Europe/Zurich',
    creatorCode: undefined,
    now: nowIso,
  });

  const event: RevenueCatEvent = {
    id: `seed-initial:${userId}:${start.toISOString()}`,
    type: 'INITIAL_PURCHASE',
    appUserId: revenueCatAppUserId,
    originalAppUserId: originalAnonymousAppUserId,
    aliases: [originalAnonymousAppUserId],
    transferredFrom: [],
    transferredTo: [],
    productId: 'snoozefine_plus_monthly',
    entitlementIds: ['snoozefine_plus'],
    eventAt: nowIso,
    purchasedAt: start.toISOString(),
    expiresAt: end.toISOString(),
    gracePeriodExpiresAt: undefined,
    environment: 'SANDBOX',
    autoRenew: true,
    payloadHash: sha256(`seed:${userId}:${start.toISOString()}`),
    rawMetadata: JSON.stringify({ seed: true }),
  };
  await processRevenueCatEvent(repository, event, nowIso);
  for (const index of [1, 2]) {
    await recordSnooze(
      repository,
      {
        userId,
        alarmId: 'seed-alarm',
        alarmOccurrenceId: `seed-occurrence-${index}`,
        snoozeEventId: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
        occurredAt: nowIso,
        clientAppVersion: 'seed-script',
      },
      nowIso,
    );
  }
  const settlementResult = await runSettlement(
    repository,
    month,
    'SANDBOX',
    monthCutoff(month),
    nowIso,
  );
  console.log(
    JSON.stringify(
      {
        userId,
        revenueCatAppUserId,
        environment: 'SANDBOX',
        allocatedPoints: 2_000,
        snoozeDeductions: 2,
        officialBalance: 1_950,
        settlement: settlementResult,
        warning: 'DEVELOPMENT SEED — TEST MODE — NO DONATION HAS BEEN PAID',
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Seed failed');
  process.exitCode = 1;
});
