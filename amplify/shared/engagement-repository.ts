import type { RecordEngagementCommand, RecordEngagementResult } from './engagement-types.js';

export interface EngagementRepository {
  recordEngagement: (
    command: RecordEngagementCommand,
    now: string,
  ) => Promise<RecordEngagementResult>;
}
