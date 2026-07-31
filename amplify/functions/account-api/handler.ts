import type { AppSyncResolverHandler } from 'aws-lambda';
import { cognitoSub } from '../../shared/appsync.js';
import { configuredEnvironment } from '../../shared/config.js';
import {
  DynamoPlatformRepository,
  tableNamesFromEnvironment,
} from '../../shared/dynamo-repository.js';
import { DomainError } from '../../shared/domain.js';
import { listTransactionsArgumentsSchema } from '../../shared/validation.js';

type AccountApiArguments = {
  limit?: unknown;
  nextToken?: unknown;
};

type AccountApiResult = Record<string, unknown>;

export const handler: AppSyncResolverHandler<AccountApiArguments, AccountApiResult> = async (
  event,
) => {
  const userId = cognitoSub(event.identity);
  const repository = new DynamoPlatformRepository(
    tableNamesFromEnvironment(),
    configuredEnvironment(),
  );
  if (event.info.fieldName === 'getMyPointAccount') {
    const view = await repository.getPointAccountView(userId, new Date().toISOString());
    return { ...view, donationMicroUsd: String(view.donationMicroUsd) };
  }
  if (event.info.fieldName === 'listMyPointTransactions') {
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
};
