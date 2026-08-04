import type {
  DisciPointAccountView,
  EarnPointsCommand,
  EarnPointsResult,
  PointAwardPage,
} from './earned-points-types.js';

export interface EarnedPointsRepository {
  earnPoints(command: EarnPointsCommand, now: string): Promise<EarnPointsResult>;
  getDisciPointAccount(userId: string, now: string): Promise<DisciPointAccountView>;
  listPointAwards(userId: string, limit: number, nextToken: string | undefined): Promise<PointAwardPage>;
}
