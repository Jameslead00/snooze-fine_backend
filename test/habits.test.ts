import { describe, expect, it } from 'vitest';
import { DomainError } from '../amplify/shared/domain.js';
import {
  archiveHabit,
  dueLocalDates,
  habitDashboard,
  localDeadlineUtc,
  reportHabitProgress,
  saveHabit,
  settleHabit,
} from '../amplify/shared/habits.js';
import { InMemoryHabitRepository } from './support/in-memory-habit-repository.js';

const userId = '11111111-1111-4111-8111-111111111111';
const habitId = '22222222-2222-4222-8222-222222222222';
const now = '2026-07-31T12:00:00.000Z';

async function waterHabit(repository: InMemoryHabitRepository) {
  return saveHabit(
    repository,
    {
      userId,
      habitId,
      kind: 'WATER',
      title: 'Drink water',
      targetValue: 2_000,
      stepValue: 250,
      unit: 'MILLILITRES',
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      deadlineMinutes: 22 * 60,
      timezone: 'Europe/Zurich',
    },
    now,
  );
}

describe('Phase 2 habit accountability', () => {
  it('creates a habit without a penalty field', async () => {
    const repository = new InMemoryHabitRepository();
    const habit = await waterHabit(repository);
    expect(habit.startDate).toBe('2026-07-31');
  });

  it('isolates habits by Cognito user', async () => {
    const repository = new InMemoryHabitRepository();
    await waterHabit(repository);
    expect(await repository.listHabits('different-user')).toEqual([]);
    await expect(archiveHabit(repository, 'different-user', habitId, now)).rejects.toMatchObject({
      code: 'HABIT_NOT_FOUND',
    });
  });

  it('reuses a progress event without double counting', async () => {
    const repository = new InMemoryHabitRepository();
    await waterHabit(repository);
    const command = {
      userId,
      habitId,
      progressEventId: '33333333-3333-4333-8333-333333333333',
      amount: 500,
      occurredAt: '2026-07-31T12:30:00.000Z',
    };
    const first = await reportHabitProgress(repository, command, '2026-07-31T12:31:00.000Z');
    const retry = await reportHabitProgress(repository, command, '2026-07-31T12:32:00.000Z');
    expect(first.progressValue).toBe(500);
    expect(retry.progressValue).toBe(500);
    expect(retry.duplicate).toBe(true);
  });

  it('completes at the target and exposes today from server occurrences', async () => {
    const repository = new InMemoryHabitRepository();
    await waterHabit(repository);
    const result = await reportHabitProgress(
      repository,
      {
        userId,
        habitId,
        progressEventId: '44444444-4444-4444-8444-444444444444',
        amount: 2_500,
        occurredAt: '2026-07-31T13:00:00.000Z',
      },
      '2026-07-31T13:01:00.000Z',
    );
    expect(result.completed).toBe(true);
    expect(result.progressValue).toBe(2_000);
    const dashboard = await habitDashboard(repository, userId, '2026-07-31T13:02:00.000Z');
    expect(dashboard[0]?.todayStatus).toBe('COMPLETED');
  });

  it('rejects progress after the local deadline', async () => {
    const repository = new InMemoryHabitRepository();
    await waterHabit(repository);
    await expect(
      reportHabitProgress(
        repository,
        {
          userId,
          habitId,
          progressEventId: '55555555-5555-4555-8555-555555555555',
          amount: 100,
          occurredAt: '2026-07-31T20:01:00.000Z',
        },
        '2026-07-31T20:02:00.000Z',
      ),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('records a missed habit without deducting earned points', async () => {
    const repository = new InMemoryHabitRepository();
    const habit = await waterHabit(repository);
    const first = await settleHabit(repository, habit, '2026-07-31', '2026-07-31T20:01:00.000Z');
    const retry = await settleHabit(repository, habit, '2026-07-31', '2026-07-31T20:02:00.000Z');
    expect(first).toMatchObject({ status: 'MISSED' });
    expect(retry.duplicate).toBe(true);
  });

  it('records missed habits independently of subscription eligibility', async () => {
    const repository = new InMemoryHabitRepository();
    const habit = await waterHabit(repository);
    const result = await settleHabit(repository, habit, '2026-07-31', '2026-07-31T20:01:00.000Z');
    expect(result).toMatchObject({ status: 'MISSED' });
  });

  it('uses timezone-aware deadlines and returns only due scheduled dates', async () => {
    const repository = new InMemoryHabitRepository();
    const habit = await waterHabit(repository);
    expect(localDeadlineUtc('2026-07-31', 22 * 60, 'Europe/Zurich')).toBe(
      '2026-07-31T20:00:00.000Z',
    );
    expect(dueLocalDates(habit, '2026-07-31T19:59:00.000Z')).not.toContain('2026-07-31');
    expect(dueLocalDates(habit, '2026-07-31T20:00:00.000Z')).toContain('2026-07-31');
  });
});
