import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  configuredEnvironment,
  socialConfigurationFromEnvironment,
  type RevenueCatEnvironment,
} from './config.js';
import { DomainError } from './domain.js';
import { sha256 } from './security.js';
import type { SocialRepository } from './social-repository.js';
import type {
  FriendRequestPage,
  FriendRequestStatus,
  FriendRequestView,
  FriendsLeaderboard,
  FriendView,
  SocialProfile,
} from './social-types.js';

export interface SocialTableNames {
  profile: string;
  usernameReservation: string;
  request: string;
  connection: string;
  pointEvent: string;
}

const requiredEnvironmentVariable = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is not configured`);
  return value;
};

export function socialTableNamesFromEnvironment(): SocialTableNames {
  return {
    profile: requiredEnvironmentVariable('USER_PROFILE_TABLE_NAME'),
    usernameReservation: requiredEnvironmentVariable('USERNAME_RESERVATION_TABLE_NAME'),
    request: requiredEnvironmentVariable('FRIEND_REQUEST_TABLE_NAME'),
    connection: requiredEnvironmentVariable('FRIEND_CONNECTION_TABLE_NAME'),
    pointEvent: requiredEnvironmentVariable('DISCIPOINT_EARN_EVENT_TABLE_NAME'),
  };
}

const userEnvironment = (userId: string, environment: RevenueCatEnvironment): string =>
  `${userId}:${environment}`;
const requestId = (
  requesterId: string,
  recipientId: string,
  environment: RevenueCatEnvironment,
): string => sha256(`friend-request:${requesterId}:${recipientId}:${environment}`);
const connectionId = (
  userId: string,
  friendId: string,
  environment: RevenueCatEnvironment,
): string => sha256(`friend-connection:${userId}:${friendId}:${environment}`);

export function normalizeUsername(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9_]{3,20}$/.test(normalized) ? normalized : undefined;
}

const isConditionalFailure = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === 'ConditionalCheckFailedException' ||
    error.name === 'TransactionCanceledException');

const profileName = (profile: Record<string, unknown> | undefined): string => {
  const value = typeof profile?.displayName === 'string' ? profile.displayName.trim() : '';
  return value.length > 0 ? value : 'SnoozeFine member';
};

const requestView = (
  item: Record<string, unknown>,
  direction: 'INCOMING' | 'OUTGOING',
  now: string,
): FriendRequestView => ({
  requestId: String(item.id),
  status: item.status as FriendRequestStatus,
  direction,
  counterpartUsername: String(
    direction === 'INCOMING' ? item.requesterUsername : item.recipientUsername,
  ),
  counterpartDisplayName: String(
    direction === 'INCOMING' ? item.requesterDisplayName : item.recipientDisplayName,
  ),
  createdAt: String(item.createdAt),
  updatedAt: String(item.updatedAt),
  serverTimestamp: now,
});

const monthWindow = (now: string): { period: string; start: string; end: string } => {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new DomainError('INVALID_TIMESTAMP');
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return {
    period: start.toISOString().slice(0, 7),
    start: start.toISOString(),
    end: end.toISOString(),
  };
};

export class DynamoSocialRepository implements SocialRepository {
  private readonly client: DynamoDBDocumentClient;

  public constructor(
    private readonly tables: SocialTableNames,
    private readonly environment: RevenueCatEnvironment = configuredEnvironment(),
    client?: DynamoDBDocumentClient,
  ) {
    this.client =
      client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      });
  }

  public async socialProfile(userId: string, now: string): Promise<SocialProfile> {
    const profile = await this.item(this.tables.profile, userId);
    const username = typeof profile?.username === 'string' ? profile.username : undefined;
    return {
      usernameRequired: username === undefined,
      username,
      displayName: profileName(profile),
      serverTimestamp: now,
    };
  }

  public async setUsername(
    userId: string,
    username: string,
    now: string,
  ): Promise<{ username: string; duplicate: boolean; serverTimestamp: string }> {
    const normalized = normalizeUsername(username);
    if (normalized === undefined) throw new DomainError('INVALID_USERNAME');
    const existingProfile = await this.item(this.tables.profile, userId);
    if (typeof existingProfile?.username === 'string') {
      if (existingProfile.username === normalized)
        return { username: normalized, duplicate: true, serverTimestamp: now };
      throw new DomainError('USERNAME_ALREADY_SET');
    }
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tables.usernameReservation,
                Item: { id: normalized, userId, createdAt: now },
                ConditionExpression: 'attribute_not_exists(id)',
              },
            },
            {
              Update: {
                TableName: this.tables.profile,
                Key: { id: userId },
                UpdateExpression: 'SET username = :username, updatedAt = :now',
                ConditionExpression: 'attribute_not_exists(username)',
                ExpressionAttributeValues: { ':username': normalized, ':now': now },
              },
            },
          ],
        }),
      );
      return { username: normalized, duplicate: false, serverTimestamp: now };
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const [reservation, profile] = await Promise.all([
        this.item(this.tables.usernameReservation, normalized),
        this.item(this.tables.profile, userId),
      ]);
      if (reservation?.userId === userId && profile?.username === normalized) {
        return { username: normalized, duplicate: true, serverTimestamp: now };
      }
      if (reservation !== undefined) throw new DomainError('USERNAME_TAKEN');
      throw new DomainError('USERNAME_ALREADY_SET');
    }
  }

  public async sendFriendRequest(
    userId: string,
    username: string,
    now: string,
  ): Promise<{
    sent: boolean;
    request: FriendRequestView | undefined;
    duplicate: boolean;
    serverTimestamp: string;
  }> {
    const normalized = normalizeUsername(username);
    // Intentionally generic: clients cannot distinguish malformed from absent targets.
    if (normalized === undefined)
      return { sent: false, request: undefined, duplicate: false, serverTimestamp: now };
    const recipient = await this.item(this.tables.usernameReservation, normalized);
    if (recipient === undefined || typeof recipient.userId !== 'string') {
      return { sent: false, request: undefined, duplicate: false, serverTimestamp: now };
    }
    const recipientId = recipient.userId;
    if (recipientId === userId) throw new DomainError('CANNOT_REQUEST_SELF');
    const [outgoing, incoming, connection, requesterProfile, recipientProfile] = await Promise.all([
      this.requestsFor(userId, 'OUTGOING'),
      this.requestsFor(userId, 'INCOMING'),
      this.item(this.tables.connection, connectionId(userId, recipientId, this.environment)),
      this.item(this.tables.profile, userId),
      this.item(this.tables.profile, recipientId),
    ]);
    if (connection !== undefined) throw new DomainError('ALREADY_FRIENDS');
    const existingOutgoing = outgoing.find(
      (request) => request.recipientUserId === recipientId && request.status === 'PENDING',
    );
    if (existingOutgoing !== undefined) {
      return {
        sent: true,
        request: requestView(existingOutgoing, 'OUTGOING', now),
        duplicate: true,
        serverTimestamp: now,
      };
    }
    if (
      incoming.some(
        (request) => request.requesterUserId === recipientId && request.status === 'PENDING',
      )
    ) {
      throw new DomainError('INCOMING_REQUEST_ALREADY_PENDING');
    }
    const active = outgoing.filter((request) => request.status === 'PENDING').length;
    if (active >= socialConfigurationFromEnvironment().maxActiveOutgoingRequests) {
      throw new DomainError('FRIEND_REQUEST_LIMIT_REACHED');
    }
    const id = requestId(userId, recipientId, this.environment);
    const prior = await this.item(this.tables.request, id);
    const record = {
      id,
      requesterUserId: userId,
      recipientUserId: recipientId,
      requesterUsername: String(requesterProfile?.username ?? ''),
      requesterDisplayName: profileName(requesterProfile),
      recipientUsername: String(recipientProfile?.username ?? normalized),
      recipientDisplayName: profileName(recipientProfile),
      environment: this.environment,
      requesterEnvironment: userEnvironment(userId, this.environment),
      recipientEnvironment: userEnvironment(recipientId, this.environment),
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tables.request,
          Item: record,
          ConditionExpression:
            prior === undefined ? 'attribute_not_exists(id)' : '#status <> :pending',
          ExpressionAttributeNames: prior === undefined ? undefined : { '#status': 'status' },
          ExpressionAttributeValues: prior === undefined ? undefined : { ':pending': 'PENDING' },
        }),
      );
      return {
        sent: true,
        request: requestView(record, 'OUTGOING', now),
        duplicate: false,
        serverTimestamp: now,
      };
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const current = await this.item(this.tables.request, id);
      if (current?.requesterUserId === userId && current.status === 'PENDING') {
        return {
          sent: true,
          request: requestView(current, 'OUTGOING', now),
          duplicate: true,
          serverTimestamp: now,
        };
      }
      throw new DomainError('FRIEND_REQUEST_CONFLICT');
    }
  }

  public async listFriendRequests(
    userId: string,
    now: string,
  ): Promise<FriendRequestPage & { serverTimestamp: string }> {
    const [incoming, outgoing] = await Promise.all([
      this.requestsFor(userId, 'INCOMING'),
      this.requestsFor(userId, 'OUTGOING'),
    ]);
    return {
      incoming: incoming.map((request) => requestView(request, 'INCOMING', now)),
      outgoing: outgoing.map((request) => requestView(request, 'OUTGOING', now)),
      serverTimestamp: now,
    };
  }

  public async acceptFriendRequest(userId: string, id: string, now: string) {
    const request = await this.item(this.tables.request, id);
    if (request?.recipientUserId !== userId || request.environment !== this.environment) {
      throw new DomainError('FRIEND_REQUEST_NOT_FOUND');
    }
    const requesterId = String(request.requesterUserId);
    const friend = await this.friendView(userId, requesterId, now);
    if (request.status === 'ACCEPTED')
      return { accepted: true, duplicate: true, friend, serverTimestamp: now };
    if (request.status !== 'PENDING') throw new DomainError('FRIEND_REQUEST_NOT_PENDING');
    const ownConnection = this.connectionRecord(userId, requesterId, now);
    const otherConnection = this.connectionRecord(requesterId, userId, now);
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tables.request,
                Key: { id },
                UpdateExpression: 'SET #status = :accepted, acceptedAt = :now, updatedAt = :now',
                ConditionExpression: '#status = :pending AND recipientUserId = :userId',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':accepted': 'ACCEPTED',
                  ':pending': 'PENDING',
                  ':userId': userId,
                  ':now': now,
                },
              },
            },
            {
              Put: {
                TableName: this.tables.connection,
                Item: ownConnection,
                ConditionExpression: 'attribute_not_exists(id)',
              },
            },
            {
              Put: {
                TableName: this.tables.connection,
                Item: otherConnection,
                ConditionExpression: 'attribute_not_exists(id)',
              },
            },
          ],
        }),
      );
      return { accepted: true, duplicate: false, friend, serverTimestamp: now };
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const refreshed = await this.item(this.tables.request, id);
      if (refreshed?.recipientUserId === userId && refreshed.status === 'ACCEPTED') {
        return {
          accepted: true,
          duplicate: true,
          friend: await this.friendView(userId, requesterId, now),
          serverTimestamp: now,
        };
      }
      if ((await this.item(this.tables.connection, String(ownConnection.id))) !== undefined) {
        throw new DomainError('ALREADY_FRIENDS');
      }
      throw new DomainError('FRIEND_REQUEST_CONFLICT');
    }
  }

  public async declineFriendRequest(
    userId: string,
    id: string,
    now: string,
  ): Promise<FriendRequestView> {
    return this.transitionRequest(userId, id, 'INCOMING', 'DECLINED', now);
  }

  public async cancelFriendRequest(
    userId: string,
    id: string,
    now: string,
  ): Promise<FriendRequestView> {
    return this.transitionRequest(userId, id, 'OUTGOING', 'CANCELLED', now);
  }

  public async listFriends(userId: string): Promise<FriendView[]> {
    const connections = await this.connectionsFor(userId);
    return Promise.all(
      connections.map((connection) =>
        this.friendView(
          userId,
          String(connection.friendUserId),
          String(connection.createdAt),
          String(connection.id),
        ),
      ),
    );
  }

  public async removeFriend(
    userId: string,
    friendId: string,
    now: string,
  ): Promise<{ removed: boolean; serverTimestamp: string }> {
    const connection = await this.item(this.tables.connection, friendId);
    if (connection?.userId !== userId || connection.environment !== this.environment)
      return { removed: false, serverTimestamp: now };
    const friendUserId = String(connection.friendUserId);
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: this.tables.connection,
              Key: { id: friendId },
              ConditionExpression: 'userId = :userId',
              ExpressionAttributeValues: { ':userId': userId },
            },
          },
          {
            Delete: {
              TableName: this.tables.connection,
              Key: { id: connectionId(friendUserId, userId, this.environment) },
            },
          },
        ],
      }),
    );
    return { removed: true, serverTimestamp: now };
  }

  public async friendsLeaderboard(userId: string, now: string): Promise<FriendsLeaderboard> {
    const period = monthWindow(now);
    const friends = await this.listFriends(userId);
    const profile = await this.item(this.tables.profile, userId);
    const users = [
      {
        userId,
        friendId: undefined as string | undefined,
        username: String(profile?.username ?? ''),
        displayName: profileName(profile),
        isCurrentUser: true,
      },
      ...friends.map((friend) => ({
        userId: '',
        friendId: friend.friendId,
        username: friend.username,
        displayName: friend.displayName,
        isCurrentUser: false,
      })),
    ];
    const friendConnections = await this.connectionsFor(userId);
    for (const entry of users) {
      if (!entry.isCurrentUser)
        entry.userId = String(
          friendConnections.find((connection) => String(connection.id) === entry.friendId)
            ?.friendUserId ?? '',
        );
    }
    const totals = await Promise.all(
      users.map((entry) => this.monthlyEarnedPoints(entry.userId, period.start, period.end)),
    );
    const entries = users
      .map((entry, index) => ({ ...entry, currentMonthPoints: totals[index] ?? 0 }))
      .sort(
        (left, right) =>
          right.currentMonthPoints - left.currentMonthPoints ||
          left.username.localeCompare(right.username),
      );
    return {
      period: period.period,
      periodStart: period.start,
      periodEnd: period.end,
      entries: entries.map((entry, index) => ({
        friendId: entry.friendId,
        username: entry.username,
        displayName: entry.displayName,
        currentMonthPoints: entry.currentMonthPoints,
        rank: index + 1,
        isCurrentUser: entry.isCurrentUser,
      })),
      serverTimestamp: now,
    };
  }

  private async transitionRequest(
    userId: string,
    id: string,
    direction: 'INCOMING' | 'OUTGOING',
    status: 'DECLINED' | 'CANCELLED',
    now: string,
  ): Promise<FriendRequestView> {
    const request = await this.item(this.tables.request, id);
    const participant =
      direction === 'INCOMING' ? request?.recipientUserId : request?.requesterUserId;
    if (participant !== userId || request?.environment !== this.environment)
      throw new DomainError('FRIEND_REQUEST_NOT_FOUND');
    if (request.status === status) return requestView(request, direction, now);
    if (request.status !== 'PENDING') throw new DomainError('FRIEND_REQUEST_NOT_PENDING');
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tables.request,
          Key: { id },
          UpdateExpression: 'SET #status = :status, updatedAt = :now',
          ConditionExpression: '#status = :pending',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':status': status, ':pending': 'PENDING', ':now': now },
        }),
      );
      return { ...requestView(request, direction, now), status, updatedAt: now };
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const current = await this.item(this.tables.request, id);
      if (current !== undefined && current.status === status)
        return requestView(current, direction, now);
      throw new DomainError('FRIEND_REQUEST_CONFLICT');
    }
  }

  private connectionRecord(
    userId: string,
    friendUserId: string,
    now: string,
  ): Record<string, unknown> {
    return {
      id: connectionId(userId, friendUserId, this.environment),
      userId,
      friendUserId,
      environment: this.environment,
      userEnvironment: userEnvironment(userId, this.environment),
      createdAt: now,
    };
  }

  private async friendView(
    userId: string,
    friendUserId: string,
    friendsSince: string,
    id = connectionId(userId, friendUserId, this.environment),
  ): Promise<FriendView> {
    const profile = await this.item(this.tables.profile, friendUserId);
    const username = typeof profile?.username === 'string' ? profile.username : undefined;
    if (username === undefined) throw new DomainError('FRIEND_PROFILE_UNAVAILABLE');
    return { friendId: id, username, displayName: profileName(profile), friendsSince };
  }

  private async requestsFor(
    userId: string,
    direction: 'INCOMING' | 'OUTGOING',
  ): Promise<Record<string, unknown>[]> {
    const index =
      direction === 'INCOMING'
        ? 'byRecipientEnvironmentAndUpdatedAt'
        : 'byRequesterEnvironmentAndUpdatedAt';
    const attribute = direction === 'INCOMING' ? 'recipientEnvironment' : 'requesterEnvironment';
    return this.queryAll(
      this.tables.request,
      index,
      attribute,
      userEnvironment(userId, this.environment),
    );
  }

  private async connectionsFor(userId: string): Promise<Record<string, unknown>[]> {
    return this.queryAll(
      this.tables.connection,
      'byUserEnvironmentAndCreatedAt',
      'userEnvironment',
      userEnvironment(userId, this.environment),
    );
  }

  private async monthlyEarnedPoints(userId: string, start: string, end: string): Promise<number> {
    if (userId.length === 0) return 0;
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tables.pointEvent,
        IndexName: 'byUserEnvironmentAndCreatedAt',
        KeyConditionExpression:
          'userEnvironment = :userEnvironment AND createdAt >= :start AND createdAt < :end',
        ExpressionAttributeValues: {
          ':userEnvironment': userEnvironment(userId, this.environment),
          ':start': start,
          ':end': end,
        },
      }),
    );
    return (response.Items ?? []).reduce(
      (sum, item) => sum + Math.max(0, Number(item.pointsEarned ?? 0)),
      0,
    );
  }

  private async queryAll(
    tableName: string,
    indexName: string,
    key: string,
    value: string,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: indexName,
          KeyConditionExpression: `${key} = :value`,
          ExpressionAttributeValues: { ':value': value },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      items.push(...(result.Items ?? []));
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return items;
  }

  private async item(tableName: string, id: string): Promise<Record<string, unknown> | undefined> {
    return (
      await this.client.send(
        new GetCommand({ TableName: tableName, Key: { id }, ConsistentRead: true }),
      )
    ).Item;
  }
}
