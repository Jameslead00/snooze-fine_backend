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
  allocation: 'CharityBallotAllocation',
  contribution: 'CompanyContribution',
  profile: 'UserProfile',
  pointAccount: 'DisciPointAccount',
};

class FakeDocumentClient {
  public readonly ballot = {
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
    totalAllocatedPoints: 0,
    version: 1,
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  public readonly allocations = new Map<string, Record<string, unknown>>();
  public currentPoints = 25;

  public async send(command: unknown): Promise<Record<string, unknown>> {
    if (command instanceof QueryCommand) return { Items: [this.ballot] };
    if (command instanceof GetCommand) {
      const input = command.input;
      const id = String(input.Key?.id);
      if (input.TableName === tables.profile) return { Item: { id, timezone: 'Europe/Zurich' } };
      if (input.TableName === tables.pointAccount) return { Item: { id, currentPoints: this.currentPoints } };
      if (input.TableName === tables.allocation) return { Item: this.allocations.get(id) };
      if (input.TableName === tables.charity) {
        return { Item: { id, name: id, summary: 'Approved charity', active: true } };
      }
      return {};
    }
    if (command instanceof TransactWriteCommand) {
      const allocation = command.input.TransactItems?.[0]?.Put?.Item as Record<string, unknown>;
      this.allocations.set(String(allocation.id), allocation);
      const charityId = String(allocation.charityId) as 'charity-a' | 'charity-b';
      const added = Number(allocation.pointsAllocated) - (this.ballot.tallies[charityId] ?? 0);
      this.ballot.tallies[charityId] += added;
      this.ballot.totalVotes += added;
      this.ballot.totalAllocatedPoints += added;
      return {};
    }
    throw new Error(`Unexpected command: ${String(command)}`);
  }
}

const repository = (client: FakeDocumentClient) =>
  new DynamoCommunityRepository(tables, 'SANDBOX', client as unknown as DynamoDBDocumentClient);

describe('community point allocation', () => {
  it('allocates earned points once without reducing the point account', async () => {
    const client = new FakeDocumentClient();
    const subject = repository(client);
    const first = await subject.allocatePoints('cognito-user', 'charity-a', '2026-07-31T20:00:00.000Z');
    const retry = await subject.allocatePoints('cognito-user', 'charity-a', '2026-07-31T20:30:00.000Z');

    expect(first).toMatchObject({ duplicate: false, pointsAllocated: 25, newlyAllocatedPoints: 25 });
    expect(retry).toMatchObject({ duplicate: true, newlyAllocatedPoints: 0 });
    expect(client.currentPoints).toBe(25);
    expect(client.ballot.totalAllocatedPoints).toBe(25);
  });

  it('makes newly earned points available to the existing charity allocation', async () => {
    const client = new FakeDocumentClient();
    const subject = repository(client);
    await subject.allocatePoints('cognito-user', 'charity-a', '2026-07-31T20:00:00.000Z');
    client.currentPoints = 40;
    const next = await subject.allocatePoints('cognito-user', 'charity-a', '2026-07-31T20:30:00.000Z');

    expect(next).toMatchObject({ pointsAllocated: 40, newlyAllocatedPoints: 15 });
    expect(client.currentPoints).toBe(40);
  });

  it('locks an allocation to its first charity for the active ballot', async () => {
    const client = new FakeDocumentClient();
    const subject = repository(client);
    await subject.allocatePoints('cognito-user', 'charity-a', '2026-07-31T20:00:00.000Z');
    await expect(
      subject.allocatePoints('cognito-user', 'charity-b', '2026-07-31T20:30:00.000Z'),
    ).rejects.toMatchObject({ code: 'CHARITY_ALLOCATION_LOCKED' });
  });
});
