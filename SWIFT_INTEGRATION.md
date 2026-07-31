# SwiftUI integration

This guide targets the existing SnoozeFine SwiftUI app. The backend cannot observe AlarmKit by
itself; the app must report a snooze after its existing purchase/entitlement flow has accepted the
action.

## Packages and generated output

In Xcode → File → Add Package Dependencies:

1. `https://github.com/aws-amplify/amplify-swift`
   - `Amplify`
   - `AWSCognitoAuthPlugin`
   - `AWSAPIPlugin`
2. Existing RevenueCat package:
   - `https://github.com/RevenueCat/purchases-ios`
   - `RevenueCat`
3. Optional prebuilt auth UI:
   - `https://github.com/aws-amplify/amplify-ui-swift-authenticator`
   - `Authenticator`

After the backend environment deploys, copy its `amplify_outputs.json` into the iOS repository,
add it to the Xcode target, and verify target membership. Keep distinct sandbox/staging/production
output files in build configurations; never point a production build at sandbox accidentally.

Manual `GraphQLRequest` DTOs below are sufficient for the custom operations. If the app also wants
generated model types:

```bash
npx ampx generate graphql-client-code \
  --format modelgen \
  --model-target swift \
  --out <ios-repository>/AmplifyModels
```

## Configure Amplify

Run once during app initialization before Auth/API calls:

```swift
import Amplify
import AWSCognitoAuthPlugin
import AWSAPIPlugin
import SwiftUI

@main
struct SnoozeFineApp: App {
    init() {
        do {
            try Amplify.add(plugin: AWSCognitoAuthPlugin())
            // Manual GraphQLRequest calls do not require model registration.
            try Amplify.add(plugin: AWSAPIPlugin())
            try Amplify.configure(with: .amplifyOutputs)
        } catch {
            assertionFailure("Amplify configuration failed: \(error)")
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
```

If generated models are used elsewhere, initialize the API plugin as:

```swift
try Amplify.add(plugin: AWSAPIPlugin(modelRegistration: AmplifyModels()))
```

Do not add the RevenueCat webhook token, RevenueCat secret API key, AWS access keys, or DynamoDB
table names to the app. `amplify_outputs.json` contains public client connection metadata and
Cognito/AppSync configuration, not those secrets.

## Email/password authentication

```swift
import Amplify

struct AccountAuthenticator {
    func signUp(email: String, password: String) async throws {
        let attributes = [
            AuthUserAttribute(.email, value: email)
        ]
        let options = AuthSignUpRequest.Options(userAttributes: attributes)
        let result = try await Amplify.Auth.signUp(
            username: email,
            password: password,
            options: options
        )
        // If result.isSignUpComplete is false, show the confirmation-code UI.
    }

    func confirmSignUp(email: String, code: String) async throws {
        _ = try await Amplify.Auth.confirmSignUp(
            for: email,
            confirmationCode: code
        )
    }

    func signIn(email: String, password: String) async throws {
        let result = try await Amplify.Auth.signIn(
            username: email,
            password: password
        )
        guard result.isSignedIn else {
            throw AuthenticationError.additionalStepRequired
        }
    }

    func cognitoSub() async throws -> String {
        // For this Cognito setup, AuthUser.userId is the canonical Cognito sub.
        try await Amplify.Auth.getCurrentUser().userId
    }

    enum AuthenticationError: Error {
        case additionalStepRequired
    }
}
```

Handle any multi-step sign-in states the released app enables (new password, MFA, etc.) rather than
treating a partial result as authenticated.

## Migrate the RevenueCat identity

Capture the existing anonymous ID **before** calling RevenueCat `logIn`. Link it to the Cognito
identity first so a fast webhook can already resolve either identity.

```swift
import RevenueCat

struct RevenueCatIdentityMigrator {
    let accountService: any PointAccountService

    func migrateAfterAuthentication(timezone: TimeZone = .current) async throws {
        let cognitoSub = try await Amplify.Auth.getCurrentUser().userId
        let priorRevenueCatID = Purchases.shared.appUserID
        let anonymousID = priorRevenueCatID.hasPrefix("$RCAnonymousID:")
            ? priorRevenueCatID
            : nil

        try await accountService.linkRevenueCatCustomer(
            stableAppUserID: cognitoSub,
            originalAnonymousAppUserID: anonymousID,
            timezone: timezone.identifier
        )

        _ = try await Purchases.shared.logIn(cognitoSub)
    }
}
```

