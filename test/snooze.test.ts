import { describe, expect, it } from 'vitest';
import { processRevenueCatEvent, recordSnooze } from '../amplify/shared/domain.js';
import type { DomainError } from '../amplify/shared/domain.js';
import type { SnoozeCommand } from '../amplify/shared/types.js';
import { revenueCatEvent } from './fixtures.js';
import { InMemoryRepository } from './support/in-memory-repository.js';

const now = '2026-07-02T12:00:00.000Z';
const command: SnoozeCommand = {
  userId: 'cognito-1',
  alarmId: 'alarm-1',
  alarmOccurrenceId: 'alarm-1:2026-07-02T11:59:00Z',
  snoozeEventId: '9a3055de-6964-48a8-879c-4f4bbdf8d0bd',
  occurredAt: '2026-07-02T11:59:00.000Z',
};

async function eligibleRepository(): Promise<InMemoryRepository> {
  const repository = new InMemoryRepository();
  repository.link('cognito-1', 'user-1');
  await processRevenueCatEvent(repository, revenueCatEvent(), '2026-07-01T00:00:02.000Z');
  return repository;
}

describe('record snooze', () => {
  it('deducts exactly 25 points once', async () => {
    const repository = await eligibleRepository();

    const result = await recordSnooze(repository, command, now);

    expect(result.pointsDeducted).toBe(25);
    expect(result.officialBalance).toBe(1_975);
  });

  it('returns the original result for a duplicate without a second deduction', async () => {
    const repository = await eligibleRepository();
    await recordSnooze(repository, command, now);

    const duplicate = await recordSnooze(repository, command, '2026-07-02T12:01:00.000Z');

    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.officialBalance).toBe(1_975);
    expect(repository.accounts.get('cognito-1')?.currentBalance).toBe(1_975);
  });

  it('deducts only the remaining balance and never goes below zero', async () => {
    const repository = await eligibleRepository();
    const account = repository.accounts.get('cognito-1');
    if (account === undefined) throw new Error('fixture account missing');
    repository.accounts.set('cognito-1', { ...account, currentBalance: 10 });
    const period = repository.periods.get(account.activePeriodId ?? '');
    if (period === undefined) throw new Error('fixture period missing');
    repository.periods.set(period.id, { ...period, currentRemaining: 10 });

    const result = await recordSnooze(repository, command, now);

    expect(result.pointsDeducted).toBe(10);
    expect(result.officialBalance).toBe(0);
  });

  it('cannot use one authenticated identity to affect another user', async () => {
    const repository = await eligibleRepository();

    await expect(
      recordSnooze(repository, { ...command, userId: 'cognito-2' }, now),
    ).rejects.toMatchObject({ code: 'INELIGIBLE_SUBSCRIPTION' } satisfies Partial<DomainError>);
    expect(repository.accounts.get('cognito-1')?.currentBalance).toBe(2_000);
  });

  it('rejects future and stale event timestamps', async () => {
    const repository = await eligibleRepository();

    await expect(
      recordSnooze(repository, { ...command, occurredAt: '2026-07-03T00:00:00.000Z' }, now),
    ).rejects.toMatchObject({ code: 'FUTURE_EVENT' } satisfies Partial<DomainError>);
    await expect(
      recordSnooze(repository, { ...command, occurredAt: '2026-06-01T00:00:00.000Z' }, now),
    ).rejects.toMatchObject({ code: 'STALE_EVENT' } satisfies Partial<DomainError>);
  });

  it('rejects a stale or expired point period even when the subscription remains active', async () => {
    const repository = await eligibleRepository();
    const account = repository.accounts.get('cognito-1');
    if (account?.activePeriodId === undefined) throw new Error('fixture account missing');
    const period = repository.periods.get(account.activePeriodId);
    if (period === undefined) throw new Error('fixture period missing');
    repository.periods.set(period.id, {
      ...period,
      status: 'EXPIRED',
    });

    await expect(recordSnooze(repository, command, now)).rejects.toMatchObject({
      code: 'NO_ACTIVE_POINT_PERIOD',
    } satisfies Partial<DomainError>);
  });
});
