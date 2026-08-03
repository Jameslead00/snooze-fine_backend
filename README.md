# SnoozeFine backend

Production-minded first vertical slice of SnoozeFine, implemented as an AWS Amplify Gen 2
backend-only TypeScript repository.

The backend authenticates users with Cognito, receives authenticated RevenueCat webhooks,
allocates one 2,000-point ledger entry per eligible subscription period, accepts idempotent
snooze deductions through AppSync, returns the official server balance/history, and calculates
calendar-month test settlements. It does **not** transfer money or call a charity/payment API.
Authenticated first-party engagement events provide a minimal retention signal without accepting a
client user ID, advertising identifier, or free-form analytics properties.

## Prerequisites

- Node.js 20 (`nvm use` reads `.nvmrc`) and npm 10+
- An AWS account and credentials allowed to deploy Amplify Gen 2/CDK resources
- A RevenueCat Pro project for webhook delivery
- For branch deployment, an Amplify app ID and connected branch

Use an AWS profile or your organization's short-lived credential process. Never put AWS access
keys in this repository or in the iOS app.

## Fresh checkout

```bash
git clone <repository-url> snoozefine-backend
cd snoozefine-backend
nvm use
npm ci
npm run typecheck
npm run lint
npm test
```

The installed package scripts are:

```text
npm run sandbox
npm run deploy -- --branch <branch> --app-id <amplify-app-id>
npm run outputs -- --branch <branch> --app-id <amplify-app-id>
npm run admin:summary -- --environment SANDBOX
npm run admin:unresolved-webhooks -- --environment SANDBOX
npm run admin:settlement -- --month 2026-08 --environment SANDBOX
npm run admin:adjust -- --user-id <sub> --amount -25 --reason "support case 123" --idempotency-key <unique-key> --environment SANDBOX
npm run admin:engagement -- --days 30 --environment SANDBOX
npm run seed -- --user-id <cognito-sub>
```

## Personal cloud sandbox

Select the intended account and region, then store the RevenueCat authorization value as an
Amplify secret. The value is the **entire exact Authorization header**, for example a generated
`Bearer <random-value>` string.

```bash
export AWS_PROFILE=<your-profile>
export AWS_REGION=eu-central-1
export SNOOZEFINE_ENVIRONMENT=SANDBOX
npx ampx sandbox secret set REVENUECAT_WEBHOOK_AUTH_TOKEN
npm run sandbox -- --profile "$AWS_PROFILE"
```

The sandbox writes `amplify_outputs.json` to the repository root; it is intentionally gitignored.
Read the deployed webhook URL with:

```bash
node -e "const o=require('./amplify_outputs.json'); console.log(o.custom.snoozefine.revenuecat_webhook_url)"
```

Generate Swift model code only if the iOS project wants modelgen in addition to the manual custom
operation DTOs in `SWIFT_INTEGRATION.md`:

```bash
npx ampx generate graphql-client-code \
  --format modelgen \
  --model-target swift \
  --out ../path-to-ios/AmplifyModels
```

Delete all personal sandbox resources when they are no longer needed:

```bash
npx ampx sandbox delete --profile "$AWS_PROFILE"
```

Amplify sandbox secret values are stored separately in SSM Parameter Store; inspect/remove those
as part of environment cleanup.

## Branch deployment

1. In AWS Amplify, create or select the Gen 2 app and connect this backend-only repository.
2. Create a branch named `staging` for the persistent test environment. Do not connect the
   production branch yet.
3. Under Hosting → Secrets, create these five values for the `staging` branch. Reusing the current
   non-production values is allowed while staging remains a trusted test environment:
   `SIWA_CLIENT_ID`, `SIWA_KEY_ID`, `SIWA_PRIVATE_KEY`, `SIWA_TEAM_ID`, and
   `REVENUECAT_WEBHOOK_AUTH_TOKEN`. Do not add them as ordinary environment variables or commit
   them to this repository.
4. Set the non-secret build variable `SNOOZEFINE_ENVIRONMENT` to `SANDBOX` for staging. Set it to
   `PRODUCTION` only on the future production branch.
5. Let Amplify deploy the branch, or run the current Gen 2 pipeline command from authenticated CI:

```bash
export CI=1
npm ci
npm run deploy -- --branch staging --app-id <amplify-app-id>
npm run outputs -- --branch staging --app-id <amplify-app-id>
```

`pipeline-deploy` is a CI/branch workflow, not a substitute for the personal `ampx sandbox`
workflow. The generated output includes the AppSync/Auth configuration, webhook URL, deployment
environment, and test settlement marker. Physical DynamoDB table names stay in the backend-only
admin mapping described below and must not be added to the public output bundled with iOS.

See `STAGING_DEPLOYMENT.md` for the complete staging checklist, RevenueCat routing, and iOS output
handoff.

## Create an administrator

The backend declares the Cognito group `ADMINS`. After deployment:

1. Open Amplify Console → the deployed branch → Authentication → User management.
2. Create/confirm an email/password user if necessary.
3. Open Groups → `ADMINS` → Add users.
4. Sign out and back in so the new `cognito:groups` claim is present.

