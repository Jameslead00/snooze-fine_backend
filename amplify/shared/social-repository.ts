import type {
  FriendRequestPage,
  FriendRequestView,
  FriendsLeaderboard,
  FriendView,
  SocialProfile,
} from './social-types.js';

export interface SocialRepository {
  socialProfile(userId: string, now: string): Promise<SocialProfile>;
  setUsername(
    userId: string,
    username: string,
    now: string,
  ): Promise<{ username: string; duplicate: boolean; serverTimestamp: string }>;
  sendFriendRequest(
    userId: string,
    username: string,
    now: string,
  ): Promise<{
    sent: boolean;
    request: FriendRequestView | undefined;
    duplicate: boolean;
    serverTimestamp: string;
  }>;
  listFriendRequests(
    userId: string,
    now: string,
  ): Promise<FriendRequestPage & { serverTimestamp: string }>;
  acceptFriendRequest(
    userId: string,
    requestId: string,
    now: string,
  ): Promise<{
    accepted: boolean;
    duplicate: boolean;
    friend: FriendView;
    serverTimestamp: string;
  }>;
  declineFriendRequest(userId: string, requestId: string, now: string): Promise<FriendRequestView>;
  cancelFriendRequest(userId: string, requestId: string, now: string): Promise<FriendRequestView>;
  listFriends(userId: string): Promise<FriendView[]>;
  removeFriend(
    userId: string,
    friendId: string,
    now: string,
  ): Promise<{ removed: boolean; serverTimestamp: string }>;
  friendsLeaderboard(userId: string, now: string): Promise<FriendsLeaderboard>;
}