On future launches, call `logIn(cognitoSub)` after authentication if RevenueCat is not already using
that ID. On account switch, call `logIn(newCognitoSub)`. Follow the app's intended anonymous logout
policy carefully; RevenueCat `logOut()` creates a new anonymous identity.

The backend refuses to link a RevenueCat ID already linked to another Cognito user. Surface that
error to support instead of trying a different identifier.

## Account service models

These DTOs intentionally represent `donationMicroUsd` as a decimal integer `String`. AppSync
GraphQL `Int` is only signed 32-bit, while aggregate micro-dollar values can exceed that.

```swift
import Foundation

struct PointAccountSnapshot: Decodable, Sendable, Equatable {
    let officialBalance: Int
    let activePointPeriodId: String?
    let initialAllocation: Int
    let pointsDeducted: Int
    let periodStart: String?
    let periodEnd: String?
    let subscriptionStatus: String
    let donationMicroUsd: String
    let serverTimestamp: String
}

struct PointTransactionItem: Decodable, Sendable, Identifiable, Equatable {
    let id: String
    let pointPeriodId: String
    let amount: Int
    let transactionType: String
    let reasonCode: String
    let source: String
    let sourceEventId: String
    let relatedEventId: String?
    let balanceAfter: Int
    let createdAt: String
}

struct PointTransactionPage: Decodable, Sendable, Equatable {
    let items: [PointTransactionItem]
    let nextToken: String?
}

struct RecordSnoozeRequest: Sendable {
    let alarmId: String
    let alarmOccurrenceId: String
    let snoozeEventId: UUID
    let occurredAt: Date
    let legacyPurchaseReference: String?
    let clientAppVersion: String?
}

struct RecordSnoozeResponse: Decodable, Sendable, Equatable {
    let accepted: Bool
    let duplicate: Bool
    let pointsDeducted: Int
    let officialBalance: Int
    let activePointPeriodId: String
    let serverTimestamp: String
}

protocol PointAccountService: Sendable {
    func fetchPointAccount() async throws -> PointAccountSnapshot
    func fetchTransactions(
        limit: Int,
        nextToken: String?
    ) async throws -> PointTransactionPage
    func recordSnooze(_ request: RecordSnoozeRequest) async throws -> RecordSnoozeResponse
    func linkRevenueCatCustomer(
        stableAppUserID: String,
        originalAnonymousAppUserID: String?,
        timezone: String
    ) async throws
}
```

## Amplify implementation

