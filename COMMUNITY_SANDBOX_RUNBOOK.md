# Community and donation sandbox runbook

This is the deliberately manual Phase 1 operating path. It is for the personal `SANDBOX` only.
It does not transfer money, call a charity API, or authorize a production launch.

Use the AWS console with the same account and region as the deployed Amplify sandbox. Resolve the
physical tables in Amplify/DynamoDB; never copy those names into the iOS repository or public
`amplify_outputs.json`.

## 1. Prepare charities

Create one `Charity` item per owner-approved sandbox choice:

- `id`: stable lowercase identifier, for example `sandbox-charity-a`
- `name`, `summary`: reviewed display text
- `websiteUrl`, `impactLabel`: optional reviewed public values
- `active`: `true`
- `activeState`: `ACTIVE`
- `sortOrder`: unique display order
- `updatedAt`: current ISO-8601 timestamp

Do not imply affiliation or endorsement without written permission.

## 2. Publish a monthly ballot

Create one `CommunityBallot` item:

- `id`: a stable environment/month identifier
- `month`: `YYYY-MM`
- `environment`: `SANDBOX`
- `environmentStatus`: `SANDBOX:OPEN`
- `status`: `OPEN`
- `opensAt`, `closesAt`, `updatedAt`: ISO-8601 timestamps; `closesAt` must be after `opensAt`
- `charityIds`: the active charity IDs in display order
- `tallies`: a map containing every charity ID with value `0`
- `totalVotes`: `0`
- `version`: `1`

Before announcing it, sign in with a disposable subscriber, confirm the ballot appears, cast one
vote, refresh, and verify the same local day cannot create a second vote.

## 3. Close the ballot

After `closesAt`, inspect the stored tallies and votes. Resolve any tie using a documented owner
rule. Update the same ballot atomically or during a maintenance window:

- `status`: `CLOSED`
- `environmentStatus`: `SANDBOX:CLOSED`
- `winnerCharityId`: reviewed winning charity ID
- increment `version`
- set `updatedAt`

Never edit or delete `DailyCharityVote` records to manufacture a winner.

## 4. Record projected and manual donation states

Run the test settlement for the closed month and retain its output. Create a `DonationRecord` with:

- `id`: stable sandbox month/charity identifier
- `month`, `environment: SANDBOX`, `charityId`
- `status: EXPECTED`
- `expectedDonationMicroUsd`: the test settlement integer string
- `updatedAt`: current ISO-8601 timestamp

Set the ballot's `donationRecordId` to this record and increment its version. Progress the record
only after the corresponding manual owner step:

1. `APPROVED`: add `approvedDonationMicroUsd` and an approval note.
2. `PAID`: only after an actual transfer; add `paidDonationMicroUsd` and `paidAt`.
3. `EVIDENCED`: only after publishing a safe public receipt/evidence URL; add `evidenceUrl`.
4. `VOID`: use when the proposed record must not proceed; retain the audit item and explain why in
   `ownerNote`.

Update `updatedAt` at every transition. Never label `EXPECTED` or `APPROVED` as paid, and never add
an evidence URL that exposes donor, banking, account, or user information.

## 5. Verify the app

- Refresh Community after every transition.
- Confirm expected, approved, paid, and evidenced wording remains distinct.
- Confirm the official point ledger and balances did not change when the donation record changed.
- Keep screenshots and owner notes for the sandbox audit trail.
