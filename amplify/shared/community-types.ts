export interface CommunityCharity {
  id: string;
  name: string;
  summary: string;
  websiteUrl?: string | undefined;
  impactLabel?: string | undefined;
  votes: number;
  votePercentage: number;
  myAllocatedVotes: number;
}

export interface CommunityDonationProjection {
  eligibleMemberCount: number;
  remainingPoints: number;
  expectedDonationMicroUsd: number;
}

export interface CommunityDashboard {
  ballotId?: string | undefined;
  month?: string | undefined;
  status: 'NOT_PUBLISHED' | 'OPEN' | 'CLOSED';
  opensAt?: string | undefined;
  closesAt?: string | undefined;
  charities: CommunityCharity[];
  totalVotes: number;
  earnedVotes: number;
  allocatedVotes: number;
  availableVotes: number;
  canAllocateVotes: boolean;
  contributionStatus?: string | undefined;
  winnerCharityId?: string | undefined;
  evidenceUrl?: string | undefined;
  serverTimestamp: string;
}

export interface CommunityVoteResult {
  accepted: boolean;
  duplicate: boolean;
  ballotId: string;
  charityId: string;
  charityAllocatedVotes: number;
  allocatedVotes: number;
  availableVotes: number;
  totalVotes: number;
  serverTimestamp: string;
}
