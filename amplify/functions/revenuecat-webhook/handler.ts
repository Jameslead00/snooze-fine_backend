import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ZodError } from 'zod';
import { configuredEnvironment } from '../../shared/config.js';
import {
  DynamoPlatformRepository,
  tableNamesFromEnvironment,
} from '../../shared/dynamo-repository.js';
import { processRevenueCatEvent } from '../../shared/domain.js';
import { log } from '../../shared/logger.js';
import { constantTimeTokenMatches } from '../../shared/security.js';
import { parseRevenueCatPayload, PayloadTooLargeError } from '../../shared/validation.js';

const jsonResponse = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  },
  body: JSON.stringify(body),
});

export const handler: APIGatewayProxyHandlerV2 = async (request) => {
  const correlationId = request.requestContext.requestId;
  if (request.rawPath !== '/webhooks/revenuecat') {
    return jsonResponse(404, { error: 'not_found', correlationId });
  }
  if (request.requestContext.http.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed', correlationId });
  }

  const expectedToken = process.env.REVENUECAT_WEBHOOK_AUTH_TOKEN ?? '';
  const authorization = request.headers.authorization;
  if (!constantTimeTokenMatches(authorization, expectedToken)) {
    log('warn', 'revenuecat_webhook_unauthorized', { correlationId });
    return jsonResponse(401, { error: 'unauthorized', correlationId });
  }

  try {
    const rawBody =
      request.body === undefined
        ? ''
        : request.isBase64Encoded
          ? Buffer.from(request.body, 'base64').toString('utf8')
          : request.body;
    const event = parseRevenueCatPayload(rawBody, configuredEnvironment());
    const repository = new DynamoPlatformRepository(tableNamesFromEnvironment(), event.environment);
    const result = await processRevenueCatEvent(repository, event);
    log('info', 'revenuecat_webhook_processed', {
      correlationId,
      eventId: event.id,
      eventType: event.type,
      environment: event.environment,
      status: result.status,
      duplicate: result.duplicate,
      allocatedPoints: result.allocatedPoints,
    });
    return jsonResponse(200, {
      received: true,
      duplicate: result.duplicate,
      status: result.status,
      correlationId,
    });
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return jsonResponse(413, { error: 'payload_too_large', correlationId });
    }
    if (error instanceof ZodError) {
      log('warn', 'revenuecat_webhook_invalid_payload', {
        correlationId,
        validationIssues: error.issues
          .map((issue) => `${issue.path.map(String).join('.') || '<root>'}:${issue.code}`)
          .join(','),
      });
      return jsonResponse(400, { error: 'invalid_payload', correlationId });
    }
    if (error instanceof SyntaxError) {
      log('warn', 'revenuecat_webhook_invalid_json', { correlationId });
      return jsonResponse(400, { error: 'invalid_payload', correlationId });
    }
    log('error', 'revenuecat_webhook_failed', {
      correlationId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return jsonResponse(500, { error: 'processing_failed', correlationId });
  }
};