```swift
import Amplify
import Foundation

struct AmplifyPointAccountService: PointAccountService {
    enum ServiceError: Error {
        case missingResponse(String)
    }

    private struct AccountEnvelope: Decodable {
        let getMyPointAccount: PointAccountSnapshot?
    }

    private struct TransactionEnvelope: Decodable {
        let listMyPointTransactions: PointTransactionPage?
    }

    private struct SnoozeEnvelope: Decodable {
        let recordSnooze: RecordSnoozeResponse?
    }

    private struct LinkResult: Decodable {
        let linked: Bool
        let duplicate: Bool
    }

    private struct LinkEnvelope: Decodable {
        let linkRevenueCatCustomer: LinkResult?
    }

    func fetchPointAccount() async throws -> PointAccountSnapshot {
        let document = """
        query GetMyPointAccount {
          getMyPointAccount {
            officialBalance
            activePointPeriodId
            initialAllocation
            pointsDeducted
            periodStart
            periodEnd
            subscriptionStatus
            donationMicroUsd
            serverTimestamp
          }
        }
        """

        let result = try await Amplify.API.query(
            request: GraphQLRequest<AccountEnvelope>(
                document: document,
                responseType: AccountEnvelope.self
            )
        )
        switch result {
        case .success(let envelope):
            guard let account = envelope.getMyPointAccount else {
                throw ServiceError.missingResponse("getMyPointAccount")
            }
            return account
        case .failure(let error):
            throw error
        }
    }

    func fetchTransactions(
        limit: Int = 50,
        nextToken: String? = nil
    ) async throws -> PointTransactionPage {
        let document = """
        query ListMyPointTransactions($limit: Int, $nextToken: String) {
          listMyPointTransactions(limit: $limit, nextToken: $nextToken) {
            items {
              id
              pointPeriodId
              amount
              transactionType
              reasonCode
              source
              sourceEventId
              relatedEventId
              balanceAfter
              createdAt
            }
            nextToken
          }
        }
        """
        var variables: [String: Any] = ["limit": min(max(limit, 1), 100)]
        if let nextToken {
            variables["nextToken"] = nextToken
        }
        let result = try await Amplify.API.query(
            request: GraphQLRequest<TransactionEnvelope>(
                document: document,
                variables: variables,
                responseType: TransactionEnvelope.self
            )
        )
        switch result {
        case .success(let envelope):
            guard let page = envelope.listMyPointTransactions else {
                throw ServiceError.missingResponse("listMyPointTransactions")
            }
            return page
        case .failure(let error):
            throw error
        }
    }

    func recordSnooze(
        _ request: RecordSnoozeRequest
    ) async throws -> RecordSnoozeResponse {
        let document = """
        mutation RecordSnooze($input: RecordSnoozeInput!) {
          recordSnooze(input: $input) {
            accepted
            duplicate
            pointsDeducted
            officialBalance
            activePointPeriodId
            serverTimestamp
          }
        }
        """
        var input: [String: Any] = [
            "alarmId": request.alarmId,
            "alarmOccurrenceId": request.alarmOccurrenceId,
            "snoozeEventId": request.snoozeEventId.uuidString.lowercased(),
            "occurredAt": ISO8601DateFormatter().string(from: request.occurredAt)
        ]
        if let reference = request.legacyPurchaseReference {
            input["legacyPurchaseReference"] = reference
        }
        if let version = request.clientAppVersion {
            input["clientAppVersion"] = version
        }
        let result = try await Amplify.API.mutate(
            request: GraphQLRequest<SnoozeEnvelope>(
                document: document,
                variables: ["input": input],
                responseType: SnoozeEnvelope.self
            )
        )
        switch result {
        case .success(let envelope):
            guard let response = envelope.recordSnooze else {
                throw ServiceError.missingResponse("recordSnooze")
            }
            return response
        case .failure(let error):
            throw error
        }
    }

    func linkRevenueCatCustomer(
        stableAppUserID: String,
        originalAnonymousAppUserID: String?,
        timezone: String
    ) async throws {
        let document = """
        mutation LinkRevenueCat(
          $revenueCatAppUserId: String!,
          $originalAnonymousAppUserId: String,
          $timezone: String!
        ) {
          linkRevenueCatCustomer(
            revenueCatAppUserId: $revenueCatAppUserId,
            originalAnonymousAppUserId: $originalAnonymousAppUserId,
            timezone: $timezone
          ) {
            linked
            duplicate
          }
        }
        """
        var variables: [String: Any] = [
            "revenueCatAppUserId": stableAppUserID,
            "timezone": timezone
        ]
        if let originalAnonymousAppUserID {
            variables["originalAnonymousAppUserId"] = originalAnonymousAppUserID
        }
        let result = try await Amplify.API.mutate(
            request: GraphQLRequest<LinkEnvelope>(
                document: document,
                variables: variables,
                responseType: LinkEnvelope.self
            )
        )
        switch result {
        case .success(let envelope):
            guard envelope.linkRevenueCatCustomer?.linked == true else {
                throw ServiceError.missingResponse("linkRevenueCatCustomer")
            }
        case .failure(let error):
            throw error
        }
    }
}
```

The AppSync default authorization mode is Cognito User Pools, so these requests automatically use
the current Amplify Auth session. Do not put `userId` in any document/variables.

## Official balance view model

```swift
import Foundation

@MainActor
final class PointAccountViewModel: ObservableObject {
    enum State: Equatable {
        case idle
        case loading
        case loaded(PointAccountSnapshot)
        case failed(String)
    }

    @Published private(set) var state: State = .idle
    private let service: any PointAccountService

    init(service: any PointAccountService = AmplifyPointAccountService()) {
        self.service = service
    }

    func load() async {
        state = .loading
        do {
            state = .loaded(try await service.fetchPointAccount())
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func submitVerifiedSnooze(_ request: RecordSnoozeRequest) async throws {
        let response = try await service.recordSnooze(request)

        // This response is already server-authoritative. Refresh to reconcile the
        // entire view (period dates, subscription state, and donation value).
        if case .loaded(let current) = state {
            state = .loaded(
                PointAccountSnapshot(
                    officialBalance: response.officialBalance,
                    activePointPeriodId: response.activePointPeriodId,
                    initialAllocation: current.initialAllocation,
                    pointsDeducted: current.initialAllocation - response.officialBalance,
                    periodStart: current.periodStart,
                    periodEnd: current.periodEnd,
                    subscriptionStatus: current.subscriptionStatus,
                    donationMicroUsd: current.donationMicroUsd,
                    serverTimestamp: response.serverTimestamp
                )
            )
        }
        await load()
    }
}
```

