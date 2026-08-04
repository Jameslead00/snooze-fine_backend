# SnoozeFine backend

This backend supports subscription entitlement, neutral alarm synchronisation and statistics,
idempotent earned DisciPoint awards for qualifying wake and habit completions, and private
friends leaderboards. It never deducts points for snoozes or missed habits.

DisciPoints have no cash value and are tracked only in an immutable earned ledger. Social access
requires an immutable normalized username (3–20 lowercase letters, numbers, or underscores).
Friend requests are exact-username only: there is no directory, prefix search, email lookup, or
username-availability endpoint. Invalid and unknown request targets return the same generic
unsent response. Mutual profile and leaderboard visibility begins only after acceptance.

## Owner configuration

At deployment, set any of these Lambda environment variables in the pipeline and redeploy; no
iOS update is required: `SNOOZEFINE_AWARD_WAKE_COMPLETION`,
`SNOOZEFINE_AWARD_HABIT_WATER`, `SNOOZEFINE_AWARD_HABIT_READING`,
`SNOOZEFINE_AWARD_HABIT_MEDITATION`, `SNOOZEFINE_AWARD_HABIT_BED`, and
`SNOOZEFINE_AWARD_HABIT_CUSTOM`. Each award is validated as a nonnegative integer from 0 to
10,000. `SNOOZEFINE_MAX_ACTIVE_OUTGOING_FRIEND_REQUESTS` is a 1–100 active-request cap
(default 20) to limit automated probing. There is deliberately no negative/snooze-deduction
configuration.

## Migration guardrails

The public GraphQL surface intentionally excludes per-snooze operations, point deductions,
penalties, charity allocations, monetary projections, settlements, and donation records. A
deployment is required to remove those deployed schema members. Regenerate the iOS Amplify client
outputs after deploying this schema revision, then update the app to use the username/friend
request operations before enabling the social UI.

## Verification

Run `npm run typecheck` and `npm test`. Neither command deploys infrastructure.
