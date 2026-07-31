# SnoozeFine backend

Production-minded first vertical slice of SnoozeFine, implemented as an AWS Amplify Gen 2
backend-only TypeScript repository.

The backend authenticates users with Cognito, receives authenticated RevenueCat webhooks,
allocates one 2,000-point ledger entry per eligible subscription period, accepts idempotent
snooze deductions through AppSync, returns the official server balance/history, and calculates
calendar-month test settlements. It does **not** transfer money or call a charity/payment API.

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

1. In AWS Amplify, create a Gen 2 app and connect this backend-only repository/branch.
2. Under Hosting → Secrets, create `REVENUECAT_WEBHOOK_AUTH_TOKEN` for the branch. Do not add the
   value as a normal environment variable.
3. Set the non-secret build variable `SNOOZEFINE_ENVIRONMENT` to `SANDBOX` for staging. Set it to
   `PRODUCTION` only on the production branch.
4. Let Amplify deploy the branch, or run the current Gen 2 pipeline command from authenticated CI:

```bash
export CI=1
npm ci
npm run deploy -- --branch main --app-id <amplify-app-id>
npm run outputs -- --branch main --app-id <amplify-app-id>
```

`pipeline-deploy` is a CI/branch workflow, not a substitute for the personal `ampx sandbox`
workflow. The generated output includes the AppSync/Auth configuration, webhook URL, deployment
environment, test settlement marker, and physical DynamoDB table names used by the credentialed
admin CLI.

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

The CLI uses the default AWS SDK credential chain plus table names in `amplify_outputs.json`.
Point it at another outputs file with `AMPLIFY_OUTPUTS_PATH`.

```bash
export AWS_PROFILE=<your-profile>
export AWS_REGION=eu-central-1

npm run admin:summary -- --environment SANDBOX
npm run admin:unresolved-webhooks -- --environment SANDBOX
npm run admin:settlement -- --month 2026-08 --environment SANDBOX
```

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

See `ARCHITECTURE.md`, `REVENUECAT_SETUP.md`, `SWIFT_INTEGRATION.md`, and `OPERATIONS.md` before a
staging rollout.
