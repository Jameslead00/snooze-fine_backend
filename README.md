# SnoozeFine backend

This backend supports subscription entitlement, neutral alarm synchronisation and statistics,
idempotent earned DisciPoint awards for qualifying wake and habit completions, and non-consuming
community charity-vote allocation. It never deducts points for snoozes or missed habits.

DisciPoints have no cash value, never convert to USD, never determine a donation amount, and are
not consumed when allocated to an active ballot. Company contributions are separate, fixed or
capped company decisions whose public status may be shown to the community.

## Migration guardrails

The public GraphQL surface intentionally excludes per-snooze operations, point deductions,
penalties, legacy allocations, monetary projections, settlements, and donation records. A
deployment is required to remove those deployed schema members. Regenerate the iOS Amplify client
outputs after deploying this schema revision, then remove calls to legacy operations from the app.

## Verification

Run `npm run typecheck` and `npm test`. Neither command deploys infrastructure.
