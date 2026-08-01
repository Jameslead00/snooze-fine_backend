import type { AppSyncIdentityCognito } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import {
  handleRequestAccountDeletionEvent,
  type AccountDeletionRequestWriter,
} from '../amplify/functions/request-account-deletion/handler.js';

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
