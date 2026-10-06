# Verification evidence

Updated October3,2026 for the user's narrowed [internal retention scope](PRODUCT_SCOPE.md). **Ready for synthetic core workflow testing; live production acceptance remains unverified.** All fixtures were synthetic; no live employee data, Entra directory or cloud deployment was used.

| Current-source check | Observed result | Limits |
|---|---|---|
| Typecheck | Passed after exact corrupt generated-validator cleanup and successful Next typegen | Final source and generated route types included |
| Lint | Passed | No unresolved errors |
| Unit tests | 82/17 passed,67.70s | Does not establish full product acceptance |
| Native PostgreSQL | 67/10 passed,24.55s; migrations001–012 apply/replay; graceful shutdown exit0 | Fresh loopback synthetic DB; NOSUPERUSER/NOBYPASSRLS runtime; no live tenant |
| Production build | Passed | Built artifact; no cloud deployment |
| All Chrome E2E specs | 4/4 passed,30.9s | Built-app HTTPS harness and genuine scoped DB sessions; manager flag/off/on, denied HR-labelled ordinary editor, matching/count/history, unchanged employment, people CRUD/privacy, legacy report route and unauth login redirect/keyboard/axe |

First flag browser run3/4 failed because a partial-label selector matched both the record and the new action button. The selector now matches exactly; all4 specs were rerun successfully. All E2E specs run against one built-app harness rather than creating another dev server. PostgreSQL teardown reported graceful shutdown.

Native role-consideration tests cover manager reports scope, HR org scope, role/CRUD-only denial, out-of-scope denial, date-effective removal/reflagging, history, optimistic versions, publication-date/archival protection and incoming-manager authorization at the decision date. Dated detail/reference reads use their selected date and preserve salary/identity class restrictions. Matching/counts/filters share consideration rules; existing published records missing the field keep their historical consideration without data rewrites.

Existing SQL matching coverage also checks tenant RLS, guessed request denial, exclusive deadlines, verified skill expiry and unchanged candidates/evidence after hidden salary changes. Annual/monthly/weekly base pay is normalized to full-time salary; currency conversion and hourly/daily inputs show review-needed. Flagging/matching does not change employment. October3 permanent transfer commitment and the complete core browser journey passed the checks described below.

## Historical compatibility evidence

The table below retains earlier observations and defects for legacy modules. It is superseded by current-source results above and does not define the active product roadmap.

| Check | Latest observed result | Limits |
|---|---|---|
| Typecheck | Generated types regenerated; latest fails TS2345 at src/lib/auth.ts82/92 | Source typing fix and rerun required |
| Lint | Earlier passed | October1 final changes require aggregate rerun |
| Unit/contract tests | October1:75 tests /15 files passed,18.19s | Focused totals overlap; does not establish full acceptance |
| Native PostgreSQL | October1: migrations001–010 applied/replayed;53 tests /8 files passed,31.56s,exit0 after graceful shutdown | Includes report retry/storage failure/revocation tests; later historical capacity test unrun; schedule future-effective defect identified by review |
| Earlier PostgreSQL baseline | 23/23 passed with migrations001–004 | Superseded by expanded coverage |
| Chrome unauthenticated E2E | 1/1 passed,47.7s; redirect,keyboard,axe serious-critical | Does not establish complete WCAG2.2AA or authenticated journeys |
| Authenticated E2E | September27 production Chrome1/1 passed,11.6s; genuine secure DB session, worker lifecycle, protected identity/pay403 and masked lists | Final harness cleanup/current source need rerun; other acceptance journeys incomplete |
| Production build | September27 passed after effective-query/index changes | Latest finance/security slices require fresh build |
| Production dependency audit | Zero vulnerabilities; `npm audit --omit=dev --audit-level=moderate --cache .local/npm-cache` passed | Point-in-time September26; earlier sandbox network failure was not an audit result |
| Docker / Bicep | CI YAML parsed; deployment sources authored | Docker daemon and local Bicep compiler unavailable; image,template,deployment unverified |

## Load evidence

