import type { AppSyncIdentityCognito } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import {
  handleRequestAccountDeletionEvent,
  type AccountDeletionRequestWriter,
} from '../amplify/functions/request-account-deletion/handler.js';
import {
  processAccountDeletions,
  type AccountDeletionRequestRecord,
  type AccountDeletionStore,
} from '../amplify/functions/process-account-deletion/handler.js';

const userId = 'delete-test-user';
const now = '2026-07-31T20:00:00.000Z';

const identity = (): AppSyncIdentityCognito => ({
  sub: userId,
  issuer: 'https://cognito-idp.eu-central-1.amazonaws.com/test-pool',
  username: userId,
  claims: { sub: userId },
  sourceIp: ['127.0.0.1'],
  defaultAuthStrategy: 'ALLOW',
  groups: null,
});

describe('account deletion request', () => {
  it('records an authenticated, explicitly confirmed request', async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const writer: AccountDeletionRequestWriter = { request };
    const result = await handleRequestAccountDeletionEvent(
      {
        fieldName: 'requestMyAccountDeletion',
        arguments: { confirmation: 'DELETE' },
        identity: identity(),
      },
      writer,
      now,
    );

    expect(request).toHaveBeenCalledWith(userId, now);
    expect(result).toEqual({ accepted: true, serverTimestamp: now });
  });

  it('rejects a request without the exact destructive confirmation', async () => {
    const request = vi.fn();
    const writer: AccountDeletionRequestWriter = { request };
    await expect(
      handleRequestAccountDeletionEvent(
        {
          fieldName: 'requestMyAccountDeletion',
          arguments: { confirmation: 'delete' },
          identity: identity(),
        },
        writer,
        now,
      ),
    ).rejects.toThrow('ACCOUNT_DELETION_CONFIRMATION_REQUIRED');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('account deletion processor', () => {
  it('removes server data and then clears the operational request', async () => {
    const request: AccountDeletionRequestRecord = {
      id: 'delete-test-user:PRODUCTION',
      userId,
      status: 'REQUESTED',
      attempts: 0,
      requestedAt: now,
      updatedAt: now,
    };
    const events: string[] = [];
    const fail = vi.fn();
    const store: AccountDeletionStore = {
      listCandidates: vi.fn().mockResolvedValue([request]),
      claim: vi.fn().mockImplementation(async () => {
        events.push('claim');
        return true;
      }),
      deleteUserData: vi.fn().mockImplementation(async () => {
        events.push('deleteData');
      }),
      complete: vi.fn().mockImplementation(async () => {
        events.push('complete');
      }),
      fail,
    };

    const result = await processAccountDeletions(store, now);

    expect(result).toEqual({ inspected: 1, completed: 1, failed: 0 });
    expect(events).toEqual(['claim', 'deleteData', 'complete']);
    expect(fail).not.toHaveBeenCalled();
  });

  it('requeues a request when cleanup fails without reporting completion', async () => {
    const request: AccountDeletionRequestRecord = {
      id: 'delete-test-user:PRODUCTION',
      userId,
      status: 'REQUESTED',
      attempts: 1,
      requestedAt: now,
      updatedAt: now,
    };
    const failure = new Error('DynamoDB unavailable');
    const complete = vi.fn();
    const fail = vi.fn().mockResolvedValue(undefined);
    const store: AccountDeletionStore = {
      listCandidates: vi.fn().mockResolvedValue([request]),
      claim: vi.fn().mockResolvedValue(true),
      deleteUserData: vi.fn().mockRejectedValue(failure),
      complete,
      fail,
    };

    const result = await processAccountDeletions(store, now);

    expect(result).toEqual({ inspected: 1, completed: 0, failed: 1 });
    expect(complete).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(request, now, failure);
  });
});
