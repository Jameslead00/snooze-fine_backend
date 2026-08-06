import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
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
    const id = `${userId}:${environment}`;
    const existing = await this.client.send(
      new GetCommand({ TableName: tableName, Key: { id }, ConsistentRead: true }),
    );
    const status = (existing.Item as Record<string, unknown> | undefined)?.status;
    if (status === 'REQUESTED' || status === 'PROCESSING' || status === 'COMPLETED') return;

    try {
      await this.client.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            id,
            userId,
            environment,
            status: 'REQUESTED',
            attempts: 0,
            requestedAt: now,
            updatedAt: now,
          },
          ConditionExpression: 'attribute_not_exists(id) OR #status = :failed',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':failed': 'FAILED' },
        }),
      );
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException')
        throw error;
      // Another authenticated request already queued or claimed the deletion.
    }
  }
}

export const handler = async (event: RequestAccountDeletionEvent): Promise<unknown> =>
  handleRequestAccountDeletionEvent(event, new DynamoAccountDeletionRequestWriter());
