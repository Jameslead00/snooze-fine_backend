import { describe, expect, it } from 'vitest';
import { DomainError } from '../amplify/shared/domain.js';
import {
  archiveHabit,
  dueLocalDates,
  habitDay,
  localDayEndUtc,
  habitDashboard,
  localDeadlineUtc,
  reconcileLoweredHabitGoal,
  reportHabitProgress,
  saveHabit,
  settleHabit,
  shiftedLocalDate,
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

  it('reopens today when an edited goal exceeds existing completed progress', async () => {
    const repository = new InMemoryHabitRepository();
    await waterHabit(repository);
    await reportHabitProgress(
      repository,
      {
        userId,
        habitId,
        progressEventId: '66666666-6666-4666-8666-666666666666',
        amount: 2_000,
        occurredAt: '2026-07-31T13:00:00.000Z',
      },
      '2026-07-31T13:01:00.000Z',
    );

    await saveHabit(
      repository,
      {
        userId,
        habitId,
        kind: 'WATER',
        title: 'Drink water',
        targetValue: 5_000,
        stepValue: 250,
        unit: 'MILLILITRES',
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        deadlineMinutes: 22 * 60,
        timezone: 'Europe/Zurich',
      },
      '2026-07-31T13:02:00.000Z',
    );

    const reopened = await habitDashboard(repository, userId, '2026-07-31T13:03:00.000Z');
    expect(reopened[0]).toMatchObject({
      targetValue: 5_000,
      todayProgress: 2_000,
      todayStatus: 'PENDING',
    });

    const continued = await reportHabitProgress(
      repository,
      {
        userId,
        habitId,
        progressEventId: '77777777-7777-4777-8777-777777777777',
        amount: 500,
        occurredAt: '2026-07-31T13:04:00.000Z',
      },
      '2026-07-31T13:05:00.000Z',
    );
    expect(continued).toMatchObject({
      completed: false,
      progressValue: 2_500,
      targetValue: 5_000,
      status: 'PENDING',
    });
  });

  it('completes a pending occurrence when an edited goal drops below accepted progress', async () => {
    const repository = new InMemoryHabitRepository();
    const original = await waterHabit(repository);
    await reportHabitProgress(
      repository,
      {
        userId,
        habitId,
        progressEventId: '99999999-9999-4999-8999-999999999999',
        amount: 1_900,
        occurredAt: '2026-07-31T13:00:00.000Z',
      },
      '2026-07-31T13:01:00.000Z',
    );
    const lowered = await saveHabit(
      repository,
      {
        userId,
        habitId,
        kind: original.kind as 'WATER',
        title: original.title,
        targetValue: 1_800,
        stepValue: original.stepValue,
        unit: original.unit,
        weekdays: original.weekdays,
        deadlineMinutes: original.deadlineMinutes,
        timezone: original.timezone,
      },
      '2026-07-31T13:02:00.000Z',
    );

    const result = await reconcileLoweredHabitGoal(repository, lowered, '2026-07-31T13:03:00.000Z');
    const retry = await reconcileLoweredHabitGoal(repository, lowered, '2026-07-31T13:04:00.000Z');
    const dashboard = await habitDashboard(repository, userId, '2026-07-31T13:05:00.000Z');

    expect(result).toMatchObject({ completed: true, progressValue: 1_800 });
    expect(retry).toBeUndefined();
    expect(dashboard[0]).toMatchObject({
      targetValue: 1_800,
      todayProgress: 1_800,
      todayStatus: 'COMPLETED',
    });
  });

  it('settles a raised unfinished goal instead of preserving its old completion', async () => {
    const repository = new InMemoryHabitRepository();
    await waterHabit(repository);
    await reportHabitProgress(
      repository,
      {
        userId,
        habitId,
        progressEventId: '88888888-8888-4888-8888-888888888888',
        amount: 2_000,
        occurredAt: '2026-07-31T13:00:00.000Z',
      },
      '2026-07-31T13:01:00.000Z',
    );
    const raised = await saveHabit(
      repository,
      {
        userId,
        habitId,
        kind: 'WATER',
        title: 'Drink water',
        targetValue: 5_000,
        stepValue: 250,
        unit: 'MILLILITRES',
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        deadlineMinutes: 22 * 60,
        timezone: 'Europe/Zurich',
      },
      '2026-07-31T13:02:00.000Z',
    );

    const result = await settleHabit(repository, raised, '2026-07-31', '2026-07-31T20:01:00.000Z');
    expect(result).toMatchObject({ duplicate: false, status: 'MISSED' });
    expect([...repository.occurrences.values()][0]).toMatchObject({
      targetValue: 5_000,
      progressValue: 2_000,
      status: 'MISSED',
      completedAt: undefined,
    });
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

  it('returns yesterday with its stored target and a one-day editing window', async () => {
    const repository = new InMemoryHabitRepository();
    const original = await waterHabit(repository);
    await settleHabit(repository, original, '2026-07-31', '2026-07-31T20:01:00.000Z');
    await saveHabit(
      repository,
      {
        userId,
        habitId,
        kind: 'WATER',
        title: 'Drink more water',
        targetValue: 5_000,
        stepValue: 500,
        unit: 'MILLILITRES',
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        deadlineMinutes: 22 * 60,
        timezone: 'Europe/Zurich',
      },
      '2026-08-01T08:00:00.000Z',
    );

    const yesterday = await habitDay(repository, userId, -1, '2026-08-01T12:00:00.000Z');

    expect(yesterday).toEqual([
      expect.objectContaining({
        id: habitId,
        localDate: '2026-07-31',
        targetValue: 2_000,
        progressValue: 0,
        status: 'MISSED',
        editable: true,
        editableUntil: '2026-08-01T21:59:59.999Z',
      }),
    ]);
  });

  it('reopens and completes yesterday without changing its historical target', async () => {
    const repository = new InMemoryHabitRepository();
    const original = await waterHabit(repository);
    await settleHabit(repository, original, '2026-07-31', '2026-07-31T20:01:00.000Z');
    await saveHabit(
      repository,
      {
        userId,
        habitId,
        kind: 'WATER',
        title: 'Drink more water',
        targetValue: 5_000,
        stepValue: 500,
        unit: 'MILLILITRES',
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        deadlineMinutes: 22 * 60,
        timezone: 'Europe/Zurich',
      },
      '2026-08-01T08:00:00.000Z',
    );

    const result = await reportHabitProgress(
      repository,
      {
        userId,
        habitId,
        progressEventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        amount: 2_000,
        occurredAt: '2026-08-01T12:00:00.000Z',
        targetLocalDate: '2026-07-31',
      },
      '2026-08-01T12:01:00.000Z',
    );

    expect(result).toMatchObject({
      completed: true,
      localDate: '2026-07-31',
      targetValue: 2_000,
      progressValue: 2_000,
      status: 'COMPLETED',
    });
    expect(repository.occurrences.values().next().value).toMatchObject({
      missedAt: undefined,
      completedAt: '2026-08-01T12:00:00.000Z',
    });
  });

  it('rejects dates outside today and yesterday and includes the full grace day', async () => {
    const repository = new InMemoryHabitRepository();
    const habit = await waterHabit(repository);
    await settleHabit(repository, habit, '2026-07-31', '2026-07-31T20:01:00.000Z');

    await expect(
      reportHabitProgress(
        repository,
        {
          userId,
          habitId,
          progressEventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          amount: 250,
          occurredAt: '2026-08-01T12:00:00.000Z',
          targetLocalDate: '2026-07-30',
        },
        '2026-08-01T12:01:00.000Z',
      ),
    ).rejects.toMatchObject({ code: 'HABIT_DAY_OUT_OF_RANGE' });

    const acceptedAtEndOfDay = await reportHabitProgress(
      repository,
      {
        userId,
        habitId,
        progressEventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        amount: 250,
        occurredAt: '2026-08-01T21:59:30.000Z',
        targetLocalDate: '2026-07-31',
      },
      '2026-08-01T21:59:30.000Z',
    );
    expect(acceptedAtEndOfDay).toMatchObject({ localDate: '2026-07-31', progressValue: 250 });
  });

  it('uses calendar date arithmetic across daylight-saving boundaries', () => {
    expect(shiftedLocalDate('2026-03-30', -1)).toBe('2026-03-29');
    expect(shiftedLocalDate('2026-11-01', -1)).toBe('2026-10-31');
    expect(localDayEndUtc('2026-03-29', 'Europe/Zurich')).toBe('2026-03-29T21:59:59.999Z');
    expect(localDayEndUtc('2026-10-25', 'Europe/Zurich')).toBe('2026-10-25T22:59:59.999Z');
  });
});
