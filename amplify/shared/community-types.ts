export interface CommunityCharity {
  id: string;
  name: string;
  summary: string;
  websiteUrl?: string | undefined;
  impactLabel?: string | undefined;
  votes: number;
  votePercentage: number;
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
  myVoteCharityId?: string | undefined;
  canVoteToday: boolean;
  winnerCharityId?: string | undefined;
  donationStatus?: string | undefined;
  projectedDonationMicroUsd?: string | undefined;
  expectedDonationMicroUsd?: string | undefined;
  paidDonationMicroUsd?: string | undefined;
  evidenceUrl?: string | undefined;
  serverTimestamp: string;
}

export interface CommunityVoteResult {
  accepted: boolean;
  duplicate: boolean;
  charityId: string;
  localVoteDate: string;
  totalVotes: number;
  serverTimestamp: string;
}
