# Implementation matrix

Active scope is [internal redeployment and retention](docs/PRODUCT_SCOPE.md), per the user's October 2 correction. The original enterprise contract is superseded. **Ready for synthetic core workflow testing; production acceptance remains unverified.**

## October 25 publication review

README and local sign-in setup rewritten; bounded streaming JSON parsing added with regression coverage; Linux unit-test exclusion quoting corrected; security dependency updates and a focused [security review](docs/SECURITY_REVIEW.md) added. No product modules were added. Initial access provisioning still requires controlled database setup: bootstrap does not confer other domain administration, and the access form/API does not yet support all planning/transfer operations.

Observed failures: the October 6 GitHub run failed in its unit step because integration files were included before runtime-role creation; subsequent steps were skipped. The first local unit attempt on October 25 was blocked by sandbox EPERM renaming Vitest temporary files; 17 suites could not load and no tests ran. These are not passes.

Final October 25 validation: clean `npm ci` completed. The full `npm run test:ready` completed with exit 0: route type generation, TypeScript and lint passed; unit **87 tests /18 files passed (39.04s)**; isolated PostgreSQL integration **79 tests /11 files passed (23.84s)** with migrations001-012 applied and replayed; the Next.js16.4.3 production build passed; HTTPS Chrome **5/5 passed (1.1m)**, followed by graceful database shutdown and runner success. No database tests were skipped. A fresh full `npm audit --json` after the clean install reported **zero advisories**, including development dependencies. The Azure credential module also loaded successfully with the UUID override; no live credential/token request was tested. Documentation links and `git diff --check` passed. Current source/history pattern checks found no real credentials in the reviewed candidates. Docker/Bicep builds were not run locally in this review; the new GitHub CI run must be assessed separately. No live employee data, Entra sign-in, cloud deployment, external penetration test or restore drill was used or claimed.

| Active requirement | Current implementation | Remaining scope/limits |
|---|---|---|
| Simple workforce planning | Five primary destinations and three supporting destinations; real scoped counts; complete core browser journey | Manual user feedback; new overview/matching load not benchmarked |
| People needing a role | Manager/HR flag, toggle and filter; dated permissions/history; person-code labels; receiving manager can reflag a placed person | Broader screen-reader/responsive acceptance |
| Teams needing people | Reason, role, FTE/headcount, dates, location/work mode, optional annual salary cap/currency and inline required skills | Existing skill edits use the Request skills tab |
| Explainable matches | Skills/date/location/FTE evidence; salary separately protected; candidate membership/order independent of hidden salary; guided proposal action | Aggregate skill gaps; currency/hourly/daily evidence requires review |
| Approved internal moves | Permanent dated team/primary allocation/manager changes, approved fulfillment, consideration clearance, protected metadata relocation and independent approvals; no automatic source return | Conflicting allocations, leave/constraints, future home-record revisions or insufficient confirmed contract coverage require revised proposals; no payroll/Entra writeback |
| Supporting data and permissions | People/skills/roles/teams, imports, server-authenticated grants, independent protected data classes and audited history | Live Entra/tenant setup, cloud deployment and operational acceptance |

October3 current-source gates: **typecheck, lint and production build passed**; unit **82 tests /17 files passed (50.54s)**; native PostgreSQL **79 tests /11 files passed (51.35s)** with migrations001-012 applied/replayed; built-app HTTPS Chrome **5/5 passed (1.2m)** and runner exit0 after graceful shutdown. The latest typecheck/lint rerun also passed after browser fixture/stability adjustments. Browser coverage now creates a need with required skills and salary cap, approves it, finds a restricted-salary match, proposes the transfer, uses four distinct scoped approvers and explicitly commits. It verifies dated home/assignment changes, unchanged employment, cleared consideration, no protected payload and completed approval progress.

Native transfer coverage adds12 cases: dated history and old/new manager access, an ended source assignment, part-time FTE, finite need/employment end dates, reflagging by the receiving manager, denied protected-scope rollback, scope-only permission without identity/pay READ, stale placement versions, future pay revision rollback, concurrent proposals and atomic required-skill creation. Protected values remain unchanged and audit metadata excludes identity/pay values. Test and browser clusters now remove themselves after stopping; load fixtures remain retained. `npm run test:ready` orchestrates the gates; [testing instructions](docs/TESTING.md) cover setup, permissions and known proposal limits.

