import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { RevenueCatEnvironment } from './config.js';
import type { CommunityRepository } from './community-repository.js';
import type {
  CommunityCharity,
  CommunityDashboard,
  CommunityVoteResult,
} from './community-types.js';
import { DomainError } from './domain.js';
import { sha256 } from './security.js';

export interface CommunityTableNames {
  charity: string;
  ballot: string;
  allocation: string;
  contribution: string;
  profile: string;
  pointAccount: string;
}

const requiredEnvironmentVariable = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is not configured`);
  return value;
};

export function communityTableNamesFromEnvironment(): CommunityTableNames {
  return {
    charity: requiredEnvironmentVariable('CHARITY_TABLE_NAME'),
    ballot: requiredEnvironmentVariable('COMMUNITY_BALLOT_TABLE_NAME'),
    allocation: requiredEnvironmentVariable('CHARITY_BALLOT_ALLOCATION_TABLE_NAME'),
    contribution: requiredEnvironmentVariable('COMPANY_CONTRIBUTION_TABLE_NAME'),
    profile: requiredEnvironmentVariable('USER_PROFILE_TABLE_NAME'),
    pointAccount: requiredEnvironmentVariable('DISCIPOINT_ACCOUNT_TABLE_NAME'),
  };
}

interface BallotItem extends Record<string, unknown> {
  id: string;
  month: string;
  environment: RevenueCatEnvironment;
  environmentStatus: string;
  status: 'OPEN' | 'CLOSED';
  opensAt: string;
  closesAt: string;
  charityIds: string[];
  tallies: Record<string, number>;
  totalVotes: number;
  winnerCharityId?: string | undefined;
  companyContributionId?: string | undefined;
  totalAllocatedPoints: number;
}

const asBallot = (item: Record<string, unknown>): BallotItem => ({
  ...item,
  id: String(item.id),
  month: String(item.month),
  environment: item.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
  environmentStatus: String(item.environmentStatus),
  status: item.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
  opensAt: String(item.opensAt),
  closesAt: String(item.closesAt),
  charityIds: Array.isArray(item.charityIds) ? item.charityIds.map(String) : [],
  tallies:
    typeof item.tallies === 'object' && item.tallies !== null
      ? Object.fromEntries(Object.entries(item.tallies).map(([key, value]) => [key, Number(value)]))
      : {},
  totalVotes: Number(item.totalVotes),
  winnerCharityId: typeof item.winnerCharityId === 'string' ? item.winnerCharityId : undefined,
  companyContributionId:
    typeof item.companyContributionId === 'string' ? item.companyContributionId : undefined,
  totalAllocatedPoints: Number(item.totalAllocatedPoints ?? item.totalVotes ?? 0),
});

const allocationId = (userId: string, ballotId: string, environment: RevenueCatEnvironment): string =>
  sha256(`charity-ballot-allocation:${userId}:${environment}:${ballotId}`);

const percentageFor = (votes: number, totalVotes: number): number =>
  totalVotes > 0 ? (votes / totalVotes) * 100 : 0;

export class DynamoCommunityRepository implements CommunityRepository {
  private readonly client: DynamoDBDocumentClient;

  public constructor(
    private readonly tables: CommunityTableNames,
    private readonly environment: RevenueCatEnvironment,
    client?: DynamoDBDocumentClient,
  ) {
    this.client =
      client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      });
  }

  public async dashboard(userId: string, now: string): Promise<CommunityDashboard> {
    const ballot = await this.currentBallot(now);
    if (ballot === undefined) {
      return {
        status: 'NOT_PUBLISHED',
        charities: [],
        totalVotes: 0,
        earnedVotes: 0,
        allocatedVotes: 0,
        availableVotes: 0,
        canAllocateVotes: false,
        serverTimestamp: now,
      };
    }
    const account = await this.item(this.tables.pointAccount, `${userId}:${this.environment}`);
    const currentPoints = Math.max(0, Number(account?.currentPoints ?? 0));
    const allocation = await this.item(
      this.tables.allocation,
      allocationId(userId, ballot.id, this.environment),
    );
    const pointsAllocated = Math.max(0, Number(allocation?.pointsAllocated ?? 0));
    const charities: CommunityCharity[] = [];
    for (const charityId of ballot.charityIds) {
      const item = await this.item(this.tables.charity, charityId);
      if (item === undefined || item.active !== true) continue;
      charities.push({
        id: charityId,
        name: String(item.name),
        summary: String(item.summary),
        websiteUrl: typeof item.websiteUrl === 'string' ? item.websiteUrl : undefined,
        impactLabel: typeof item.impactLabel === 'string' ? item.impactLabel : undefined,
        votes: ballot.tallies[charityId] ?? 0,
        votePercentage: percentageFor(ballot.tallies[charityId] ?? 0, ballot.totalVotes),
        myAllocatedVotes: allocation?.charityId === charityId ? pointsAllocated : 0,
      });
    }
    const contribution =
      ballot.companyContributionId === undefined
        ? undefined
        : await this.item(this.tables.contribution, ballot.companyContributionId);
    const isOpen = ballot.status === 'OPEN' && ballot.opensAt <= now && ballot.closesAt > now;
    return {
      ballotId: ballot.id,
      month: ballot.month,
      status: isOpen ? 'OPEN' : 'CLOSED',
      opensAt: ballot.opensAt,
      closesAt: ballot.closesAt,
      charities,
      totalVotes: ballot.totalVotes,
      earnedVotes: currentPoints,
      allocatedVotes: pointsAllocated,
      availableVotes: Math.max(0, currentPoints - pointsAllocated),
      canAllocateVotes: isOpen && currentPoints > pointsAllocated,
      winnerCharityId: ballot.winnerCharityId,
      contributionStatus:
        typeof contribution?.status === 'string' ? contribution.status : undefined,
      evidenceUrl: typeof contribution?.evidenceUrl === 'string' ? contribution.evidenceUrl : undefined,
      serverTimestamp: now,
    };
  }

  public async allocatePoints(
    userId: string,
    charityId: string,
    now: string,
  ): Promise<CommunityVoteResult> {
    const ballot = await this.currentBallot(now);
    if (
      ballot === undefined ||
      ballot.status !== 'OPEN' ||
      ballot.opensAt > now ||
      ballot.closesAt <= now
    ) {
      throw new DomainError('VOTING_CLOSED');
    }
    if (!ballot.charityIds.includes(charityId)) throw new DomainError('CHARITY_NOT_ON_BALLOT');
    if (ballot.tallies[charityId] === undefined) {
      throw new DomainError('BALLOT_TALLY_NOT_INITIALIZED');
    }
    const account = await this.item(this.tables.pointAccount, `${userId}:${this.environment}`);
    const currentPoints = Math.max(0, Number(account?.currentPoints ?? 0));
    const id = allocationId(userId, ballot.id, this.environment);
    const prior = await this.item(this.tables.allocation, id);
    if (prior !== undefined && prior.charityId !== charityId) {
      throw new DomainError('CHARITY_ALLOCATION_LOCKED');
    }
    const previousPoints = Math.max(0, Number(prior?.pointsAllocated ?? 0));
    const newlyAllocatedPoints = Math.max(0, currentPoints - previousPoints);
    if (newlyAllocatedPoints === 0) {
      return {
        accepted: true,
        duplicate: true,
        charityId,
        ballotId: ballot.id,
        charityAllocatedVotes: previousPoints,
        allocatedVotes: previousPoints,
        availableVotes: 0,
        totalVotes: ballot.totalAllocatedPoints,
        serverTimestamp: now,
      };
    }
    const allocation = {
      id,
      userId,
      environment: this.environment,
      ballotId: ballot.id,
      charityId,
      userEnvironmentBallot: `${userId}:${this.environment}:${ballot.id}`,
      pointsAllocated: currentPoints,
      version: Number(prior?.version ?? 0) + 1,
      createdAt: typeof prior?.createdAt === 'string' ? prior.createdAt : now,
      updatedAt: now,
    };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tables.allocation,
                Item: allocation,
                ConditionExpression:
                  prior === undefined
                    ? 'attribute_not_exists(id)'
                    : '#allocationVersion = :allocationVersion AND charityId = :charityId',
                ExpressionAttributeNames:
                  prior === undefined ? undefined : { '#allocationVersion': 'version' },
                ExpressionAttributeValues:
                  prior === undefined
                    ? undefined
                    : { ':allocationVersion': Number(prior.version), ':charityId': charityId },
              },
            },
            {
              Update: {
                TableName: this.tables.ballot,
                Key: { id: ballot.id },
                UpdateExpression:
                  'SET totalVotes = totalVotes + :points, totalAllocatedPoints = if_not_exists(totalAllocatedPoints, totalVotes) + :points, #tallies.#charity = #tallies.#charity + :points, #version = #version + :one, updatedAt = :now',
                ConditionExpression:
                  '#status = :open AND opensAt <= :now AND closesAt > :now AND contains(charityIds, :charityId)',
                ExpressionAttributeNames: {
                  '#tallies': 'tallies',
                  '#charity': charityId,
                  '#version': 'version',
                  '#status': 'status',
                },
                ExpressionAttributeValues: {
                  ':one': 1,
                  ':points': newlyAllocatedPoints,
                  ':now': now,
                  ':open': 'OPEN',
                  ':charityId': charityId,
                },
              },
            },
          ],
        }),
      );
      return {
        accepted: true,
        duplicate: false,
        charityId,
        ballotId: ballot.id,
        charityAllocatedVotes: currentPoints,
        allocatedVotes: currentPoints,
        availableVotes: 0,
        totalVotes: ballot.totalAllocatedPoints + newlyAllocatedPoints,
        serverTimestamp: now,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'TransactionCanceledException') {
        const concurrentAllocation = await this.item(this.tables.allocation, id);
        if (concurrentAllocation !== undefined) {
          if (concurrentAllocation.charityId !== charityId) {
            throw new DomainError('CHARITY_ALLOCATION_LOCKED');
          }
          const refreshedBallot = await this.currentBallot(now);
          return {
            accepted: true,
            duplicate: true,
            charityId,
            ballotId: ballot.id,
            charityAllocatedVotes: Number(concurrentAllocation.pointsAllocated ?? 0),
            allocatedVotes: Number(concurrentAllocation.pointsAllocated ?? 0),
            availableVotes: 0,
            totalVotes: refreshedBallot?.totalAllocatedPoints ?? ballot.totalAllocatedPoints,
            serverTimestamp: now,
          };
        }

        const refreshedBallot = await this.currentBallot(now);
        if (
          refreshedBallot === undefined ||
          refreshedBallot.id !== ballot.id ||
          refreshedBallot.status !== 'OPEN' ||
          refreshedBallot.opensAt > now ||
          refreshedBallot.closesAt <= now
        ) {
          throw new DomainError('VOTING_CLOSED');
        }
        throw new DomainError('VOTE_CONFLICT');
      }
      throw error;
    }
  }

  private async currentBallot(now: string): Promise<BallotItem | undefined> {
    for (const status of ['OPEN', 'CLOSED']) {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tables.ballot,
          IndexName: 'byEnvironmentStatusAndClosesAt',
          KeyConditionExpression: 'environmentStatus = :value',
          ExpressionAttributeValues: { ':value': `${this.environment}:${status}` },
          ScanIndexForward: false,
          Limit: 1,
        }),
      );
      const item = result.Items?.[0];
      if (item !== undefined) {
        const ballot = asBallot(item);
        if (status === 'OPEN' || ballot.closesAt <= now) return ballot;
      }
    }
    return undefined;
  }

  private async item(tableName: string, id: string): Promise<Record<string, unknown> | undefined> {
    return (await this.client.send(new GetCommand({ TableName: tableName, Key: { id } }))).Item;
  }
}
