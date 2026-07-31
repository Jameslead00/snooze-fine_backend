import type { AppSyncIdentity } from 'aws-lambda';
import { cognitoSub } from '../../shared/appsync.js';
import { configuredEnvironment } from '../../shared/config.js';
import {
  DynamoPlatformRepository,
  tableNamesFromEnvironment,
} from '../../shared/dynamo-repository.js';
import { DomainError } from '../../shared/domain.js';
import type { PlatformRepository } from '../../shared/repository.js';
import { listTransactionsArgumentsSchema } from '../../shared/validation.js';

export type AccountApiArguments = {
  limit?: unknown;
  nextToken?: unknown;
};

type AccountApiResult = Record<string, unknown>;

export type AccountApiEvent = {
  typeName?: string;
  fieldName: string;
  arguments: AccountApiArguments;
  identity: AppSyncIdentity | null;
  source?: unknown;
  request?: unknown;
  prev?: unknown;
};

export type AccountApiRepository = Pick<
  PlatformRepository,
  'getPointAccountView' | 'listPointTransactions'
>;

export async function handleAccountApiEvent(
  event: AccountApiEvent,
  repository: AccountApiRepository,
  now = new Date().toISOString(),
): Promise<AccountApiResult> {
  const userId = cognitoSub(event.identity);
  if (event.fieldName === 'getMyPointAccount') {
    const view = await repository.getPointAccountView(userId, now);
    return { ...view, donationMicroUsd: String(view.donationMicroUsd) };
  }
  if (event.fieldName === 'listMyPointTransactions') {
    const arguments_ = listTransactionsArgumentsSchema.parse(event.arguments);
    const page = await repository.listPointTransactions(
      userId,
      arguments_.limit ?? 50,
      arguments_.nextToken,
    );
    return {
      items: page.items.map((transaction) => ({
        id: transaction.id,
        pointPeriodId: transaction.pointPeriodId,
        amount: transaction.amount,
        transactionType: transaction.transactionType,
        reasonCode: transaction.reasonCode,
        source: transaction.source,
        sourceEventId: transaction.sourceEventId,
        relatedEventId: transaction.relatedEventId,
        balanceAfter: transaction.balanceAfter,
        createdAt: transaction.createdAt,
      })),
      nextToken: page.nextToken,
    };
  }
  throw new DomainError('UNSUPPORTED_OPERATION');
}

export const handler = async (event: AccountApiEvent): Promise<AccountApiResult> => {
  const repository = new DynamoPlatformRepository(
    tableNamesFromEnvironment(),
    configuredEnvironment(),
  );
  return handleAccountApiEvent(event, repository);
};