Generated Data model operations are read-only for `ADMINS`; ordinary users cannot write the
ledger, point account, subscription, webhook, snooze, period, or settlement tables. Administrative
writes use the AWS-credentialed CLI and DynamoDB transactions.

## Admin CLI

The CLI uses the default AWS SDK credential chain. Physical DynamoDB table names are deliberately
kept out of the public `amplify_outputs.json`, because that same file is bundled with iOS. Copy
`admin_tables.example.json` to the gitignored `admin_tables.local.json`, replace each value with
the matching physical table name from the deployed Amplify sandbox, and point the CLI at it.
Never copy this backend-only mapping into the iOS repository or commit it.

```bash
export AWS_PROFILE=<your-profile>
export AWS_REGION=eu-central-1
export SNOOZEFINE_ADMIN_TABLES_PATH=./admin_tables.local.json

npm run admin:summary -- --environment SANDBOX
npm run admin:unresolved-webhooks -- --environment SANDBOX
npm run admin:engagement -- --days 30 --environment SANDBOX
npm run admin:settlement -- --month 2026-08 --environment SANDBOX
```

`SNOOZEFINE_ADMIN_TABLES_JSON` may be used instead by secured CI. A legacy backend output that
already contains `custom.snoozefine.admin_tables` remains supported, but new public outputs must
not add it. Point at another public outputs file with `AMPLIFY_OUTPUTS_PATH`.

All summary and settlement output says **TEST MODE**, **expected donation**, and **not yet paid**.
Production is never selected implicitly; pass `--environment PRODUCTION`. A production admin
adjustment additionally requires `--confirm-production`.

The development seed is permanently restricted to `SANDBOX`. Create a Cognito test user first,
copy its `sub`, then run:

```bash
npm run seed -- --user-id <cognito-sub> --timezone Europe/Zurich
```

It creates an idempotent linked RevenueCat sandbox identity, active period, 2,000-point allocation,
two 25-point snoozes, and a calculated test settlement.

For a staging Community walkthrough, use the staging-only fixture after deployment. It creates
three owner-reviewed test charities, an open current-month ballot, deterministic synthetic members
with active 2,000-point periods, and recent daily vote rows. The synthetic members are DynamoDB
fixture records, not Cognito accounts; the signed-in staging user can still vote normally.

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

The command is idempotent and recalculates ballot tallies from the stored vote rows. It prints the
synthetic remaining-point total and expected donation projection. It requires an AWS profile with
write access to the staging DynamoDB tables; it never targets `PRODUCTION` and never transfers
money.

## Sign in with Apple readiness

Email/password is deployed now. Apple federation is deliberately not enabled with fake values:
Cognito requires a real Apple Services ID, Team ID, Key ID, private key, callback URL, and logout
URL. Once those exist, add an `apple` provider under `loginWith.externalProviders` using Amplify
`secret(...)` references and real callback/logout URLs, then enable Sign in with Apple in the iOS
target. Never commit the Apple private key. See `SWIFT_INTEGRATION.md` for the app-side boundary.

## Configuration constants

All non-secret business constants live in `amplify/shared/config.ts`:

- entitlement: `snoozefine_plus`
- monthly product: `snoozefine_plus_monthly`
- legacy consumable: `snooze_1`
- period allocation: 2,000 DisciPoints
- default snooze deduction: 25 DisciPoints
- donation rate: 1,000 micro-USD per point
- settlement mode: `TEST`

Engagement analytics is intentionally allow-listed to session start and the core subscription,
Today, Habits, Community, and Account surfaces. The AppSync resolver injects the Cognito `sub` and
rejects stale/future timestamps; event UUIDs are idempotent and account-bound.

Financial calculations use safe integers. Settlement `expectedDonationMicroUsd` is stored and
returned as a decimal string because GraphQL `Int` is limited to signed 32-bit values; it still
represents an integer number of micro-dollars and is never calculated with floating point.

## Troubleshooting

- **No `amplify_outputs.json`:** a sandbox/branch must deploy successfully first. For a branch run
  `npm run outputs -- --branch <branch> --app-id <id>`.
- **Secret missing:** run `npx ampx sandbox secret list`, then set
  `REVENUECAT_WEBHOOK_AUTH_TOKEN` in the same sandbox/profile.
- **AccessDenied:** verify the AWS profile/account/region and refresh short-lived credentials.
  Amplify deployment and the admin CLI require different scopes; see `OPERATIONS.md`.
- **Webhook 401:** RevenueCat's configured Authorization value must match the Amplify secret byte
  for byte, including a `Bearer ` prefix if one was chosen.
- **Webhook 404/405:** use the exact generated `/webhooks/revenuecat` URL and POST.
- **Wrong totals:** verify the command's `--environment`; sandbox and production are intentionally
  isolated.

See `ARCHITECTURE.md`, `REVENUECAT_SETUP.md`, `SWIFT_INTEGRATION.md`, `OPERATIONS.md`, and
`COMMUNITY_SANDBOX_RUNBOOK.md` before a staging rollout.
