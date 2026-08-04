import type { HabitDefinition, HabitKind, HabitOccurrence } from './habit-types.js';
import { isScheduled, localParts } from './habits.js';
import type { AccountabilityStatistics } from './sync-types.js';

export type WeeklyRecapHabitKind = Exclude<HabitKind, 'CUSTOM'>;

export interface WeeklyRecapHabit {
  kind: WeeklyRecapHabitKind;
  title: string;
  unit: HabitDefinition['unit'];
  scheduledDays: number;
  completedDays: number;
  progressValue: number;
  targetValue: number;
  progressPercentage: number;
}

export interface WeeklyProgressRecap {
  period: 'WEEK';
  periodStart: string;
  periodEnd: string;
  includedDays: number;
  timezone: string;
  habits: WeeklyRecapHabit[];
  promisesScheduled: number;
  promisesKept: number;
  promisesPercentage: number;
  wakeUps: number;
  noSnoozeMornings: number;
  serverTimestamp: string;
}

export interface WeeklyRecapRepository {
  listHabits(userId: string): Promise<HabitDefinition[]>;
  listOccurrences(userId: string, localDate: string): Promise<HabitOccurrence[]>;
  statistics(userId: string, now: string): Promise<AccountabilityStatistics>;
}

const fixedHabitKinds: readonly WeeklyRecapHabitKind[] = [
  'WATER',
  'READING',
  'MEDITATION',
  'BED',
  'STEPS',
];

function isFixedHabitKind(kind: HabitKind): kind is WeeklyRecapHabitKind {
  return fixedHabitKinds.includes(kind as WeeklyRecapHabitKind);
}

function elapsedWeekDates(now: string, timezone: string): string[] {
  const current = localParts(now, timezone);
  const currentDate = new Date(Date.UTC(current.year, current.month - 1, current.day));
  const mondayOffset = current.weekday - 1;
  const monday = new Date(currentDate);
  monday.setUTCDate(monday.getUTCDate() - mondayOffset);

  const dates: string[] = [];
  for (let offset = 0; offset <= mondayOffset; offset += 1) {
    const date = new Date(monday);
    date.setUTCDate(monday.getUTCDate() + offset);
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

function percentage(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((value / total) * 10_000) / 100;
}

function habitRecap(
  habit: HabitDefinition & { kind: WeeklyRecapHabitKind },
  dates: readonly string[],
  occurrencesByDate: ReadonlyMap<string, readonly HabitOccurrence[]>,
): WeeklyRecapHabit {
  const scheduledDates = dates.filter((date) => isScheduled(habit, date));
  let progressValue = 0;
  let targetValue = 0;
  let completedDays = 0;

  for (const date of scheduledDates) {
    const occurrence = occurrencesByDate.get(date)?.find((item) => item.habitId === habit.id);
    const dayTarget = occurrence?.targetValue ?? habit.targetValue;
    progressValue += Math.min(occurrence?.progressValue ?? 0, dayTarget);
    targetValue += dayTarget;
    if (occurrence?.status === 'COMPLETED') completedDays += 1;
  }

  return {
    kind: habit.kind,
    title: habit.title,
    unit: habit.unit,
    scheduledDays: scheduledDates.length,
    completedDays,
    progressValue,
    targetValue,
    progressPercentage: percentage(progressValue, targetValue),
  };
}

export async function weeklyProgressRecap(
  repository: WeeklyRecapRepository,
  userId: string,
  now = new Date().toISOString(),
): Promise<WeeklyProgressRecap> {
  const statistics = await repository.statistics(userId, now);
  const dates = elapsedWeekDates(now, statistics.timezone);
  const [habits, occurrenceLists] = await Promise.all([
    repository.listHabits(userId),
    Promise.all(dates.map((date) => repository.listOccurrences(userId, date))),
  ]);
  const occurrencesByDate = new Map(
    dates.map((date, index) => [date, occurrenceLists[index] ?? []] as const),
  );
  const recapHabits = habits
    .filter((habit) => habit.activeState === 'ACTIVE' && isFixedHabitKind(habit.kind))
    .sort(
      (left, right) =>
        fixedHabitKinds.indexOf(left.kind as WeeklyRecapHabitKind) -
        fixedHabitKinds.indexOf(right.kind as WeeklyRecapHabitKind),
    )
    .map((habit) =>
      habitRecap({ ...habit, kind: habit.kind as WeeklyRecapHabitKind }, dates, occurrencesByDate),
    );
  const promisesScheduled = recapHabits.reduce((total, habit) => total + habit.scheduledDays, 0);
  const promisesKept = recapHabits.reduce((total, habit) => total + habit.completedDays, 0);

  return {
    period: 'WEEK',
    periodStart: dates[0]!,
    periodEnd: dates[dates.length - 1]!,
    includedDays: dates.length,
    timezone: statistics.timezone,
    habits: recapHabits,
    promisesScheduled,
    promisesKept,
    promisesPercentage: percentage(promisesKept, promisesScheduled),
    wakeUps: statistics.weekWakeUps,
    noSnoozeMornings: statistics.weekNoSnoozeMornings,
    serverTimestamp: statistics.serverTimestamp,
  };
}
