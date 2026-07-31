# RevenueCat setup

These steps configure RevenueCat as a subscription event source. The iOS public SDK key remains in
the iOS app; webhook authorization and any RevenueCat secret API key remain server-side.

## 1. Products and entitlement

1. In App Store Connect, create or identify the monthly auto-renewing subscription. Complete the
   required Apple agreements, metadata, pricing, localization, review screenshot, and subscription
   group configuration.
2. In RevenueCat → Product catalog, import/identify product
   `snoozefine_plus_monthly`.
3. In RevenueCat → Entitlements, create or identify `snoozefine_plus`.
4. Attach `snoozefine_plus_monthly` to that entitlement and the intended offering/package.
5. Preserve the existing consumable `snooze_1` during migration. Do not attach the consumable to
   the monthly entitlement and do not rename it while the released app still sells it.

The server constants are in `amplify/shared/config.ts`. Change product identifiers there only as a
reviewed code change.

## 2. Deploy and obtain the webhook URL

For a sandbox:

```bash
export AWS_PROFILE=<profile>
export AWS_REGION=eu-central-1
export SNOOZEFINE_ENVIRONMENT=SANDBOX
npx ampx sandbox secret set REVENUECAT_WEBHOOK_AUTH_TOKEN
npm run sandbox -- --profile "$AWS_PROFILE"
```

For a branch, create the secret in Amplify Console → Hosting → Secrets before branch deployment.
After deployment:

```bash
npm run outputs -- --app-id <amplify-app-id> --branch <branch>
node -e "const o=require('./amplify_outputs.json'); console.log(o.custom.snoozefine.revenuecat_webhook_url)"
```

The URL ends exactly in `/webhooks/revenuecat`.

## 3. Configure authorization

Generate a high-entropy random value using an approved password/secret manager. A conventional
complete value is:

```text
Bearer <at-least-32-random-bytes>
```

Store the **entire string** as `REVENUECAT_WEBHOOK_AUTH_TOKEN` using Amplify secret management.
Then in RevenueCat → Integrations → Webhooks:

1. Add a webhook configuration.
2. Paste the deployed HTTPS URL.
3. Paste the exact same entire string in Authorization header.
4. Do not paste the RevenueCat secret API key here.

The backend performs a constant-time comparison of SHA-256 digests of the exact header values.
Missing/different whitespace or a missing `Bearer ` prefix returns 401.

RevenueCat now supports optional HMAC webhook signing. This slice implements the requested exact
Authorization-header verification, not HMAC. Enabling and verifying RevenueCat HMAC over the raw
body is a recommended production-hardening addition.

## 4. Environment routing

Create separate RevenueCat webhook configurations for staging and production:

- staging backend URL: select **sandbox purchases only**;
- production backend URL: select **production purchases only**;
- if a dedicated production troubleshooting path also receives sandbox events, the stored
  `environment` still isolates them and all CLI/settlement commands require an environment.

Do not point both environments at one database deployment as an operational shortcut. The schema
also stores environment on subscription, account, period, transaction, snooze, webhook, and
settlement records.

## 5. Event filters

Enable at least:

- `INITIAL_PURCHASE`
- `RENEWAL`
- `PRODUCT_CHANGE`
- `CANCELLATION`
- `UNCANCELLATION`
- `EXPIRATION`
- `BILLING_ISSUE`
- `TRANSFER`
- `SUBSCRIPTION_PAUSED`
- dashboard `TEST` while configuring

Unknown types and dashboard `TEST` are persisted as safe `IGNORED` no-ops (or `UNRESOLVED` when
identity cannot be mapped). A product change itself never mints points; its accompanying genuine
initial-purchase/renewal event owns the period allocation. Cancellation does not end access before
RevenueCat's expiration timestamp.

## 6. Stable user identity migration

The existing app has RevenueCat anonymous IDs. After Cognito sign-in:

1. read `Purchases.shared.appUserID` before changing identity;
2. call backend `linkRevenueCatCustomer` with stable ID = Cognito `sub`, the old anonymous ID, and
   the user's IANA timezone;
3. call `Purchases.shared.logIn(cognitoSub)`;
4. retain the same Cognito `sub` on future launches/devices.

RevenueCat may merge/alias the anonymous and stable identities according to its customer identity
rules. Normal webhook resolution checks `app_user_id`, `original_app_user_id`, and `aliases`.
Transfer events resolve the destination using `transferred_to`; `transferred_from` is retained as
audit metadata without assigning the event to the former owner.

Never use email as RevenueCat App User ID, and never send a RevenueCat secret key to the app. The
Cognito `sub` is non-email, stable, and canonical for this backend.

## 7. Test plan

Use a StoreKit configuration or Apple sandbox tester plus RevenueCat sandbox mode.

1. **Link:** authenticate in SnoozeFine, link the old anonymous ID, then log in to RevenueCat with
   the Cognito `sub`.
2. **Initial purchase:** buy `snoozefine_plus_monthly`. Confirm one webhook, one point period, one
   +2,000 ledger entry, and official balance 2,000.
3. **Duplicate delivery:** open the event in RevenueCat webhook delivery history and Retry. Expect
   HTTP 200 with `duplicate: true`; balance and lifetime allocation must not change.
4. **Renewal:** allow sandbox accelerated renewal. Confirm a new period and exactly one new +2,000
   allocation. The new period becomes spendable.
5. **Cancellation:** cancel auto-renew. Confirm status `CANCELLED_PENDING_EXPIRY` and existing
   points remain usable until expiration.
6. **Uncancellation:** re-enable before expiration. Confirm `ACTIVE`, with no new allocation.
7. **Billing issue:** use available store sandbox controls. Confirm the event does not itself revoke
   unexpired access.
8. **Expiration:** let the period expire. Confirm `EXPIRED`, no allocation, and snooze submissions
   are rejected.
9. **Transfer:** exercise RevenueCat restore/transfer behavior only with dedicated test accounts.
   Confirm the event is audited and does not mint points.
10. **Unresolved:** send a test event with an unlinked App User ID, then inspect:

```bash
npm run admin:unresolved-webhooks -- --environment SANDBOX
```

RevenueCat retries non-2xx deliveries. Its event `id` stays stable across retries, which is the
backend's webhook idempotency key.

## 8. Optional secret API key

`REVENUECAT_SECRET_API_KEY` is reserved for future server-side subscriber lookup/reconciliation.
This slice makes no RevenueCat REST API calls and does not require it. If later enabled:

```bash
npx ampx sandbox secret set REVENUECAT_SECRET_API_KEY
```

Then add a `secret('REVENUECAT_SECRET_API_KEY')` reference only to the specific function that needs
it and grant no client access.

## 9. Rotate the authorization value

1. Generate a new random complete header value.
2. Update the Amplify secret and redeploy the target environment.
3. Immediately update RevenueCat's Authorization header.
4. Retry any deliveries that received 401 during the short transition.
5. Verify a test delivery returns 200 and CloudWatch contains `revenuecat_webhook_processed`.
6. Remove the old value from the secret manager/history according to organizational policy.

The handler never logs the configured or received authorization value.
