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
  public readonly balances = new Map<string, number>();
  public readonly deductions: Array<{ occurrenceId: string; amount: number }> = [];
  public eligible = true;

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
    penaltyPoints: number,
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
      penaltyPoints,
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
    if (current?.status === 'MISSED' || current?.status === 'SKIPPED_INELIGIBLE') {
      throw new DomainError('HABIT_ALREADY_SETTLED');
    }
    const progressValue = Math.min(
      input.habit.targetValue,
      (current?.progressValue ?? 0) + input.command.amount,
    );
    const completed = progressValue >= input.habit.targetValue;
    const occurrence: HabitOccurrence = {
      ...(current ?? input.occurrence),
      progressValue,
      status: completed ? 'COMPLETED' : 'PENDING',
      completedAt: completed ? input.command.occurredAt : current?.completedAt,
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
    if (current !== undefined && current.status !== 'PENDING') {
      return {
        duplicate: true,
        status: current.status,
        pointsDeducted: current.pointsDeducted,
        officialBalance: current.officialBalance,
      };
    }
    const missed: HabitOccurrence = {
      ...(current ?? input.occurrence),
      status: 'MISSED',
      pointsDeducted: 0,
      missedAt: input.now,
      version: (current?.version ?? 0) + 1,
      updatedAt: input.now,
    };
    this.occurrences.set(missed.id, missed);
    return {
      duplicate: false,
      status: missed.status,
      pointsDeducted: 0,
      officialBalance: missed.officialBalance,
    };
  }

  public async officialBalance(userId: string): Promise<number> {
    return this.balances.get(userId) ?? 0;
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
      officialBalance: this.balances.get(occurrence.userId) ?? 0,
      serverTimestamp: now,
    };
  }
}
