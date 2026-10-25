# Test the retention workflow

From the repository directory, run:

```powershell
npm run test:ready
```

This generates route types, checks TypeScript and lint, runs unit and native PostgreSQL integration tests, builds the app, and runs Chrome against the built app. It stops on a failing check. Node 22.12+ and installed dependencies are required. The browser harness uses installed Chrome; on this Windows host it also uses Git's bundled OpenSSL for a local HTTPS certificate.

The database and browser runners create fresh loopback-only PostgreSQL clusters with synthetic records and a non-superuser, non-BYPASSRLS app login. The browser uses real opaque database sessions with separate scoped principals. No live tenant, employee records, Entra credentials, production demo login or authentication bypass is used. The runners stop their own clusters after the checks. Browser failure artifacts remain in `test-results`. Stopped test databases are removed automatically; set `KEEP_SYNTHETIC_TEST_DATABASES=true` only when you need to inspect one after a run. Load fixtures and reports are retained.

For individual checks, use `npm test`, `npm run test:postgres`, `npm run build`, then `npm run test:e2e`. The PostgreSQL runner executes the integration suite without skipped database tests and applies/replays the migrations. `npm run test:integration` requires an already migrated synthetic `TEST_DATABASE_URL`.

## What the browser journey exercises

1. An authorized manager flags a person for internal roles without an employee request. A separate HR-labelled account with ordinary editing rights cannot change consideration without `FLAG_FOR_ROLES`.
2. A team creates a request, specifying a role, reason, dates, location/work mode and required skills in the same form. Salary budget and currency are optional.
3. Independent reviewers approve the request. Matching shows verified skill evidence, availability, location and FTE. Salary remains restricted without separate read permission.
4. A reviewer selects **Propose transfer**, chooses the receiving manager and supplies the date and reason. The server captures assignment, person, consideration and request versions.
5. Four distinct principals complete the existing source-manager, destination-manager, HR and Finance stages. The creator cannot approve their own proposal. Tenant-configured stages remain supported.
6. An authorized committer explicitly commits the approved proposal. The person, primary assignment and manager change on that date; the earlier view stays intact. The person remains employed, leaves consideration, and has no scheduled return to the old team. Protected identity/pay values are absent from the response.

Native tests additionally check unchanged protected values, old/new manager access, part-time FTE, finite request/employment dates, stale versions, rollback on denied permissions, future pay revisions, concurrent commits and prevention of duplicate fulfillment.

## Testing with your own configured tenant

Follow the [local setup](../README.md#run-locally) and [Entra configuration](ENTRA.md). Start with synthetic employees in a test tenant. People, teams, roles, skills, current primary assignments, dated reporting lines and confirmed movable contracts must exist. Supporting assignment, contract and organization pages remain accessible at `/workspace/assignments`, `/workspace/availability` and `/workspace/organization`.

The committer needs explicit scoped permissions for the worker, assignments, reporting lines, fulfillment, request and movement changes, plus `redeployments / FLAG_FOR_ROLES`. Each home-scoped domain also requires `TRANSFER_SCOPE` in both source and destination scopes: identities, directory accounts, external identifiers, contracts, hired-for, worker skills, compensation, reveals and redeployments. Identity domains use the identity class; compensation uses salary, and reveals use governance. `TRANSFER_SCOPE` only permits preserving values while changing scope; it grants no identity/salary read or pay editing access. Sensitive grants follow the existing independent access-approval process. Approvers need proposal/request READ and their specific scoped `APPROVE:<stage>` permission.

Permanent moves transfer the whole primary allocation. Other overlapping committed allocations, approved leave/constraints, future home-record revisions, or contracts that do not cover the employment period require a revised proposal. Finite team needs bound fulfillment; they do not schedule a return. Existing employment end dates remain intact. The workflow changes internal planning records; it does not write to payroll or Entra. Live sign-in, deployment and external-system acceptance remain separate production checks.