Earlier attempts in this slice are preserved as failures: one native audit assertion queried the wrong column (fixed); one build rejected a non-UTF-8 character (normalized); browser runs4/5 first exposed global role filtering, then a missing governance-class fixture grant, then an asynchronous loading deadline under concurrent shared-fixture runs. Global role lookup was fixed in the app, the fixture class corrected without relaxing policy, and browser cases now run with one worker and wait for the actual dated record response. A full disk also blocked browser database initialization; only stopped synthetic clusters created by this work were cleaned, and automatic bounded cluster cleanup was added. No failing or skipped run is counted as a pass. No live employee/tenant/cloud data was used.

Latest October2 manager/HR flag slice: **typecheck, lint and production build passed**; unit **82/17 passed (67.70s)**; native PostgreSQL **67/10 passed (24.55s)**, migrations001–012 applied/replayed, graceful shutdown exit0; built-app HTTPS Chrome **4/4 passed (30.9s)**. The browser uses a genuine reports-scoped manager and a genuine restricted HR-labelled session; it verifies creation without an employee request, denial without FLAG_FOR_ROLES, removal from matches/counts, restoration, history and unchanged employment. All browser specs now run in the same built-app synthetic harness. An earlier run3/4 failed due a newly ambiguous partial-label locator; made exact, then reran all4 successfully. No live employee data, Entra tenant or cloud deployment was tested.

New native role-consideration tests prove a manager can flag a report without an employee request, HR can remove consideration, ordinary CRUD/HR labels cannot toggle or archive a considered record, reports/org scope prevents out-of-scope flags, date-effective reflagging does not apply early, optimistic races are rejected, manager changes use the decision-date relationship, dated detail/reference reads enforce the selected-date scope, and unflagged records cannot be enabled without FLAG_FOR_ROLES. Flagging changes no worker employment record, identity or salary. Existing published records lacking the new field retain consideration without rewriting historical data.

The new native matching tests verify scoped candidates, guessed request denial, cross-tenant RLS, hidden salary invariance, audit redaction, verified skill expiry, exclusive placement deadlines, future revisions and immutable placement-person links. Matching does not mutate employment or automatically commit a move. Annual pay comparisons cover annual/monthly/weekly base pay and full-time normalization; hourly/daily pay and currency conversion remain review-needed.

## Legacy compatibility evidence

The following historical table is retained as evidence about existing code. Its enterprise requirements are **outside the active product scope**, not mandatory pending release work. Existing hidden routes/data are retained for compatibility. Historical tests and unresolved defects do not establish current product completion. In particular, the old capacity dashboard's October 1 p95 3,790ms failed its 3,000ms budget; the new planning overview is a different query and has not had a sustained load benchmark. Scheduled-report future-effective/final freshness defects remain known legacy defects.

