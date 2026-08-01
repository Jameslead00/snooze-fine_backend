import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import {
  DynamoCommunityRepository,
  type CommunityTableNames,
} from '../amplify/shared/dynamo-community-repository.js';

const tables: CommunityTableNames = {
  charity: 'Charity',
  ballot: 'CommunityBallot',
  vote: 'DailyCharityVote',
  donation: 'DonationRecord',
  profile: 'UserProfile',
};

const ballot = () => ({
  id: 'ballot-2026-08',
  month: '2026-08',
  environment: 'SANDBOX',
  environmentStatus: 'SANDBOX:OPEN',
  status: 'OPEN',
  opensAt: '2026-07-01T00:00:00.000Z',
  closesAt: '2026-09-01T00:00:00.000Z',
  charityIds: ['charity-a', 'charity-b'],
  tallies: { 'charity-a': 0, 'charity-b': 0 },
  totalVotes: 0,
  version: 1,
  updatedAt: '2026-07-01T00:00:00.000Z',
});

class FakeDocumentClient {
  public readonly ballot = ballot();
  public readonly votes = new Map<string, Record<string, unknown>>();
  public transactionCount = 0;
  public cancelNextAsConcurrentSuccess = false;

  public async send(command: unknown): Promise<Record<string, unknown>> {
    if (command instanceof QueryCommand) {
      return { Items: [this.ballot] };
    }
    if (command instanceof GetCommand) {
      const input = command.input;
      const id = String(input.Key?.id);
      if (input.TableName === tables.profile) {
        return { Item: { id, timezone: 'Europe/Zurich' } };
      }
      if (input.TableName === tables.vote) {
        return { Item: this.votes.get(id) };
      }
      if (input.TableName === tables.charity) {
        return {
          Item: {
            id,
            name: id === 'charity-a' ? 'Charity A' : 'Charity B',
            summary: 'Owner-approved sandbox charity',
            active: true,
          },
        };
      }
      return {};
    }
    if (command instanceof TransactWriteCommand) {
      this.transactionCount += 1;
      const put = command.input.TransactItems?.[0]?.Put;
      const vote = put?.Item as Record<string, unknown> | undefined;
      if (vote === undefined) throw new Error('Missing vote transaction item');

      if (this.cancelNextAsConcurrentSuccess) {
        this.cancelNextAsConcurrentSuccess = false;
        this.applyVote(vote);
        const error = new Error('Concurrent vote won the transaction');
        error.name = 'TransactionCanceledException';
        throw error;
      }

      if (this.votes.has(String(vote.id))) {
        const error = new Error('Duplicate vote');
        error.name = 'TransactionCanceledException';
        throw error;
      }
      this.applyVote(vote);
      return {};
    }
    throw new Error(`Unexpected command: ${String(command)}`);
  }

  private applyVote(vote: Record<string, unknown>): void {
    this.votes.set(String(vote.id), vote);
    const charityId = String(vote.charityId) as 'charity-a' | 'charity-b';
    this.ballot.tallies[charityId] += 1;
    this.ballot.totalVotes += 1;
    this.ballot.version += 1;
  }
}

function repository(client: FakeDocumentClient): DynamoCommunityRepository {
  return new DynamoCommunityRepository(
    tables,
    'SANDBOX',
    client as unknown as DynamoDBDocumentClient,
  );
}

describe('community voting accountability', () => {
  it('allows one vote per user-local day and safely deduplicates retries', async () => {
    const client = new FakeDocumentClient();
    const subject = repository(client);
    const first = await subject.castVote('cognito-user', 'charity-a', '2026-07-31T20:00:00.000Z');
    const retry = await subject.castVote('cognito-user', 'charity-a', '2026-07-31T20:30:00.000Z');

    expect(first).toMatchObject({ duplicate: false, localVoteDate: '2026-07-31' });
    expect(retry).toMatchObject({ duplicate: true, localVoteDate: '2026-07-31' });
    expect(client.ballot.totalVotes).toBe(1);
    expect(client.transactionCount).toBe(1);

    await expect(
      subject.castVote('cognito-user', 'charity-b', '2026-07-31T21:00:00.000Z'),
    ).rejects.toMatchObject({ code: 'ALREADY_VOTED_TODAY' });

    const nextDay = await subject.castVote('cognito-user', 'charity-b', '2026-07-31T22:30:00.000Z');
    expect(nextDay).toMatchObject({ duplicate: false, localVoteDate: '2026-08-01' });
    expect(client.ballot.totalVotes).toBe(2);
  });

  it('turns a concurrent same-vote transaction cancellation into one bounded duplicate result', async () => {
    const client = new FakeDocumentClient();
    client.cancelNextAsConcurrentSuccess = true;
    const result = await repository(client).castVote(
      'cognito-user',
      'charity-a',
      '2026-07-31T20:00:00.000Z',
    );

    expect(result).toMatchObject({ accepted: true, duplicate: true, totalVotes: 1 });
    expect(client.transactionCount).toBe(1);
    expect(client.ballot.totalVotes).toBe(1);
  });

  it('rejects a ballot whose close time has passed without writing a vote', async () => {
    const client = new FakeDocumentClient();
    client.ballot.closesAt = '2026-07-31T19:59:59.000Z';

    await expect(
      repository(client).castVote('cognito-user', 'charity-a', '2026-07-31T20:00:00.000Z'),
    ).rejects.toMatchObject({ code: 'VOTING_CLOSED' });
    expect(client.transactionCount).toBe(0);
  });
});
