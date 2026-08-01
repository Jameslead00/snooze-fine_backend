import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { PlatformTableNames } from '../amplify/shared/dynamo-repository.js';

export interface AdminTableNames extends PlatformTableNames {
  engagement: string;
}

const outputsSchema = z.object({
  custom: z.object({
    snoozefine: z.object({
      revenuecat_webhook_url: z.string().url(),
      environment: z.enum(['SANDBOX', 'PRODUCTION']),
      settlement_mode: z.literal('TEST'),
      admin_tables: z.record(z.string(), z.string()).optional(),
    }),
  }),
});

const adminTablesSchema = z.record(z.string(), z.string().min(1));

export interface CliOptions {
  [key: string]: string | boolean;
}

export function parseOptions(values: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (token === undefined || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const following = values[index + 1];
    if (following === undefined || following.startsWith('--')) options[key] = true;
    else {
      options[key] = following;
      index += 1;
    }
  }
  return options;
}

export function stringOption(
  options: CliOptions,
  name: string,
  fallback?: string,
): string | undefined {
  const value = options[name];
  return typeof value === 'string' ? value : fallback;
}

export async function loadPlatformOutputs(): Promise<{
  tables: AdminTableNames;
  webhookUrl: string;
}> {
  const path = resolve(process.env.AMPLIFY_OUTPUTS_PATH ?? './amplify_outputs.json');
  const parsed = outputsSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
  const embeddedTables = parsed.custom.snoozefine.admin_tables;
  const tablesPath = process.env.SNOOZEFINE_ADMIN_TABLES_PATH;
  const tablesJson = process.env.SNOOZEFINE_ADMIN_TABLES_JSON;
  let table: Record<string, string> | undefined = embeddedTables;
  if (tablesPath !== undefined) {
    table = adminTablesSchema.parse(
      JSON.parse(await readFile(resolve(tablesPath), 'utf8')) as unknown,
    );
  } else if (tablesJson !== undefined) {
    table = adminTablesSchema.parse(JSON.parse(tablesJson) as unknown);
  }
  if (table === undefined) {
    throw new Error(
      'Admin table mapping is not configured. Set SNOOZEFINE_ADMIN_TABLES_PATH to a backend-only JSON file; physical table names must not be added to the public amplify_outputs.json copied into iOS.',
    );
  }
  const required = (key: string): string => {
    const value = table[key];
    if (value === undefined) throw new Error(`Backend output is missing ${key}`);
    return value;
  };
  return {
    tables: {
      userProfile: required('USER_PROFILE_TABLE_NAME'),
      customerLink: required('CUSTOMER_LINK_TABLE_NAME'),
      webhook: required('WEBHOOK_TABLE_NAME'),
      subscription: required('SUBSCRIPTION_TABLE_NAME'),
      period: required('POINT_PERIOD_TABLE_NAME'),
      account: required('POINT_ACCOUNT_TABLE_NAME'),
      transaction: required('POINT_TRANSACTION_TABLE_NAME'),
      snooze: required('SNOOZE_EVENT_TABLE_NAME'),
      settlement: required('MONTHLY_SETTLEMENT_TABLE_NAME'),
      engagement: required('ENGAGEMENT_EVENT_TABLE_NAME'),
    },
    webhookUrl: parsed.custom.snoozefine.revenuecat_webhook_url,
  };
}

export function requestedEnvironment(options: CliOptions): 'SANDBOX' | 'PRODUCTION' {
  const value = stringOption(options, 'environment', 'SANDBOX');
  if (value !== 'SANDBOX' && value !== 'PRODUCTION') {
    throw new Error('--environment must be SANDBOX or PRODUCTION');
  }
  return value;
}

export function monthCutoff(month: string): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (match === null) throw new Error('--month must use YYYY-MM');
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  return new Date(Date.UTC(year, monthIndex + 1, 1) - 1).toISOString();
}