| ID | Contract | Requirement | Code / endpoint / UI | Migration | Tests | Observed status / remaining work |
|---|---|---|---|---|---|---|
| NAV | 2 | Navigation, real data routes, tables, filters, CRUD/history | src/components; src/app/workspace; src/app/api/records | 001 | tests/ui-navigation.test.tsx | Partial; keyboard/state checks pending; richer trees, heatmaps and saved-view application outstanding |
| MODEL | 4 | Separate tenant-scoped entities, stable opaque worker ID, effective revisions | src/lib/registry.ts; records.ts; migrations/001_core.sql | 001,004 | tests/integration/core.test.ts | Core PostgreSQL invariants passed; dated constraints/history still need additional edge cases |
| POLICY | 6,7,17 | Deny by default, data-class and org/manager grant scope | src/lib/policy.ts; auth.ts; records.ts | 001,002 | tests/policy.test.ts; tests/auth.test.ts | Unit tests passed; HTTP/SQL adversarial matrix incomplete |
| SSO | 5 | Tenant allowlist, PKCE/state/nonce, signed OIDC token, secure sessions | src/lib/auth.ts; src/app/api/auth | 001,002 | tests/auth.test.ts | Fake-IdP RSA contract tests passed; live tenant unverified |
| GROUP | 6 | Group/app-role mapping, revocation, sensitive independent approval | src/lib/graph/admin-access.ts; worker.ts; api/admin | 001,002 | tests/graph-entitlements.test.ts | Partial; group contracts passed, admin UI end-to-end pending |
| GRAPH | 5 | Read-only Graph delta, paging, retry, replay, checkpoint, 410 reset | src/lib/graph/client.ts; sync.ts; worker.ts | 002 | tests/graph.test.ts | 50k synthetic contract test passed; real Graph unverified |
| POP | 5,15 | Population filters and actual worker/identity projection | src/lib/graph/project.ts; api/admin | 002 | tests/integration/graph.test.ts | Synthetic projection integration passed; employeeId source projection and full population acceptance remain |
| MANAGER | 5,10 | Independent manager refresh and dated reporting lines | src/lib/graph/managers.ts; worker.ts; reporting-lines registry | 001,002,005 | tests/graph-managers.test.ts; tests/integration/graph.test.ts | Durable cursor and cleanup implemented; focused tests passed, native suite passed these cases; live app-only permissions unresolved, raw observations latest-only |
| CRUD | 8 | Manual people and every domain create/update/archive/restore | src/lib/records.ts; components/records-workspace.tsx | 001 | tests/integration/core.test.ts | Core database CRUD/history passed; all-domain journeys, compare/merge and advanced UX outstanding |
| OWNER | 8,15 | Field ownership, provenance, overrides, reconciliation | records.ts; graph/ownership.ts; registry.ts | 001,002 | tests/graph-ownership.test.ts; tests/integration/field-policies.test.ts | Scoped/date-effective policies, approved directory overrides and expiry sweep implemented and tested; non-directory upstream owners incomplete |
| TEMPLATE | 9 | Versioned CSV/XLSX dictionary and synthetic template library | src/lib/imports/format.ts; api/imports/templates | 003 | tests/imports*.test.ts | Parser/template tests passed; every template business journey still needs acceptance coverage |
| IMPORT | 9 | Validate/preview/queue/commit/reverse, sparse semantics and locks | src/lib/imports/service.ts; semantics.ts; worker.ts | 003 | tests/imports*.test.ts | Partial; multi-sheet coordination, large-file streaming, blob staging and sensitive approval remain required |
| ORG | 10 | Arbitrary-depth dated hierarchy, manager scope, no cycles | registry.ts; records.ts; policy.ts | 001 | tests/integration/core.test.ts; reporting.test.ts | Cycles, subtree and manager scope passed; historical reference correction in validation; merge/split/orphan workflows outstanding |
| TAXONOMY | 11 | Title vs hired-for vs actual role; skills/evidence | registry.ts; generic CRUD/import UI | 001 | No full acceptance coverage yet | Persistent paths exist; role-specific journeys and expiration workbench pending |
| CAPACITY | 11 | Decimal-safe FTE, leave, unique headcount and unknown capacity | math.ts; reporting.ts; api/overview | 001 | tests/math.test.ts; tests/integration/reporting.test.ts | Unit and real SQL as-of calendar/holiday/permission tests passed; full period heatmaps and broader grant scopes incomplete |
| DEMAND | 12 | Demand types, approval stages, fulfillment, hiring pipeline | workflows.ts; registry.ts; api/actions | 001 | No full acceptance coverage yet | Partial; funding/seat de-dup, attachments and delegation remain required |
| MOBILITY | 13 | Approved temporary loans and permanent retention transfers | workflows.ts; transfers.ts | 001 | workflows.test.ts; transfers.test.ts; transfer.spec.ts | Loan regression and permanent dated/permission/concurrency acceptance passed. Legacy full cost-allocation planning remains outside active scope |
| SCENARIO | 13 | Fork/deltas/baseline/compare/commit isolation | workflows.ts; scenario tables | 001 | tests/integration/workflows.test.ts | Freshness/commit transaction test passed; complete snapshot isolation, graphics and fiscal comparisons required |
| FINANCE | 14 | Restricted pay, annualization, burden, FX, budgets | finance.ts; math.ts; registry.ts; api/finance | 001 | tests/math.test.ts; tests/integration/finance.test.ts | Partial month-start forecast; supporting permissions, fiscal year and historical FX corrected. Full period, allocations and anti-differencing incomplete |
| HRIS | 14,15 | Replaceable HRIS/payroll connector contracts | Not implemented | — | Missing | Required implementation gap; no live provider claimed |
| REPORT | 16 | Scoped reports/export, saved views and schedules | reporting.ts; imports/service.ts; imports/artifacts.ts; registry.ts | 001,003,006 | tests/integration/imports.test.ts | Direct exports plus private stored export/download implemented; synthetic owner/expiry/grant/hash tests passed in native suite. Scheduling/catalog incomplete; live Blob unverified |
| AUDIT | 7,16 | Append-only audit hash chain; scoped view and restricted read logging | audit.ts; api/audit; schema | 001 | No full acceptance coverage yet | Partial; non-tenant audit scope and durable external hash anchoring incomplete |
| PRIVACY | 7 | Reveal approval/expiry, retention/legal hold/deletion/subject access | workflows.ts revealIdentity; registry.ts | 001 | Missing full suite | Partial; privacy execution and retention jobs required |
| JOBS | 3,18 | Durable worker, retries/dead-letter/actor recheck | src/worker.ts; jobs.ts | 001 | Integration execution pending | Imports/Graph worker paths; schedules, replay UI and job health incomplete |
| SECURITY | 17 | CSRF, no-store, rate limits, CSP, RLS, upload limits | http.ts; auth.ts; next.config.ts; migrations | 001–008 | Unit contracts, native RLS, import origin/ZIP bounds | Native unfiltered tenant isolation, empty-context denial and cross-tenant write denial passed after008. Production dependency audit clean. Nonce CSP, external scan, comprehensive headers/leakage E2E required |
| AZURE | 3,18 | Docker, CI, Azure IaC, private storage, Key Vault, telemetry, restore | Dockerfile; .github/workflows/ci.yml; infra/container-apps.bicep; docs/AZURE.md | — | YAML parses; image/Bicep not compiled locally | App/worker deployment against existing secured base resources authored. Docker/Azure compiler unavailable; no cloud deployment or full base-resource provisioning claimed |
| LOAD | 18 | 100k workforce, 50k Graph, import and restricted-query performance | scripts/load.ts; Graph tests | 007,008 | npm run load rerun in progress | 50k synthetic Graph passed. September27 tenant paging failed p95=5,298ms; dashboard15s timeout; concurrent case not reached. Effective-query/RLS/join fixes under measurement with unchanged budgets; broader load acceptance incomplete |
| ACCESSIBILITY | 2,18 | WCAG 2.2 AA, keyboard and responsive workflows | UI + tests/e2e | — | tests/e2e/unauthenticated.spec.ts | Chrome redirect/keyboard/axe serious-critical check passed; authenticated/responsive full WCAG acceptance incomplete |
| OPERATIONS | 18,20 | Health/readiness, recovery, documentation, runbooks | api/health; api/ready; docs | — | Pending | Partial; backup/restore drill and operational acceptance incomplete |