Never derive the official balance as `localBalance - 25`. If an optimistic visual update is useful,
replace it with the balance from `recordSnooze`, then reconcile using `fetchPointAccount`. The
backend may deduct fewer than 25 points when fewer remain, or return the original result on a retry.

A simple state view:

```swift
import SwiftUI

struct PointBalanceView: View {
    @StateObject private var model = PointAccountViewModel()

    var body: some View {
        Group {
            switch model.state {
            case .idle, .loading:
                ProgressView("Loading official balance…")
            case .loaded(let account):
                VStack {
                    Text("\(account.officialBalance) DisciPoints")
                        .font(.title.bold())
                    Text("Official server balance")
                        .foregroundStyle(.secondary)
                }
            case .failed(let message):
                ContentUnavailableView(
                    "Balance unavailable",
                    systemImage: "exclamationmark.triangle",
                    description: Text(message)
                )
            }
        }
        .task { await model.load() }
        .refreshable { await model.load() }
    }
}
```

## Snooze migration flow

Keep three concepts separate.

### Current released consumable flow

1. AlarmKit snooze intent opens/foregrounds SnoozeFine.
2. The app runs its existing verified `snooze_1` RevenueCat/App Store consumable purchase logic.
3. The app schedules the replacement alarm only after that existing purchase logic accepts the
   snooze.
4. During migration, optionally attach the legacy transaction/reference to the backend call for
   audit. This backend does not verify that consumable against Apple.

### New subscription + DisciPoint flow

1. Authenticate with Cognito.
2. Link/migrate RevenueCat identity and confirm `snoozefine_plus` via the existing RevenueCat
   customer-info UI logic.
3. For the actual user-approved snooze, create one stable `UUID` **once** and persist it with the
   pending action.
4. Call `recordSnooze` with alarm IDs, occurrence ID, UUID, and occurrence timestamp.
5. Use the returned official balance. The server decides identity, subscription eligibility, point
   period, and deduction amount.
6. Schedule the replacement alarm according to the existing verified entitlement/purchase logic.
7. On timeout/network retry, reuse the same UUID. Do not generate a second UUID.

### Temporary coexistence

Use a feature flag/versioned migration decision:

- older/non-authenticated releases continue only their legacy consumable path;
- migrated authenticated subscribers use the subscription + DisciPoint path;
- while business policy requires both, perform the legacy purchase first, then report the backend
  snooze with the optional legacy reference;
- a backend failure must not be represented as a successful point deduction; queue a bounded retry
  with the same snooze UUID and show reconciliation state;
- decide replacement-alarm scheduling using the existing verified purchase/entitlement policy, not
  a locally guessed point balance.

Example pending-event creation:

```swift
let pending = RecordSnoozeRequest(
    alarmId: alarm.id,
    alarmOccurrenceId: occurrence.stableIdentifier,
    snoozeEventId: previouslyPersistedID ?? UUID(),
    occurredAt: occurrence.date,
    legacyPurchaseReference: verifiedLegacyTransactionID,
    clientAppVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
)
```

Persist `pending.snoozeEventId` before the network request and clear it only after a definite
server response. A client-generated event can still be fabricated on a modified device; full
tamper resistance requires later App Attest/DeviceCheck and stronger Apple-side event/purchase
evidence.

## Sign in with Apple

The backend currently deploys email/password and the `ADMINS` group. Do not show an Apple button
until real Apple/Cognito provider configuration exists. To enable:

1. create the Apple App ID/Services ID/key and enable Sign in with Apple;
2. store the Apple private key/client secret using Amplify secret references;
3. add real Cognito callback/logout URLs and the Apple provider to
   `amplify/auth/resource.ts`;
4. redeploy and copy the new `amplify_outputs.json`;
5. add the Sign in with Apple capability to the Xcode target;
6. use Amplify Auth's web UI/federated sign-in flow;
7. after success, run the same Cognito-sub/RevenueCat migration above.

Apple credentials and RevenueCat webhook secrets never belong in Xcode build settings or the app
bundle.
