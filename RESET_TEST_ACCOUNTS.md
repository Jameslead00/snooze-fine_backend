# Reset the SnoozeFine test accounts

This is a destructive, data-only reset. It preserves the deployed API, Lambda functions, DynamoDB
tables, Cognito pool, and infrastructure. It deletes the two explicitly configured demo users,
their linked SnoozeFine DynamoDB records, usernames, habits, points, friend data, alarms, wake
events, engagement events, and AWS-side subscription/link/webhook state.

RevenueCat customer records outside AWS are not deleted by this utility. Because the Cognito users
are deleted, newly created accounts will use new Cognito and RevenueCat App User IDs.

From this backend directory, run:

```sh
aws sso login --profile snoozefine-dev
aws sts get-caller-identity --profile snoozefine-dev

npm run reset:test-accounts -- \
  --profile snoozefine-dev \
  --region eu-north-1 \
  --user-pool-id eu-north-1_hmgn9tVBo \
  --table-suffix 22zzo56n2vhdhezyn6ie6gihy4-NONE \
  --confirm SNOOZEFINE_RESET_TEST_DATA
```

The command refuses to run without the confirmation token and verifies that both target users and
all linked records are gone before reporting success. The target emails are deliberately fixed in
`scripts/reset-test-accounts.ts`:

- `swapseasedemo@gmail.com`
- `james.leadbeater1@icloud.com`