## Mandatory acceptance tests

| AC | Requirement | Test path | Observed result |
|---|---|---|---|
| 1 | Manual worker stable ID/history/link | tests/integration/core.test.ts | Database stable-ID/history test passed; complete manual-to-Entra link journey incomplete |
| 2 | Entra renames and nonworker exclusions | tests/graph.test.ts | Delta contract passed; projection cases incomplete |
| 3 | SSO tenant/roles/groups and mapping UI | tests/auth.test.ts | RSA fake-IdP passed; UI/real tenant unverified |
| 4 | No cross-org/tenant/name/pay leaks on every surface | tests/policy.test.ts; tests/integration/core.test.ts | Pure policy passed; comprehensive HTTP/jobs/export tests incomplete |
| 5 | Measured group/app-role revocation | tests/graph-entitlements.test.ts | Replacement/revocation contract passed; live SLA measurement pending |
| 6 | 50k Graph paging/retry/resume/410/managers | tests/graph.test.ts; tests/graph-managers.test.ts; tests/integration/graph.test.ts | Synthetic paging and manager durable-resume tests passed; live app-only manager access unresolved |
| 7 | Owner conflicts/override expiry | tests/graph-ownership.test.ts; tests/integration/graph.test.ts; field-policies.test.ts | Scoped directory ownership and expiry tests passed; other upstream adapters incomplete |
| 8 | Every one-off and CSV/XLSX template journey | tests/imports*.test.ts | Parser/template suite passed; per-template integration/E2E required |
| 9 | Sparse blank/CLEAR/0/false/duplicates | tests/imports.test.ts; imports-service.test.ts | Focused parser/semantics tests passed |
| 10 | Salary/stale/hash/race/idempotency/modes/reversal | tests/integration/core.test.ts; imports.test.ts | Real transaction race/preview/reversal tests passed; full salary approval/mode matrix incomplete |
| 11 | Org/manager history cycles/orphans | tests/integration/core.test.ts; reporting.test.ts; graph.test.ts | Cycle/scope/history tests passed; orphan/merge/split coverage missing |
| 12 | 0.4 + 0.6 one person / one FTE | tests/math.test.ts; tests/integration/core.test.ts | Math and PostgreSQL allocation race test passed; broader reporting journey incomplete |
| 13 | 2.0 demand – 0.5 fulfillment = 1.5 and leave | tests/math.test.ts | Pure math passed; full dated workflow pending |
| 14 | Vacancy/backfill/hire de-dup | Missing integrated acceptance test | Required |
| 15 | Loan source loss/destination gain/payroll transfer | tests/math.test.ts; tests/integration/workflows.test.ts | Loan transaction and dated provenance regression passed; full pay allocation journey incomplete |
| 16 | Scenario versions/isolation/authorized fresh commit | tests/integration/workflows.test.ts | Stale baseline/commit transaction test passed; full acceptance still incomplete |
| 17 | Compensation/FX/proration/suppression/differencing | tests/math.test.ts | Formula tests passed; integrated privacy tests incomplete |
| 18 | Exports/schedules/audit/reveal/reconciliation/simulator | Missing complete integrated acceptance test | Partial implementation; required coverage |
| 19 | Accessible workflows/build/deployment runbook | tests/e2e; npm run build | September27 production build and authenticated worker/protected-data journey passed; final harness/current-source rerun pending. Full accessibility/acceptance and cloud runbook unexecuted |
| 20 | Honest measured load/security/integration evidence | docs/VERIFICATION.md | In progress |

