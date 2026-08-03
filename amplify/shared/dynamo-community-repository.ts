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
import { localParts } from './habits.js';
import { sha256 } from './security.js';

export interface CommunityTableNames {
  charity: string;
  ballot: string;
  vote: string;
  donation: string;
  profile: string;
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
    vote: requiredEnvironmentVariable('DAILY_CHARITY_VOTE_TABLE_NAME'),
    donation: requiredEnvironmentVariable('DONATION_RECORD_TABLE_NAME'),
    profile: requiredEnvironmentVariable('USER_PROFILE_TABLE_NAME'),
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
  donationRecordId?: string | undefined;
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
  donationRecordId: typeof item.donationRecordId === 'string' ? item.donationRecordId : undefined,
});

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
        canVoteToday: false,
        serverTimestamp: now,
      };
    }
    const timezone = await this.timezone(userId);
    const localVoteDate = localParts(now, timezone).date;
    const voteId = sha256(`daily-vote:${userId}:${ballot.id}:${localVoteDate}`);
    const vote = await this.item(this.tables.vote, voteId);
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
      });
    }
    const donation =
      ballot.donationRecordId === undefined
        ? undefined
        : await this.item(this.tables.donation, ballot.donationRecordId);
    const isOpen = ballot.status === 'OPEN' && ballot.opensAt <= now && ballot.closesAt > now;
    return {
      ballotId: ballot.id,
      month: ballot.month,
      status: isOpen ? 'OPEN' : 'CLOSED',
      opensAt: ballot.opensAt,
      closesAt: ballot.closesAt,
      charities,
      totalVotes: ballot.totalVotes,
      myVoteCharityId: typeof vote?.charityId === 'string' ? vote.charityId : undefined,
      canVoteToday: isOpen && vote === undefined,
      winnerCharityId: ballot.winnerCharityId,
      donationStatus: typeof donation?.status === 'string' ? donation.status : undefined,
      expectedDonationMicroUsd:
        typeof donation?.expectedDonationMicroUsd === 'string'
          ? donation.expectedDonationMicroUsd
          : undefined,
      paidDonationMicroUsd:
        typeof donation?.paidDonationMicroUsd === 'string'
          ? donation.paidDonationMicroUsd
          : undefined,
      evidenceUrl: typeof donation?.evidenceUrl === 'string' ? donation.evidenceUrl : undefined,
      serverTimestamp: now,
    };
  }

  public async castVote(
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
    const timezone = await this.timezone(userId);
    const localVoteDate = localParts(now, timezone).date;
    const voteId = sha256(`daily-vote:${userId}:${ballot.id}:${localVoteDate}`);
    const prior = await this.item(this.tables.vote, voteId);
    if (prior !== undefined) {
      if (prior.charityId !== charityId) throw new DomainError('ALREADY_VOTED_TODAY');
      return {
        accepted: true,
        duplicate: true,
        charityId,
        localVoteDate,
        totalVotes: ballot.totalVotes,
        serverTimestamp: now,
      };
    }
    const vote = {
      id: voteId,
      userId,
      environment: this.environment,
      ballotId: ballot.id,
      charityId,
      localVoteDate,
      timezone,
      createdAt: now,
    };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tables.vote,
                Item: vote,
                ConditionExpression: 'attribute_not_exists(id)',
              },
            },
            {
              Update: {
                TableName: this.tables.ballot,
                Key: { id: ballot.id },
                UpdateExpression:
                  'SET totalVotes = totalVotes + :one, #tallies.#charity = #tallies.#charity + :one, #version = #version + :one, updatedAt = :now',
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
        localVoteDate,
        totalVotes: ballot.totalVotes + 1,
        serverTimestamp: now,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'TransactionCanceledException') {
        const concurrentVote = await this.item(this.tables.vote, voteId);
        if (concurrentVote !== undefined) {
          if (concurrentVote.charityId !== charityId) {
            throw new DomainError('ALREADY_VOTED_TODAY');
          }
          const refreshedBallot = await this.currentBallot(now);
          return {
            accepted: true,
            duplicate: true,
            charityId,
            localVoteDate,
            totalVotes: refreshedBallot?.totalVotes ?? ballot.totalVotes,
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

  private async timezone(userId: string): Promise<string> {
    const profile = await this.item(this.tables.profile, userId);
    return typeof profile?.timezone === 'string' ? profile.timezone : 'UTC';
  }

  private async item(tableName: string, id: string): Promise<Record<string, unknown> | undefined> {
    return (await this.client.send(new GetCommand({ TableName: tableName, Key: { id } }))).Item;
  }
}
