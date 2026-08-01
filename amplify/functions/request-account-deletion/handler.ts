import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { AppSyncIdentity } from 'aws-lambda';
import { cognitoSub } from '../../shared/appsync.js';
import { configuredEnvironment } from '../../shared/config.js';
import { DomainError } from '../../shared/domain.js';

export type RequestAccountDeletionEvent = {
  fieldName: string;
  arguments: { confirmation?: unknown };
  identity: AppSyncIdentity | null;
};

export interface AccountDeletionRequestWriter {
  request(userId: string, now: string): Promise<void>;
}

export async function handleRequestAccountDeletionEvent(
  event: RequestAccountDeletionEvent,
  writer: AccountDeletionRequestWriter,
  now = new Date().toISOString(),
): Promise<unknown> {
  if (event.fieldName !== 'requestMyAccountDeletion') {
    throw new DomainError('UNSUPPORTED_OPERATION');
  }
  const userId = cognitoSub(event.identity);
  if (event.arguments.confirmation !== 'DELETE') {
    throw new DomainError('ACCOUNT_DELETION_CONFIRMATION_REQUIRED');
  }
  await writer.request(userId, now);
  return { accepted: true, serverTimestamp: now };
}

class DynamoAccountDeletionRequestWriter implements AccountDeletionRequestWriter {
  private readonly client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });

  public async request(userId: string, now: string): Promise<void> {
    const tableName = process.env.ACCOUNT_DELETION_REQUEST_TABLE_NAME;
    if (tableName === undefined || tableName.length === 0) {
      throw new Error('ACCOUNT_DELETION_REQUEST_TABLE_NAME is not configured');
    }
    const environment = configuredEnvironment();
    await this.client.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          id: `${userId}:${environment}`,
          userId,
          environment,
          status: 'REQUESTED',
          requestedAt: now,
          updatedAt: now,
        },
      }),
    );
  }
}

export const handler = async (event: RequestAccountDeletionEvent): Promise<unknown> =>
  handleRequestAccountDeletionEvent(event, new DynamoAccountDeletionRequestWriter());
