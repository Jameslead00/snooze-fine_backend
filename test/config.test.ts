import { describe, expect, it } from 'vitest';
import {
  awardConfigurationFromEnvironment,
  awardPointsForHabit,
  socialConfigurationFromEnvironment,
} from '../amplify/shared/config.js';

describe('server-owned configuration', () => {
  it('uses validated per-kind award values without a client release', () => {
    const awards = awardConfigurationFromEnvironment({
      SNOOZEFINE_AWARD_WAKE_COMPLETION: '40',
      SNOOZEFINE_AWARD_HABIT_WATER: '7',
      SNOOZEFINE_AWARD_HABIT_BED: '0',
    });
    expect(awards.wakeCompletion).toBe(40);
    expect(awardPointsForHabit('WATER', awards)).toBe(7);
    expect(awardPointsForHabit('BED', awards)).toBe(0);
  });

  it('rejects negative or unsafe award and request-cap values', () => {
    expect(() =>
      awardConfigurationFromEnvironment({ SNOOZEFINE_AWARD_HABIT_WATER: '-1' }),
    ).toThrow();
    expect(() =>
      awardConfigurationFromEnvironment({ SNOOZEFINE_AWARD_WAKE_COMPLETION: '10001' }),
    ).toThrow();
    expect(() =>
      socialConfigurationFromEnvironment({ SNOOZEFINE_MAX_ACTIVE_OUTGOING_FRIEND_REQUESTS: '0' }),
    ).toThrow();
  });
});
