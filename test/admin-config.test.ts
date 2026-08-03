import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPlatformOutputs } from '../scripts/shared.js';

const originalOutputsPath = process.env.AMPLIFY_OUTPUTS_PATH;
const originalTablesPath = process.env.SNOOZEFINE_ADMIN_TABLES_PATH;
const originalTablesJson = process.env.SNOOZEFINE_ADMIN_TABLES_JSON;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (originalOutputsPath === undefined) delete process.env.AMPLIFY_OUTPUTS_PATH;
  else process.env.AMPLIFY_OUTPUTS_PATH = originalOutputsPath;
  if (originalTablesPath === undefined) delete process.env.SNOOZEFINE_ADMIN_TABLES_PATH;
  else process.env.SNOOZEFINE_ADMIN_TABLES_PATH = originalTablesPath;
  if (originalTablesJson === undefined) delete process.env.SNOOZEFINE_ADMIN_TABLES_JSON;
  else process.env.SNOOZEFINE_ADMIN_TABLES_JSON = originalTablesJson;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function publicOutputsPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'snoozefine-admin-config-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'amplify_outputs.json');
  await writeFile(
    path,
    JSON.stringify({
      custom: {
        snoozefine: {
          revenuecat_webhook_url: 'https://example.execute-api.test/webhooks/revenuecat',
          environment: 'SANDBOX',
          settlement_mode: 'TEST',
        },
      },
    }),
  );
  return path;
}

const tableMapping = {
  USER_PROFILE_TABLE_NAME: 'profiles',
  CUSTOMER_LINK_TABLE_NAME: 'customer-links',
  WEBHOOK_TABLE_NAME: 'webhooks',
  SUBSCRIPTION_TABLE_NAME: 'subscriptions',
  POINT_PERIOD_TABLE_NAME: 'periods',
  POINT_ACCOUNT_TABLE_NAME: 'accounts',
  POINT_TRANSACTION_TABLE_NAME: 'transactions',
  SNOOZE_EVENT_TABLE_NAME: 'snoozes',
  MONTHLY_SETTLEMENT_TABLE_NAME: 'settlements',
  ENGAGEMENT_EVENT_TABLE_NAME: 'engagement-events',
};

describe('backend-only admin configuration', () => {
  it('loads tables separately from public Amplify outputs', async () => {
    process.env.AMPLIFY_OUTPUTS_PATH = await publicOutputsPath();
    delete process.env.SNOOZEFINE_ADMIN_TABLES_PATH;
    process.env.SNOOZEFINE_ADMIN_TABLES_JSON = JSON.stringify(tableMapping);

    const loaded = await loadPlatformOutputs();

    expect(loaded.tables.account).toBe('accounts');
    expect(loaded.webhookUrl).toContain('/webhooks/revenuecat');
  });

  it('fails clearly instead of requiring table names in the iOS outputs file', async () => {
    process.env.AMPLIFY_OUTPUTS_PATH = await publicOutputsPath();
    delete process.env.SNOOZEFINE_ADMIN_TABLES_PATH;
    delete process.env.SNOOZEFINE_ADMIN_TABLES_JSON;

    await expect(loadPlatformOutputs()).rejects.toThrow('Admin table mapping is not configured');
  });
});
