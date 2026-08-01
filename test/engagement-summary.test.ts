import { describe, expect, it } from 'vitest';
import { summarizeEngagement } from '../scripts/engagement-summary.js';

describe('engagement admin summary', () => {
  it('returns aggregate retention counts without exposing user identifiers', () => {
    const summary = summarizeEngagement(
      [
        {
          userId: 'user-1',
          environment: 'SANDBOX',
          sessionId: 'session-1',
          name: 'SESSION_STARTED',
          receivedAt: '2026-07-30T08:00:00.000Z',
        },
        {
          userId: 'user-1',
          environment: 'SANDBOX',
          sessionId: 'session-1',
          name: 'TODAY_VIEWED',
          receivedAt: '2026-07-30T08:00:01.000Z',
        },
        {
          userId: 'user-2',
          environment: 'SANDBOX',
          sessionId: 'session-2',
          name: 'TODAY_VIEWED',
          receivedAt: '2026-07-31T08:00:00.000Z',
        },
        {
          userId: 'production-user',
          environment: 'PRODUCTION',
          sessionId: 'production-session',
          name: 'TODAY_VIEWED',
          receivedAt: '2026-07-31T08:00:00.000Z',
        },
      ],
      'SANDBOX',
      '2026-07-29T00:00:00.000Z',
    );

    expect(summary).toMatchObject({
      totalEvents: 3,
      uniqueAuthenticatedUsers: 2,
      uniqueSessions: 2,
      uniqueUsersByEvent: { SESSION_STARTED: 1, TODAY_VIEWED: 2 },
      dailyActiveUsersUtc: { '2026-07-30': 1, '2026-07-31': 1 },
    });
    expect(JSON.stringify(summary)).not.toContain('user-1');
  });
});
