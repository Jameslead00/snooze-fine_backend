import type { RevenueCatEnvironment } from './config.js';

export type PointQualification = 'WAKE_COMPLETION' | 'HABIT_COMPLETION';

export interface DisciPointAccount {
  id: string;
  userId: string;
  environment: RevenueCatEnvironment;
  userEnvironment: string;
  currentPoints: number;
  lifetimeEarned: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface DisciPointEarnEvent {
  id: string;
  userId: string;
  environment: RevenueCatEnvironment;
  userEnvironment: string;
  qualification: PointQualification;
  sourceEventId: string;
  pointsEarned: number;
  pointsAfter: number;
  createdAt: string;
}

export interface EarnPointsCommand {
  userId: string;
  qualification: PointQualification;
  sourceEventId: string;
  points: number;
}

export interface EarnPointsResult {
  duplicate: boolean;
  pointsEarned: number;
  currentPoints: number;
  lifetimeEarned: number;
  serverTimestamp: string;
}

export interface DisciPointAccountView {
  currentPoints: number;
  lifetimeEarned: number;
  serverTimestamp: string;
}

export interface PointAwardPage {
  items: Array<{
    id: string;
    achievementType: PointQualification;
    pointsAwarded: number;
    reasonCode: string;
    source: string;
    sourceEventId: string;
    relatedEventId: string | undefined;
    earnedPointsTotalAfter: number;
    ballotId: string | undefined;
    createdAt: string;
  }>;
  nextToken: string | undefined;
}