The first complete synthetic seed contained100,000 workers across111 organization units,200,000 allocations,100,000 contracts,protected identities and pay records,plus creation histories. Native PostgreSQL18.4 ran on Windows,Node24.13.0,Intel i7-1165G7,8 logical CPUs,16GiB RAM. Seeding took399.968s and was excluded from request timings.

Ten warm service/SQL samples per query were planned. Budgets were fixed before measurement:2s p95 paging/search/pay;1s denied-pay;3s dashboard;5s at five concurrent reads. These are local service budgets,not production HTTP/browser/Azure performance claims. With ten nearest-rank samples,p95 equals the maximum observed sample.

The September26 run **failed**: tenant worker paging p50=6,257ms,p95=17,652ms;org paging p50=3,955ms,p95=12,909ms. The run ended before remaining cases. Original effective-row count EXPLAIN read/sorted200k current/history candidates and took9,292.742ms. Disjoint current/history lookup reduced the same-fixture count plan to403.571ms; this isolated plan timing is not a completed benchmark.

The September27 run also **failed**: seed424.860s; tenant paging561/5,298ms p50/p95 versus2s budget. Org20/24ms,subtree462/511ms,reports622/836ms,search51/62ms,restricted pay33/48ms,denied pay11/15ms passed. Dashboard warmup hit15s statement timeout; five-concurrent case not reached. completed=false,passed=false. EXPLAIN showed RLS text casts severely underestimated100k rows, selecting nested worker/contract scans. Migration008 and the holiday join/materialization fix are being measured.

The October1 harness prepares bulk visibility/statistics with VACUUM ANALYZE before warm timings, records warmup/sample errors per case and keeps timestamped reports. Prior failures remain evidence. This preparation change is disclosed; budgets are unchanged.

Latest complete October1 run **failed**, exit1: seed206.697s; p95 tenant189ms,org14ms,subtree120ms,reports188ms,search24ms,restricted pay52ms,denied pay5ms,five concurrent541ms all passed. Dashboard median2,015ms,p95=3,790ms failed the3,000ms budget. All nine cases completed; completed=true,passed=false. Later expression statistics/current-history aggregate/key-preserving query changes have isolated EXPLAIN measurements only; no post-change full benchmark is claimed accepted.

## October3 retention transfer verification

Final application gates passed: typecheck, lint, unit82/17 (50.54s), native PostgreSQL79/11 (51.35s) and production build. Migrations001-012 applied/replayed. Latest authenticated HTTPS Chrome5/5 passed (1.2m), runner exit0, graceful database shutdown and generated-cluster cleanup. Browser test files now include `transfer.spec.ts`; no database/browser test was skipped in these runs. The browser fixture uses actual opaque database sessions and distinct scoped approvers; it does not call a production demo login or bypass authentication. Final typecheck/lint were rerun after the browser harness/test adjustments.

The transfer journey covers inline skills and budget, approved need, matching, proposal, independent approvals, explicit commit, historical/new home-org views, continued active employment, cleared consideration, one continuing destination allocation and completed approval display. Twelve native transfer cases cover dates, part-time eligibility, old/new managers, reflagging, protected-value preservation, scope-only permissions, stale and concurrent proposals, rollback on future pay metadata and denied skill creation. The implementation matrix records earlier failing attempts, disk-space blockage and their repairs. Browser cases run serially against shared fixtures and explicitly await the dated record response; their functional timeout is not a performance benchmark.

`npm run test:ready` runs these gates in order. Individual final reruns provide the current evidence; do not describe earlier failed full-command attempts as successes. Test/native clusters are automatically removed after shutdown unless explicitly retained for inspection. Live providers, cloud deployment, full accessibility and large-population matching remain unverified.

## Remaining acceptance

Full financial period costing and anti-differencing,vacancy/hire de-duplication,scheduled-report execution,privacy execution,full import modes/template journeys,scoped audit,nonce CSP,sustained load,backup/restore drills,and live cloud acceptance remain outstanding. These are historical enterprise gaps, outside the active retention scope. Permanent transfer and core journey acceptance are now covered by the October3 synthetic checks; live production sign-in/deployment, operational, accessibility and load acceptance remain unverified. PRODUCT_SCOPE.md is authoritative; NEXT_TASK.md records the narrowed continuation.
