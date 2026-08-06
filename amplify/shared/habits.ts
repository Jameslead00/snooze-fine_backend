import { DomainError } from './domain.js';
import { awardPointsForHabit, type AwardConfiguration } from './config.js';
import { awardConfigurationFromEnvironment } from './config.js';
import type { HabitRepository } from './habit-repository.js';
import type {
  HabitDefinition,
  HabitOccurrence,
  HabitProgressCommand,
  HabitProgressResult,
  HabitSettlementResult,
  HabitView,
  HabitUnit,
  SaveHabitCommand,
} from './habit-types.js';
import { sha256 } from './security.js';

const weekdayNumbers: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

interface LocalParts {
  date: string;
  weekday: number;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function formatter(timezone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    });
  } catch {
    throw new DomainError('INVALID_TIMEZONE');
  }
}

export function localParts(iso: string, timezone: string): LocalParts {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) throw new DomainError('INVALID_TIMESTAMP');
  const parts = Object.fromEntries(
    formatter(timezone)
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const weekday = weekdayNumbers[parts.weekday ?? ''];
  if (weekday === undefined) throw new DomainError('INVALID_TIMEZONE');
  return {
    date: `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
      .toString()
      .padStart(2, '0')}`,
    weekday,
    year,
    month,
    day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

export function localDeadlineUtc(
  localDate: string,
  deadlineMinutes: number,
  timezone: string,
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (match === null) throw new DomainError('INVALID_LOCAL_DATE');
  const targetYear = Number(match[1]);
  const targetMonth = Number(match[2]);
  const targetDay = Number(match[3]);
  const targetHour = Math.floor(deadlineMinutes / 60);
  const targetMinute = deadlineMinutes % 60;
  const targetLocalMs = Date.UTC(targetYear, targetMonth - 1, targetDay, targetHour, targetMinute);
  let candidate = targetLocalMs;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const represented = localParts(new Date(candidate).toISOString(), timezone);
    const representedLocalMs = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second,
    );
    candidate += targetLocalMs - representedLocalMs;
  }
  return new Date(candidate).toISOString();
}

export function isScheduled(habit: HabitDefinition, localDate: string): boolean {
  if (localDate < habit.startDate || habit.activeState !== 'ACTIVE') return false;
  const midday = localDeadlineUtc(localDate, 12 * 60, habit.timezone);
  return habit.weekdays.includes(localParts(midday, habit.timezone).weekday);
}

