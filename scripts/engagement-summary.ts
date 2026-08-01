import type { RevenueCatEnvironment } from '../amplify/shared/config.js';

export interface EngagementSummary {
  environment: RevenueCatEnvironment;
  since: string;
  totalEvents: number;
  uniqueAuthenticatedUsers: number;
  uniqueSessions: number;
  uniqueUsersByEvent: Record<string, number>;
  dailyActiveUsersUtc: Record<string, number>;
}

export function summarizeEngagement(
  items: Record<string, unknown>[],
  environment: RevenueCatEnvironment,
  since: string,
): EngagementSummary {
  const filtered = items.filter(
    (item) =>
      item.environment === environment &&
      typeof item.receivedAt === 'string' &&
      item.receivedAt >= since &&
      typeof item.userId === 'string' &&
      typeof item.sessionId === 'string' &&
      typeof item.name === 'string',
  );
  const users = new Set<string>();
  const sessions = new Set<string>();
  const eventUsers = new Map<string, Set<string>>();
  const dailyUsers = new Map<string, Set<string>>();
  for (const item of filtered) {
    const userId = String(item.userId);
    const sessionId = String(item.sessionId);
    const name = String(item.name);
    const date = String(item.receivedAt).slice(0, 10);
    users.add(userId);
    sessions.add(sessionId);
    const usersForEvent = eventUsers.get(name) ?? new Set<string>();
    usersForEvent.add(userId);
    eventUsers.set(name, usersForEvent);
    const usersForDate = dailyUsers.get(date) ?? new Set<string>();
    usersForDate.add(userId);
    dailyUsers.set(date, usersForDate);
  }
  return {
    environment,
    since,
    totalEvents: filtered.length,
    uniqueAuthenticatedUsers: users.size,
    uniqueSessions: sessions.size,
    uniqueUsersByEvent: Object.fromEntries(
      [...eventUsers.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, values]) => [name, values.size]),
    ),
    dailyActiveUsersUtc: Object.fromEntries(
      [...dailyUsers.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, values]) => [date, values.size]),
    ),
  };
}
