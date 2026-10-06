# Workforce Intelligence

An internal workforce planning application focused on retaining people through redeployment: people needing a role, teams needing people, explainable matches and reviewed internal moves. The user narrowed the product on October 2; [product scope](docs/PRODUCT_SCOPE.md) replaces the original enterprise contract. **Ready for synthetic core workflow testing.** Permanent transfers and the request-to-match-to-transfer browser journey are implemented and verified. Live tenant sign-in and deployment are not production-accepted. See [implementation matrix](IMPLEMENTATION_MATRIX.md) for observed checks and remaining work.

## Local setup

Node.js 22.12+ (tested host: 24.13), PostgreSQL 17+ with pgcrypto and btree_gist. Use a dedicated non-owner, non-superuser, non-BYPASSRLS runtime role. No authentication bypass exists.

1. `npm ci`
2. `docker compose up -d db` (or an independently provisioned PostgreSQL).
3. Copy .env.example to .env.local and configure local URLs. Shell scripts need env vars explicitly set or use `node --env-file=.env.local --import tsx scripts/migrate.ts`.
4. Run `npm run migrate` with MIGRATION_DATABASE_URL set to the migration login; DATABASE_URL must use workforce_app.
5. Provision an authorized tenant via `node --env-file=.env.local --import tsx scripts/bootstrap.ts` with BOOTSTRAP_TENANT_ID and BOOTSTRAP_TENANT_NAME. Follow [Entra guide](docs/ENTRA.md).
6. Run `npm run dev -- --experimental-https` for Secure cookies with APP_URL=https://localhost:3000. Register that exact callback in Entra.
7. Run the worker separately. It rechecks the current principal and scoped grants.

Synthetic fixture: set ALLOW_SYNTHETIC_SEED=true and run `npm run seed`. It creates a separate explicitly synthetic tenant; it does not create a demo web session. Never set these fixture controls against a real tenant.

## Verification

Run `npm run test:ready` for route types, typecheck, lint, unit tests, isolated native PostgreSQL integration, production build and authenticated Chrome acceptance. See [test the retention workflow](docs/TESTING.md). Individual commands remain available; `npm run test:integration` requires a migrated synthetic TEST_DATABASE_URL, while `npm run test:postgres` provisions one automatically. Run the build before standalone `npm run test:e2e`.

Tests skipped for a missing database are not passes. Current evidence is in [verification](docs/VERIFICATION.md). Runtime notes and unresolved acceptance items are in [continuation](NEXT_TASK.md).

## Structure

- src/lib/registry.ts: bounded domain fields shared by CRUD/forms/templates.
- src/lib/records.ts and workflows.ts: policy checks, dates, transactions and approvals.
- src/lib/graph: actual read-only transport, durable sync and separate group/manager paths.
- src/lib/imports: CSV/XLSX parser, preview binding, commit and reversal.
- src/worker.ts: PostgreSQL durable jobs, actor recheck, bounded retries.
- migrations: append-only deployment history; never edit an applied migration.

The typed SQL layer is deliberately small: pg, parameterized queries, explicit domain functions and PostgreSQL constraints. There is one application and one worker; no broker, cache service or microservice layer.

[User guide](docs/USER_GUIDE.md) · [Import guide](docs/IMPORTS.md) · [Architecture/security](docs/ARCHITECTURE.md) · [Calculation glossary](docs/CALCULATIONS.md)