export function occurrenceFor(
  habit: HabitDefinition,
  localDate: string,
  now: string,
): HabitOccurrence {
  return {
    id: sha256(`habit-occurrence:${habit.userId}:${habit.id}:${localDate}`),
    userId: habit.userId,
    environment: habit.environment,
    userEnvironmentDate: `${habit.userEnvironment}:${localDate}`,
    habitId: habit.id,
    localDate,
    dueAt: localDeadlineUtc(localDate, habit.deadlineMinutes, habit.timezone),
    targetValue: habit.targetValue,
    unit: habit.unit,
    progressValue: 0,
    status: 'PENDING',
    completedAt: undefined,
    missedAt: undefined,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function validateHabit(command: SaveHabitCommand): void {
  if (!/^[0-9a-f-]{36}$/i.test(command.habitId)) throw new DomainError('INVALID_HABIT_ID');
  if (command.title.trim().length === 0 || command.title.length > 80) {
    throw new DomainError('INVALID_HABIT_TITLE');
  }
  if (
    !Number.isInteger(command.targetValue) ||
    command.targetValue < 1 ||
    command.targetValue > 100_000
  ) {
    throw new DomainError('INVALID_HABIT_TARGET');
  }
  if (
    !Number.isInteger(command.stepValue) ||
    command.stepValue < 1 ||
    command.stepValue > command.targetValue
  ) {
    throw new DomainError('INVALID_HABIT_STEP');
  }
  const expectedUnit: HabitUnit =
    command.kind === 'WATER'
      ? 'MILLILITRES'
      : command.kind === 'CALORIES'
        ? 'KILOCALORIES'
        : command.kind === 'BED'
          ? 'CHECKMARK'
          : command.kind === 'STEPS'
            ? 'COUNT'
            : 'MINUTES';
  if (command.unit !== expectedUnit) throw new DomainError('INVALID_HABIT_UNIT');
  if (
    command.weekdays.length === 0 ||
    command.weekdays.length > 7 ||
    command.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7) ||
    new Set(command.weekdays).size !== command.weekdays.length
  ) {
    throw new DomainError('INVALID_HABIT_WEEKDAYS');
  }
  if (
    !Number.isInteger(command.deadlineMinutes) ||
    command.deadlineMinutes < 0 ||
    command.deadlineMinutes > 1_439
  ) {
    throw new DomainError('INVALID_HABIT_DEADLINE');
  }
  formatter(command.timezone);
}

export async function saveHabit(
  repository: HabitRepository,
  command: SaveHabitCommand,
  now = new Date().toISOString(),
): Promise<HabitDefinition> {
  validateHabit(command);
  const startDate = localParts(now, command.timezone).date;
  return repository.saveHabit(
    { ...command, title: command.title.trim(), weekdays: [...command.weekdays].sort() },
    startDate,
    now,
  );
}

export async function archiveHabit(
  repository: HabitRepository,
  userId: string,
  habitId: string,
  now = new Date().toISOString(),
): Promise<HabitDefinition> {
  return repository.archiveHabit(userId, habitId, now);
}

export async function habitDashboard(
  repository: HabitRepository,
  userId: string,
  now = new Date().toISOString(),
  awards: AwardConfiguration = awardConfigurationFromEnvironment(),
): Promise<HabitView[]> {
  const habits = (await repository.listHabits(userId)).filter(
    (habit) => habit.activeState === 'ACTIVE',
  );
  const dates = new Set(habits.map((habit) => localParts(now, habit.timezone).date));
  const occurrences = (
    await Promise.all([...dates].map((date) => repository.listOccurrences(userId, date)))
  ).flat();
  const occurrenceByHabit = new Map(occurrences.map((item) => [item.habitId, item]));
  return habits.map((habit) =>
    habitViewFromOccurrence(
      habit,
      localParts(now, habit.timezone).date,
      occurrenceByHabit.get(habit.id),
      awards,
    ),
  );
}

/**
 * Compose a single habit view from the write result and an optional occurrence.
 * The definition returned by DynamoDB is authoritative; callers must not query
 * the eventually-consistent habit GSI to prove a successful write.
 */
export function habitViewFromOccurrence(
  habit: HabitDefinition,
  localDate: string,
  occurrence: HabitOccurrence | undefined,
  awards: AwardConfiguration,
): HabitView {
  const scheduledToday = isScheduled(habit, localDate);
  return {
    ...habit,
    scheduledToday,
    todayProgress: occurrence?.progressValue ?? 0,
    todayStatus: scheduledToday ? (occurrence?.status ?? 'PENDING') : 'NOT_SCHEDULED',
    todayDueAt: scheduledToday
      ? (occurrence?.dueAt ?? localDeadlineUtc(localDate, habit.deadlineMinutes, habit.timezone))
      : undefined,
    completionAwardPoints: awardPointsForHabit(habit.kind, awards),
  };
}

export async function habitView(
  repository: HabitRepository,
  habit: HabitDefinition,
  now = new Date().toISOString(),
  awards: AwardConfiguration = awardConfigurationFromEnvironment(),
): Promise<HabitView> {
  const localDate = localParts(now, habit.timezone).date;
  const occurrence = (await repository.listOccurrences(habit.userId, localDate)).find(
    (item) => item.habitId === habit.id,
  );
  return habitViewFromOccurrence(habit, localDate, occurrence, awards);
}

export async function reportHabitProgress(
  repository: HabitRepository,
  command: HabitProgressCommand,
  now = new Date().toISOString(),
): Promise<HabitProgressResult> {
  const habit = await repository.getHabit(command.userId, command.habitId);
  if (habit === undefined || habit.activeState !== 'ACTIVE')
    throw new DomainError('HABIT_NOT_FOUND');
  if (!Number.isInteger(command.amount) || command.amount < 1 || command.amount > 100_000) {
    throw new DomainError('INVALID_HABIT_PROGRESS');
  }
  const occurredAt = Date.parse(command.occurredAt);
  const serverTime = Date.parse(now);
  if (!Number.isFinite(occurredAt)) throw new DomainError('INVALID_TIMESTAMP');
  if (occurredAt > serverTime + 5 * 60 * 1_000 || occurredAt < serverTime - 24 * 60 * 60 * 1_000) {
    throw new DomainError('INVALID_PROGRESS_TIME');
  }
  const localDate = localParts(command.occurredAt, habit.timezone).date;
  if (!isScheduled(habit, localDate)) throw new DomainError('HABIT_NOT_SCHEDULED');
  const occurrence = occurrenceFor(habit, localDate, now);
  if (Date.parse(now) > Date.parse(occurrence.dueAt))
    throw new DomainError('HABIT_DEADLINE_PASSED');
  return repository.recordHabitProgress({ command, habit, occurrence, now });
}

export function dueLocalDates(habit: HabitDefinition, now: string, lookbackDays = 35): string[] {
  const dates: string[] = [];
  const nowMs = Date.parse(now);
  for (let offset = 0; offset <= lookbackDays; offset += 1) {
    const sample = new Date(nowMs - offset * 24 * 60 * 60 * 1_000).toISOString();
    const localDate = localParts(sample, habit.timezone).date;
    if (
      !dates.includes(localDate) &&
      isScheduled(habit, localDate) &&
      Date.parse(localDeadlineUtc(localDate, habit.deadlineMinutes, habit.timezone)) <= nowMs
    ) {
      dates.push(localDate);
    }
  }
  return dates.sort();
}

export async function settleHabit(
  repository: HabitRepository,
  habit: HabitDefinition,
  localDate: string,
  now = new Date().toISOString(),
): Promise<HabitSettlementResult> {
  if (!isScheduled(habit, localDate)) throw new DomainError('HABIT_NOT_SCHEDULED');
  const occurrence = occurrenceFor(habit, localDate, now);
  if (Date.parse(occurrence.dueAt) > Date.parse(now)) throw new DomainError('HABIT_NOT_DUE');
  return repository.settleMissedHabit({ habit, occurrence, now });
}
