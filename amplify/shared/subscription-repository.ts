import type { RevenueCatEnvironment } from './config.js';
import type { SubscriptionState } from './types.js';

export interface SubscriptionRepository {
  getSubscriptionState(
    userId: string,
    environment: RevenueCatEnvironment,
  ): Promise<SubscriptionState | undefined>;
}
