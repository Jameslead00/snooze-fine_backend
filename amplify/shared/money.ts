export function expectedDonationMicroUsd(points: number, microUsdPerPoint: number): number {
  if (!Number.isSafeInteger(points) || points < 0) {
    throw new Error('points must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(microUsdPerPoint) || microUsdPerPoint < 0) {
    throw new Error('microUsdPerPoint must be a non-negative safe integer');
  }
  const result = points * microUsdPerPoint;
  if (!Number.isSafeInteger(result)) {
    throw new Error('expected donation exceeds safe integer range');
  }
  return result;
}

export function formatMicroUsd(microUsd: number): string {
  if (!Number.isSafeInteger(microUsd)) {
    throw new Error('microUsd must be a safe integer');
  }
  const sign = microUsd < 0 ? '-' : '';
  const absolute = Math.abs(microUsd);
  const dollars = Math.floor(absolute / 1_000_000);
  const cents = Math.floor((absolute % 1_000_000) / 10_000);
  return `${sign}$${dollars}.${cents.toString().padStart(2, '0')}`;
}
