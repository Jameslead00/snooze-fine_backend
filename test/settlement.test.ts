import { describe, expect, it } from 'vitest';
import { calculateSettlement, runSettlement } from '../amplify/shared/domain.js';
import { expectedDonationMicroUsd, formatMicroUsd } from '../amplify/shared/money.js';
import type { SettlementCandidate } from '../amplify/shared/types.js';
import { InMemoryRepository } from './support/in-memory-repository.js';

const cutoff = '2026-07-31T23:59:59.999Z';
const candidate: SettlementCandidate = {
  userId: 'user-1',
  environment: 'SANDBOX',
  resolved: true,
  subscriptionStatus: 'ACTIVE',
  subscriptionStatusEffectiveAt: '2026-07-01T00:00:01.000Z',
  periodStart: '2026-07-01T00:00:00.000Z',
  periodEnd: '2026-08-01T00:00:00.000Z',
  allocated: 2_000,
  remaining: 1_950,
};

describe('integer settlement calculations', () => {
  it('uses integer micro-USD arithmetic', () => {
    expect(expectedDonationMicroUsd(1_975, 1_000)).toBe(1_975_000);
    expect(formatMicroUsd(1_975_000)).toBe('$1.97');
  });

  it('values 2,000 points at exactly USD 2', () => {
    const microUsd = expectedDonationMicroUsd(2_000, 1_000);
    expect(microUsd).toBe(2_000_000);
    expect(formatMicroUsd(microUsd)).toBe('$2.00');
  });

  it('excludes unresolved, wrong-environment, expired-at-cutoff and duplicate users', () => {
    const calculation = calculateSettlement(
      [
        candidate,
        { ...candidate, periodStart: '2026-06-01T00:00:00.000Z', remaining: 2_000 },
        { ...candidate, userId: 'unresolved', resolved: false },
        { ...candidate, userId: 'production', environment: 'PRODUCTION' },
        {
          ...candidate,
          userId: 'expired',
          subscriptionStatus: 'EXPIRED',
          subscriptionStatusEffectiveAt: '2026-07-15T00:00:00.000Z',
          periodEnd: '2026-07-15T00:00:00.000Z',
        },
      ],
      'SANDBOX',
      cutoff,
    );

    expect(calculation).toEqual({
      eligibleUserCount: 1,
      totalAllocatedPoints: 2_000,
      totalDeductedPoints: 50,
      totalRemainingPoints: 1_950,
      expectedDonationMicroUsd: 1_950_000,
    });
  });

  it('includes a period that was active at cutoff but expired afterward', () => {
    const calculation = calculateSettlement(
      [
        {
          ...candidate,
          subscriptionStatus: 'EXPIRED',
          subscriptionStatusEffectiveAt: '2026-08-01T00:00:01.000Z',
        },
      ],
      'SANDBOX',
      cutoff,
    );

    expect(calculation.eligibleUserCount).toBe(1);
    expect(calculation.totalRemainingPoints).toBe(1_950);
  });

  it('makes settlement reruns idempotent', async () => {
    const repository = new InMemoryRepository();
    repository.listSettlementCandidates = async () => [candidate];

    const first = await runSettlement(repository, '2026-07', 'SANDBOX', cutoff);
    const second = await runSettlement(repository, '2026-07', 'SANDBOX', cutoff);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(repository.settlements.size).toBe(1);
  });
});
