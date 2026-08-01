import type { RevenueCatEnvironment } from './config.js';

export type EngagementEventName =
  | 'SESSION_STARTED'
  | 'SUBSCRIPTION_GATE_VIEWED'
  | 'TODAY_VIEWED'
  | 'HABITS_VIEWED'
  | 'COMMUNITY_VIEWED'
  | 'ACCOUNT_VIEWED';

export interface RecordEngagementCommand {
  userId: string;
  eventId: string;
  sessionId: string;
  name: EngagementEventName;
  occurredAt: string;
  appVersion?: string | undefined;
}

export interface EngagementEvent extends RecordEngagementCommand {
  environment: RevenueCatEnvironment;
  userEnvironment: string;
  platform: 'IOS';
  receivedAt: string;
}

export interface RecordEngagementResult {
  accepted: true;
  duplicate: boolean;
  serverTimestamp: string;
}
