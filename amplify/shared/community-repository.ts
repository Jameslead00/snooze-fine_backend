import type { CommunityDashboard, CommunityVoteResult } from './community-types.js';

export interface CommunityRepository {
  dashboard: (userId: string, now: string) => Promise<CommunityDashboard>;
  castVote: (userId: string, charityId: string, now: string) => Promise<CommunityVoteResult>;
}
