# SnoozeFine staging deployment

This is the persistent AWS test environment for iOS integration, Apple sandbox purchases, and
RevenueCat webhook verification. It is not production and must keep `SNOOZEFINE_ENVIRONMENT=SANDBOX`.

## What staging isolates

- its own Cognito user pool and Hosted UI configuration;
- its own AppSync API and Lambda functions;
- its own DynamoDB tables and scheduled habit-enforcement resources;
- its own generated `amplify_outputs.json`;
- RevenueCat sandbox webhook traffic only.

Do not point staging and production at the same webhook endpoint or database deployment.

## Owner-required AWS setup

1. In Amplify Console, create/connect the Gen 2 backend repository and create a `staging` branch.
2. Set the branch build variable `SNOOZEFINE_ENVIRONMENT=SANDBOX`.
3. Add these branch secrets under Hosting → Secrets:

   - `SIWA_CLIENT_ID`
   - `SIWA_KEY_ID`
   - `SIWA_PRIVATE_KEY`
   - `SIWA_TEAM_ID`
   - `REVENUECAT_WEBHOOK_AUTH_TOKEN`

   The current non-production values may be reused for staging. Keep them out of Git, Xcode, and
   the iOS bundle. `REVENUECAT_SECRET_API_KEY` is not needed by the current backend.

4. Confirm the deployer has permission to deploy Amplify Gen 2 backend resources.
5. Start the branch deployment and wait for CloudFormation to finish successfully.

## CLI deployment alternative

From this repository, with authenticated AWS/Amplify access:

```bash
export AMPLIFY_APP_ID=<your-amplify-app-id>
# Staging region: Stockholm. The existing sandbox remains in eu-central-1.
export AWS_REGION=eu-north-1
export SNOOZEFINE_ENVIRONMENT=SANDBOX

npm ci
npm run typecheck
npm run lint
npm test
npm run deploy:staging
npm run outputs:staging
```

The deployment must complete before the outputs file is copied to iOS. Never use a failed or stale
outputs file as the staging configuration.

## RevenueCat staging webhook

After deployment, print the generated webhook URL:

```bash
node -e "const o=require('./amplify_outputs.json'); console.log(o.custom.snoozefine.revenuecat_webhook_url)"
```

In RevenueCat, create a webhook configuration with:

- the generated staging URL ending in `/webhooks/revenuecat`;
- the exact value of `REVENUECAT_WEBHOOK_AUTH_TOKEN` in the Authorization header;
- sandbox purchases/events enabled;
- production purchases/events disabled.

Send a RevenueCat dashboard test event and verify HTTP 200 before using an Apple sandbox purchase.

## Apple/Cognito staging configuration

The staging Cognito Hosted UI domain and callback URLs are environment-specific. Confirm the
staging Apple Services ID allows the staging Cognito domain's:

```text
https://<staging-cognito-domain>/oauth2/idpresponse
```

The iOS callback scheme remains `snoozefine://callback/` and sign-out remains
`snoozefine://signout/`.

## iOS handoff

1. Back up the current sandbox file in the iOS repository.
2. Copy the newly generated backend `amplify_outputs.json` into:

   `SnoozeFine/SnoozeFine/amplify_outputs.json`

3. Confirm it is included in the main app target and rebuild the iOS app.
4. Do not copy physical DynamoDB table names or any secret values into the iOS repository.

The current iOS target consumes one active outputs file at a time; switching to staging is therefore
an intentional configuration change. Keep the sandbox copy outside the target for rollback.

## Staging acceptance test

Use a fresh Cognito test user, not the seeded account:

1. Sign up/confirm and sign in.
2. Verify Cognito `sub` is linked to RevenueCat before purchase.
3. Buy `snoozefine_plus_monthly` in Apple sandbox.
4. Wait for the RevenueCat webhook and refresh Account & Points; expect 2,000 points.
5. Save a Water habit and refresh it.
6. Trigger one real alarm snooze; expect 1,975 points.
7. Retry the same event if transport fails; expect no second deduction.
8. Retry the RevenueCat webhook delivery; expect HTTP 200 and no duplicate allocation.

Only after this checklist passes should a separate production branch and production secret set be
created.

## Optional Community fixture

To exercise the Community tab before several real Apple sandbox subscribers exist, use the
backend-only admin mapping and an AWS profile with staging DynamoDB write access:

```bash
export AWS_REGION=eu-north-1
export SNOOZEFINE_ADMIN_TABLES_PATH=./admin_tables.local.json
npm run seed:community -- \
  --staging \
  --environment SANDBOX \
  --members 12 \
  --vote-days 3 \
  --timezone Europe/Zurich
```

This creates synthetic DynamoDB member records only; it does not create Cognito users or Apple
transactions. The fixture is marked by stable `staging-fixture-*` IDs, is safe to rerun, keeps the
ballot open for the current month, and reports the aggregate remaining points and expected
donation. It is test data only: no donation is paid.
