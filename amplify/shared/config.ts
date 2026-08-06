export const PLATFORM_CONFIG = {
  entitlementId: 'snoozefine_plus',
  monthlyProductId: 'snoozefine_plus_monthly',
  habitSettlementLookbackDays: 35,
  webhookMaxPayloadBytes: 256 * 1024,
} as const;

export type SupportedHabitKind =
  | 'WATER'
  | 'READING'
  | 'MEDITATION'
  | 'BED'
  | 'STEPS'
  | 'CALORIES'
  | 'EXERCISE_MINUTES'
  | 'SLEEP_MINUTES'
  | 'CUSTOM';

export interface AwardConfiguration {
  wakeCompletion: number;
  habits: Record<SupportedHabitKind, number>;
}

const DEFAULT_AWARDS: AwardConfiguration = {
  wakeCompletion: 20,
  habits: {
    WATER: 10,
    READING: 10,
    MEDITATION: 10,
    BED: 10,
    STEPS: 10,
    CALORIES: 10,
    EXERCISE_MINUTES: 10,
    SLEEP_MINUTES: 10,
    // Legacy custom habits are not creatable by the current API, but their
    // historical completion still receives the safe default award.
    CUSTOM: 10,
  },
};

const awardEnvironmentNames: Record<'wakeCompletion' | SupportedHabitKind, string> = {
  wakeCompletion: 'SNOOZEFINE_AWARD_WAKE_COMPLETION',
  WATER: 'SNOOZEFINE_AWARD_HABIT_WATER',
  READING: 'SNOOZEFINE_AWARD_HABIT_READING',
  MEDITATION: 'SNOOZEFINE_AWARD_HABIT_MEDITATION',
  BED: 'SNOOZEFINE_AWARD_HABIT_BED',
  STEPS: 'SNOOZEFINE_AWARD_HABIT_STEPS',
  CALORIES: 'SNOOZEFINE_AWARD_HABIT_CALORIES',
  EXERCISE_MINUTES: 'SNOOZEFINE_AWARD_HABIT_EXERCISE_MINUTES',
  SLEEP_MINUTES: 'SNOOZEFINE_AWARD_HABIT_SLEEP_MINUTES',
  CUSTOM: 'SNOOZEFINE_AWARD_HABIT_CUSTOM',
};

/**
 * Read award amounts at Lambda start from the deployment environment. Values
 * may be zero (to disable an award) but can never be negative or unbounded.
 * This is the only server-side source of earning amounts.
 */
export function awardConfigurationFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): AwardConfiguration {
  const parse = (key: keyof typeof awardEnvironmentNames, fallback: number): number => {
    const value = environment[awardEnvironmentNames[key]];
    if (value === undefined || value.length === 0) return fallback;
    if (!/^\d+$/.test(value))
      throw new Error(`${awardEnvironmentNames[key]} must be a nonnegative integer`);
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount > 10_000) {
      throw new Error(`${awardEnvironmentNames[key]} must be between 0 and 10000`);
    }
    return amount;
  };
  return {
    wakeCompletion: parse('wakeCompletion', DEFAULT_AWARDS.wakeCompletion),
    habits: {
      WATER: parse('WATER', DEFAULT_AWARDS.habits.WATER),
      READING: parse('READING', DEFAULT_AWARDS.habits.READING),
      MEDITATION: parse('MEDITATION', DEFAULT_AWARDS.habits.MEDITATION),
      BED: parse('BED', DEFAULT_AWARDS.habits.BED),
      STEPS: parse('STEPS', DEFAULT_AWARDS.habits.STEPS),
      CALORIES: parse('CALORIES', DEFAULT_AWARDS.habits.CALORIES),
      EXERCISE_MINUTES: parse('EXERCISE_MINUTES', DEFAULT_AWARDS.habits.EXERCISE_MINUTES),
      SLEEP_MINUTES: parse('SLEEP_MINUTES', DEFAULT_AWARDS.habits.SLEEP_MINUTES),
      CUSTOM: parse('CUSTOM', DEFAULT_AWARDS.habits.CUSTOM),
    },
  };
}

export function awardPointsForHabit(kind: SupportedHabitKind, awards: AwardConfiguration): number {
  return awards.habits[kind] ?? awards.habits.CUSTOM;
}

export const awardEnvironmentDefaults = (): Record<string, string> => ({
  [awardEnvironmentNames.wakeCompletion]: String(DEFAULT_AWARDS.wakeCompletion),
  [awardEnvironmentNames.WATER]: String(DEFAULT_AWARDS.habits.WATER),
  [awardEnvironmentNames.READING]: String(DEFAULT_AWARDS.habits.READING),
  [awardEnvironmentNames.MEDITATION]: String(DEFAULT_AWARDS.habits.MEDITATION),
  [awardEnvironmentNames.BED]: String(DEFAULT_AWARDS.habits.BED),
  [awardEnvironmentNames.STEPS]: String(DEFAULT_AWARDS.habits.STEPS),
  [awardEnvironmentNames.CALORIES]: String(DEFAULT_AWARDS.habits.CALORIES),
  [awardEnvironmentNames.EXERCISE_MINUTES]: String(DEFAULT_AWARDS.habits.EXERCISE_MINUTES),
  [awardEnvironmentNames.SLEEP_MINUTES]: String(DEFAULT_AWARDS.habits.SLEEP_MINUTES),
  [awardEnvironmentNames.CUSTOM]: String(DEFAULT_AWARDS.habits.CUSTOM),
});

export interface SocialConfiguration {
  maxActiveOutgoingRequests: number;
}

export function socialConfigurationFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): SocialConfiguration {
  const raw = environment.SNOOZEFINE_MAX_ACTIVE_OUTGOING_FRIEND_REQUESTS;
  if (raw === undefined || raw.length === 0) return { maxActiveOutgoingRequests: 20 };
  if (!/^\d+$/.test(raw)) {
    throw new Error('SNOOZEFINE_MAX_ACTIVE_OUTGOING_FRIEND_REQUESTS must be an integer');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error('SNOOZEFINE_MAX_ACTIVE_OUTGOING_FRIEND_REQUESTS must be between 1 and 100');
  }
  return { maxActiveOutgoingRequests: value };
}

export const socialEnvironmentDefaults = (): Record<string, string> => ({
  SNOOZEFINE_MAX_ACTIVE_OUTGOING_FRIEND_REQUESTS: '20',
});

export type RevenueCatEnvironment = 'SANDBOX' | 'PRODUCTION';

export function configuredEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): RevenueCatEnvironment {
  const value = environment.SNOOZEFINE_ENVIRONMENT ?? 'SANDBOX';
  if (value !== 'SANDBOX' && value !== 'PRODUCTION') {
    throw new Error('SNOOZEFINE_ENVIRONMENT must be SANDBOX or PRODUCTION');
  }
  return value;
}

/**
 * TestFlight purchases are RevenueCat SANDBOX transactions even when the app
 * talks to the production backend. This opt-in only affects subscription
 * eligibility; all user data remains in the configured deployment namespace.
 */
export function allowTestFlightSandboxSubscriptions(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return configuredEnvironment(environment) === 'PRODUCTION'
    ? environment.SNOOZEFINE_ALLOW_TESTFLIGHT_SANDBOX_SUBSCRIPTIONS === 'true'
    : false;
}