## Environment-only items

- Authorized Entra app registration, tenant assignment, secrets/certificate/managed identity, and Graph application consent are not supplied. No live directory was accessed.
- Azure subscription, deployment resource names, domain/TLS configuration, and approved production secrets are not supplied. No Azure deployment was performed.
- Docker engine and Azure CLI/Bicep compiler are unavailable on this host. Native PostgreSQL 18.4 now runs synthetic migration/integration checks, including RLS under a non-superuser runtime role.

## Recorded commands

- npm install --ignore-scripts --cache .local/npm-cache --no-audit --no-fund --fetch-retries=0: **passed**, 363 packages; cold network installation took 46 minutes.
- npm test -- --reporter=dot: **passed**,14 files /68 tests,31.07s (September27); October1 owner security edits require aggregate rerun.
- npm run typecheck: earlier passed; latest attempt failed TS1128 in corrupt generated .next/dev/types/validator.ts. Regeneration/current-source rerun pending.
- npm run lint: earlier passed; latest root/security slices need final aggregate rerun.
- npm run test:postgres: **44/44 passed**,7 files,66.68s (October1), migrations001–008 applied/replayed; graceful exact-cluster shutdown and exit0. Subsequent integration/import owner edits need rerun.
- npm run test:e2e -- --reporter=line: **1/1 passed**, unauthenticated Chrome redirect/keyboard/axe,47.7s. Authenticated production Chrome **1/1 passed**,11.6s, genuine secure session and isolated native PG; final cleanup/current source rerun pending.
- npm run build: **passed September27** after effective-query/index fixes, before latest finance/security changes; final rerun required.
- npm audit --omit=dev --audit-level=moderate --cache .local/npm-cache: **passed**, zero production vulnerabilities.
- Docker info: **failed**, unavailable engine. Bicep compiler absent; neither deployment artifact is claimed executed.

See NEXT_TASK.md and docs/VERIFICATION.md for later evidence. Update this table after each accepted slice.
