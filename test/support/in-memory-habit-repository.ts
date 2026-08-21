import { DomainError } from '../../amplify/shared/domain.js';
import type { HabitRepository } from '../../amplify/shared/habit-repository.js';
import type {
  HabitDefinition,
  HabitOccurrence,
  HabitProgressResult,
  HabitSettlementResult,
  SaveHabitCommand,
} from '../../amplify/shared/habit-types.js';

export class InMemoryHabitRepository implements HabitRepository {
  public readonly habits = new Map<string, HabitDefinition>();
  public readonly occurrences = new Map<string, HabitOccurrence>();
  public readonly progressEvents = new Map<string, string>();

  public async listHabits(userId: string): Promise<HabitDefinition[]> {
    return [...this.habits.values()].filter((habit) => habit.userId === userId);
  }

  public async getHabit(userId: string, habitId: string): Promise<HabitDefinition | undefined> {
    const habit = this.habits.get(habitId);
    return habit?.userId === userId ? habit : undefined;
  }

  public async saveHabit(
    command: SaveHabitCommand,
    startDate: string,
    now: string,
  ): Promise<HabitDefinition> {
    const current = this.habits.get(command.habitId);
    if (current !== undefined && current.userId !== command.userId) {
      throw new DomainError('HABIT_ID_ALREADY_USED');
    }
    const habit: HabitDefinition = {
      id: command.habitId,
      userId: command.userId,
      environment: 'SANDBOX',
      userEnvironment: `${command.userId}:SANDBOX`,
      environmentState: 'SANDBOX:ACTIVE',
      kind: command.kind,
      title: command.title,
      targetValue: command.targetValue,
      stepValue: command.stepValue,
      unit: command.unit,
      weekdays: command.weekdays,
      deadlineMinutes: command.deadlineMinutes,
      timezone: command.timezone,
      startDate: current?.startDate ?? startDate,
      activeState: 'ACTIVE',
      version: (current?.version ?? 0) + 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.habits.set(habit.id, habit);
    return habit;
  }

  public async archiveHabit(
    userId: string,
    habitId: string,
    now: string,
  ): Promise<HabitDefinition> {
    const habit = await this.getHabit(userId, habitId);
    if (habit === undefined) throw new DomainError('HABIT_NOT_FOUND');
    const archived: HabitDefinition = {
      ...habit,
      activeState: 'ARCHIVED',
      environmentState: 'SANDBOX:ARCHIVED',
      version: habit.version + 1,
      updatedAt: now,
    };
    this.habits.set(habitId, archived);
    return archived;
  }

  public async recordHabitProgress(
    input: Parameters<HabitRepository['recordHabitProgress']>[0],
  ): Promise<HabitProgressResult> {
    const priorOccurrenceId = this.progressEvents.get(input.command.progressEventId);
    if (priorOccurrenceId !== undefined) {
      const prior = this.occurrences.get(priorOccurrenceId);
      if (prior === undefined) throw new DomainError('PROGRESS_EVENT_INCOMPLETE');
      return this.progressResult(prior, true, input.now);
    }
    const current = this.occurrences.get(input.occurrence.id);
    if (
      (current?.status === 'MISSED' && input.allowMissedReopen !== true) ||
      current?.status === 'SKIPPED_INELIGIBLE'
    ) {
      throw new DomainError('HABIT_ALREADY_SETTLED');
    }
    const progressValue = Math.min(
      input.habit.targetValue,
      (current?.progressValue ?? 0) + input.command.amount,
    );
    const completed = progressValue >= input.habit.targetValue;
    const occurrence: HabitOccurrence = {
      ...(current ?? input.occurrence),
      targetValue: input.habit.targetValue,
      unit: input.habit.unit,
      progressValue,
      status: completed ? 'COMPLETED' : 'PENDING',
      completedAt: completed ? (current?.completedAt ?? input.command.occurredAt) : undefined,
      missedAt: undefined,
      version: (current?.version ?? 0) + 1,
      updatedAt: input.now,
    };
    this.progressEvents.set(input.command.progressEventId, occurrence.id);
    this.occurrences.set(occurrence.id, occurrence);
    return this.progressResult(occurrence, false, input.now);
  }

  public async listActiveHabits(): Promise<HabitDefinition[]> {
    return [...this.habits.values()].filter((habit) => habit.activeState === 'ACTIVE');
  }

  public async settleMissedHabit(
    input: Parameters<HabitRepository['settleMissedHabit']>[0],
  ): Promise<HabitSettlementResult> {
    const current = this.occurrences.get(input.occurrence.id);
    const currentStatus =
      current?.status === 'COMPLETED' && current.progressValue < input.habit.targetValue
        ? 'PENDING'
        : current?.status;
    if (current !== undefined && currentStatus !== 'PENDING') {
      return {
        duplicate: true,
        status: current.status,
      };
    }
    const missed: HabitOccurrence = {
      ...(current ?? input.occurrence),
      targetValue: input.habit.targetValue,
      unit: input.habit.unit,
      status: 'MISSED',
      completedAt: undefined,
      missedAt: input.now,
      version: (current?.version ?? 0) + 1,
      updatedAt: input.now,
    };
    this.occurrences.set(missed.id, missed);
    return {
      duplicate: false,
      status: missed.status,
    };
  }

  public async listOccurrences(userId: string, localDate: string): Promise<HabitOccurrence[]> {
    return [...this.occurrences.values()].filter(
      (occurrence) => occurrence.userId === userId && occurrence.localDate === localDate,
    );
  }

  private progressResult(
    occurrence: HabitOccurrence,
    duplicate: boolean,
    now: string,
  ): HabitProgressResult {
    return {
      accepted: true,
      duplicate,
      completed: occurrence.status === 'COMPLETED',
      localDate: occurrence.localDate,
      progressValue: occurrence.progressValue,
      targetValue: occurrence.targetValue,
      status: occurrence.status,
      serverTimestamp: now,
    };
  }
}
