# Operations

All examples require a generated public `amplify_outputs.json`, the backend-only table mapping
described in `README.md`, short-lived AWS credentials for the target account, and an explicit
environment. Export `SNOOZEFINE_ADMIN_TABLES_PATH=./admin_tables.local.json` before using the
admin CLI. `SANDBOX` is the CLI default. Settlement mode is always `TEST`; no procedure in this
document transfers money.

## Fast health check

```bash
export AWS_PROFILE=<profile>
export AWS_REGION=eu-central-1
npm run admin:summary -- --environment SANDBOX
```

Expected footer:

```text
TEST MODE — EXPECTED DONATION ONLY — NO DONATION HAS BEEN PAID
```

## Investigate a webhook

1. In RevenueCat webhook delivery history, copy the event ID, delivery time, HTTP status, App User
   ID, and environment.
2. In CloudWatch Logs, open `/aws/lambda/snoozefine-revenuecat-webhook...` and search the structured
   JSON logs for `eventId`. Logs intentionally omit the body and authorization header.
3. In DynamoDB, open the physical `RevenueCatWebhookEvent` table named by
   `WEBHOOK_TABLE_NAME` in the backend-only admin mapping and Get item by event ID.
4. Inspect `status`, `processingError`, identity aliases, product/entitlements, timestamps,
   environment, and `payloadHash`.
5. For unresolved events:

```bash
npm run admin:unresolved-webhooks -- --environment SANDBOX
```

Link the correct identifiers only after verifying account ownership. Then use RevenueCat Retry.
The original unresolved event remains an audit record and the retry of that same ID remains a
duplicate; resolving an already-persisted unresolved event requires a reviewed reconciliation tool
in a later hardening slice. Do not delete the audit row to force replay.

## Verify duplicate/idempotent delivery

Retry a known event in RevenueCat. A healthy duplicate returns HTTP 200 and logs
`duplicate: true`. Confirm:

- exactly one `RevenueCatWebhookEvent` item for event ID;
- exactly one `PointPeriod` for entitlement + period start;
- exactly one `PointTransaction` whose idempotency key starts `subscription-allocation:`;
- unchanged `PointAccount.lifetimeAllocated`.

Conditional failures are retried inside the function; persistent errors return a sanitized 500 so
RevenueCat will retry.

## Inspect and reconcile a user's ledger

```bash
npm run admin:ledger -- --user-id <cognito-sub> --environment SANDBOX
```

The command outputs the environment-specific account, newest-first transactions, active-period
ledger sum, and `projectionMatchesActivePeriod`.

For the active period:

```text
sum(transaction.amount where pointPeriodId == activePeriodId)
  == PointPeriod.currentRemaining
  == PointAccount.currentBalance
```

Across history:

```text
sum(MONTHLY_ALLOCATION amounts) == PointAccount.lifetimeAllocated
absolute sum(SNOOZE_DEDUCTION amounts) == PointAccount.lifetimeDeducted
```

Admin adjustments are separate from both lifetime counters. Investigate a mismatch before changing
anything: compare timestamps, idempotency keys, environment, active period ID, and CloudWatch
transaction errors. Never repair by editing or deleting ledger rows.

## Auditable admin adjustment

Use only for a documented support/reconciliation reason. The command clamps the active-period
balance to `0...initialAllocation`, inserts an immutable `ADMIN_ADJUSTMENT` ledger row, and updates
account/period projections in one DynamoDB transaction.

```bash
npm run admin:adjust -- \
  --user-id <cognito-sub> \
  --amount 25 \
  --reason "restore points for support case SF-1234" \
  --idempotency-key "SF-1234-restore-2026-08-10" \
  --environment SANDBOX
```

Reuse the exact idempotency key on retry. Production additionally requires both an explicit
environment and confirmation:

```bash
npm run admin:adjust -- \
  --user-id <cognito-sub> \
  --amount -25 \
  --reason "approved correction SF-4321" \
  --idempotency-key "SF-4321-correction" \
  --environment PRODUCTION \
  --confirm-production
```

Restrict IAM access to this command's tables/actions and retain terminal/audit logs. The admin CLI
never mutates an existing transaction.

## Rerun a failed test settlement

First investigate CloudWatch logs for `test_settlement_failed`. Verify the selected environment
and that subscription/period tables are readable. Then:

```bash
npm run admin:settlement -- --month 2026-08 --environment SANDBOX
```

The deterministic ID is `2026-08:SANDBOX:v1`. If a `CALCULATED` record already exists, the rerun
returns `duplicate: true`. Do not delete or overwrite it to change totals; increment the calculation
version in reviewed code or mark the prior record `VOID` through a future controlled operation.

Version `v1` uses the latest period projection for the cutoff, so delayed backdated reruns after
later transactions may not reconstruct the historical cutoff exactly. See `ARCHITECTURE.md`.

## Environment isolation

- Every lifecycle/account/period/transaction/snooze/settlement record stores environment.
- App account and history functions use the deployment's `SNOOZEFINE_ENVIRONMENT`.
- Transaction history partitions are `{cognitoSub}:{environment}`.
- Admin commands accept `--environment`; production is never inferred unless the operator set the
  environment explicitly.
- RevenueCat should route sandbox and production purchases to separate deployed backends.

If totals look mixed, stop settlement work and inspect the deployed branch output and build
variable before correcting any data.

## Rotate webhook authorization

Follow `REVENUECAT_SETUP.md`:

1. update the Amplify secret;
2. redeploy;
3. update RevenueCat immediately;
4. retry any temporary 401 deliveries;
5. verify successful structured log entries.

Never print the secret with `ampx sandbox secret get` in a recorded terminal/CI log.

## Validate that no donation was initiated

1. Search the repository for payment/charity SDKs and outbound transfer code:

```bash
rg -i "stripe|paypal|charity|donat(e|ion)|transfer" amplify scripts package.json
```

2. Review the monthly settlement Lambda IAM policy: it needs DynamoDB read and settlement-table
   writes only.
3. Confirm settlement rows have `mode=TEST`, `status=CALCULATED`, and
   `calculationMetadata.actualDonationPaid=false`.
4. Confirm admin output says “expected donation” and “not yet paid.”
5. Verify no payment provider credentials or secrets exist for this backend.

## Logging and alarms to add before production scale

Structured CloudWatch logs already include correlation/request IDs and exclude secrets/full
webhook bodies. Before a broad production rollout, add alarms for Lambda errors/throttles,
RevenueCat 5xx rate, unresolved/failed webhook age, DynamoDB throttles, EventBridge settlement
failures, and projection reconciliation mismatches. Add a DLQ/on-failure destination to the
scheduled invocation if organizational EventBridge policy requires it.
