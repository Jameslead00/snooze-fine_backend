export type FriendRequestStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED';

export interface SocialProfile {
  usernameRequired: boolean;
  username: string | undefined;
  displayName: string;
  serverTimestamp: string;
}

export interface FriendRequestView {
  requestId: string;
  status: FriendRequestStatus;
  direction: 'INCOMING' | 'OUTGOING';
  counterpartUsername: string;
  counterpartDisplayName: string;
  createdAt: string;
  updatedAt: string;
  serverTimestamp: string;
}

export interface FriendRequestPage {
  incoming: FriendRequestView[];
  outgoing: FriendRequestView[];
}

export interface FriendView {
  friendId: string;
  username: string;
  displayName: string;
  friendsSince: string;
}

export interface FriendsLeaderboard {
  period: string;
  periodStart: string;
  periodEnd: string;
  entries: Array<{
    friendId: string | undefined;
    username: string;
    displayName: string;
    currentMonthPoints: number;
    rank: number;
    isCurrentUser: boolean;
  }>;
  serverTimestamp: string;
}
