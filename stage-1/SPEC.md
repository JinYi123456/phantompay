# Stage 1 — Core Wallet & Transfers

An in-memory double-entry ledger exposed as an HTTP JSON API. Every unit of
value is moved, never created or destroyed. Built with **zero runtime
dependencies** on Node.js >= 20, so it builds and serves from a clean
container with no outbound network.

## Run

```bash
npm start                     # listens on 0.0.0.0:8080
PORT=3000 npm start           # custom port
docker compose up --build     # or via Docker
```

No `npm install` is required - there are no dependencies.

## API

### Health & operations
| Method | Path       | Description                                    |
|--------|------------|------------------------------------------------|
| GET    | `/health`  | Liveness, stage, uptime, ledger statistics      |
| GET    | `/metrics` | Prometheus text format (counters + gauges)      |
| GET    | `/ledgers` | List ledgers                                    |
| POST   | `/ledgers` | Create a ledger (201, 409 on duplicate id)      |

### Accounts
| Method | Path                      | Description                                     |
|--------|---------------------------|-------------------------------------------------|
| GET    | `/accounts?ledgerId=`     | List accounts, optional ledger filter           |
| POST   | `/accounts`               | Create an account (201)                         |
| GET    | `/accounts/:id`           | Account with exact balance                      |
| GET    | `/accounts/:id/balances`  | `{ balance, version, updatedAt }`               |

Account fields: `id?`, `ledgerId?` (default `main`), `currency` (ISO-style,
`/^[A-Z][A-Z0-9]{2,7}$/`), `name?`, `type?` (`user` or `house`),
`direction?` (`debit` normal for users, `credit` normal for house),
`metadata?`. User accounts can never go negative; house accounts may
(representing funds held outside the ledger).

### Transfers
| Method | Path                 | Description                                        |
|--------|----------------------|----------------------------------------------------|
| POST   | `/transfers`         | Commit a transfer (201) or replay it (200)         |
| POST   | `/transfers/batch`   | Atomic all-or-nothing batch (201), max 100 items   |
| GET    | `/transfers`         | Commit-order listing: `limit`, `offset`, `accountId`, `from`, `to` |
| GET    | `/transfers/:id`     | Fetch one transaction (404 if unknown)             |

Transfer body: `externalId` (client idempotency key), `sourceAccountId`,
`destinationAccountId`, `amount` (decimal units, at most 3 dp,
currency-precision enforced, never rounded), `metadata?`,
`expectedSourceVersion?` (optimistic concurrency), `ledgerId?`.

## Invariants (enforced and tested)

1. **Conservation** - signed balances of all accounts sum to exactly zero
   after every accepted operation.
2. **No double spend** - transfers that would overdraw a user account are
   rejected with 409 `insufficient_funds`.
3. **Idempotency** - replaying the same `externalId` with the same payload
   returns the original transaction (200, `idempotentReplay: true`) and
   moves nothing; the same id with a different payload is 409
   `external_id_conflict`. Replays are detected before funds checks.
4. **Exact math** - BigInt minor units internally; string-parsed amounts;
   no binary floating point ever touches money; requests exceeding the
   currency's precision are rejected with 422 `amount_precision`.
5. **Optimistic concurrency** - `expectedSourceVersion` mismatches yield
   409 `version_conflict`.
6. **Atomic batches** - all-or-nothing with cumulative funds simulation
   across items; a failing item writes nothing.

## Error envelope

```json
{ "error": { "code": "insufficient_funds", "message": "...", "requestId": "req_..." } }
```

Codes: `invalid_request`, `invalid_currency`, `invalid_amount`,
`amount_precision`, `amount_overflow`, `invalid_external_id`,
`external_id_conflict`, `same_account`, `currency_mismatch`,
`cross_ledger_transfer`, `version_conflict`, `insufficient_funds`,
`invalid_batch`, `batch_too_large`, `ledger_not_found`, `ledger_exists`,
`account_not_found`, `account_exists`, `transaction_not_found`,
`invalid_json`, `payload_too_large`, `not_found`, `internal_error`.

## Seeded demo data

`house:clearing`, `house:treasury` (house, credit-normal) and users
`user:alice` (100.00), `user:bob` (50.00), `user:carol` (25.00),
`user:dave` (75.00) in USD.

## Verification

```bash
npm test   # 30 tests: unit + API + concurrency + chaos
```

- 100 racing spends of a 100.00 balance consume exactly 100.00.
- 50 parallel duplicate POSTs produce exactly one 201 and 49 idempotent
  replays with the same transaction id.
- 100 parallel competing 1.00 spends of a 75.00 balance never overdraw.
- A chaos sweep proves rejected operations leave zero trace.
