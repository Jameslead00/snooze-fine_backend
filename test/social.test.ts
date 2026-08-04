import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import {
  DynamoSocialRepository,
  type SocialTableNames,
} from '../amplify/shared/dynamo-social-repository.js';

const tables: SocialTableNames = {
  profile: 'UserProfile',
  usernameReservation: 'UsernameReservation',
  request: 'FriendRequest',
  connection: 'FriendConnection',
  pointEvent: 'DisciPointEarnEvent',
};

class UsernameClaimClient {
  public readonly profiles = new Map<string, Record<string, unknown>>();
  public readonly reservations = new Map<string, Record<string, unknown>>();

  public async send(command: unknown): Promise<Record<string, unknown>> {
    if (command instanceof GetCommand) {
      const table = command.input.TableName;
      const id = String(command.input.Key?.id);
      if (table === tables.profile) return { Item: this.profiles.get(id) };
      if (table === tables.usernameReservation) return { Item: this.reservations.get(id) };
      return {};
    }
    if (command instanceof TransactWriteCommand) {
      const items = command.input.TransactItems ?? [];
      const reservation = items.find((item) => item.Put?.TableName === tables.usernameReservation)
        ?.Put?.Item as Record<string, unknown> | undefined;
      const profileUpdate = items.find((item) => item.Update?.TableName === tables.profile)?.Update;
      if (reservation === undefined || profileUpdate === undefined)
        throw new Error('Unexpected transaction');
      const username = String(reservation.id);
      const userId = String(profileUpdate.Key?.id);
      if (this.reservations.has(username) || this.profiles.get(userId)?.username !== undefined) {
        const error = new Error('conditional');
        error.name = 'TransactionCanceledException';
        throw error;
      }
      this.reservations.set(username, reservation);
      this.profiles.set(userId, { id: userId, userId, username, displayName: userId });
      return {};
    }
    throw new Error('Unexpected command');
  }
}

const repository = (client: UsernameClaimClient) =>
  new DynamoSocialRepository(tables, 'SANDBOX', client as unknown as DynamoDBDocumentClient);

describe('private username social foundation', () => {
  it('atomically reserves the normalized username when simultaneous case variants claim it', async () => {
    const client = new UsernameClaimClient();
    const subject = repository(client);
    const claims = await Promise.allSettled([
      subject.setUsername('user-a', 'Alice_1', '2026-08-04T12:00:00.000Z'),
      subject.setUsername('user-b', 'alice_1', '2026-08-04T12:00:00.000Z'),
    ]);
    expect(claims.filter((claim) => claim.status === 'fulfilled')).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === 'rejected')).toHaveLength(1);
    expect(client.reservations.get('alice_1')?.userId).toMatch(/user-[ab]/);
    const rejected = claims.find((claim) => claim.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'USERNAME_TAKEN' } });
  });

  it('returns the same generic unsent outcome for malformed and unreserved request targets', async () => {
    const client = new UsernameClaimClient();
    const subject = repository(client);
    await expect(
      subject.sendFriendRequest('user-a', '!!!', '2026-08-04T12:00:00.000Z'),
    ).resolves.toEqual({
      sent: false,
      request: undefined,
      duplicate: false,
      serverTimestamp: '2026-08-04T12:00:00.000Z',
    });
    await expect(
      subject.sendFriendRequest('user-a', 'unknown_user', '2026-08-04T12:00:00.000Z'),
    ).resolves.toEqual({
      sent: false,
      request: undefined,
      duplicate: false,
      serverTimestamp: '2026-08-04T12:00:00.000Z',
    });
  });
});
