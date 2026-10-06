# Workforce Intelligence

Read `docs/PRODUCT_SCOPE.md`, `docs/CONTRACTS.md` and `NEXT_TASK.md` before editing. The user's October 2 clarification replaces the original enterprise scope with internal workforce redeployment and retention. Preserve this narrower scope. Do not describe incomplete functionality or unexecuted tests as complete.

Use a Next.js modular monolith, PostgreSQL, explicit parameterized SQL, and a PostgreSQL durable worker. All persisted business records are tenant scoped. Dates use inclusive start/exclusive end. Identity and compensation occupy separate tables and permissions. No production demo login or fabricated dashboard data. Fixtures must be synthetic.

Every public data operation authenticates on the server and enforces domain, operation, org scope, effective date, and data class. Role labels alone are not authorization. Avoid client payload leakage. Audit payloads contain identifiers and operation metadata, not direct identity or salary.

Independent ownership: root owns shared domain registry, database, policy, CRUD/workflows, package/config and integration; integration agent owns Graph/OIDC and their tests; import agent owns import/export parsing and pipeline/tests; UI agent owns components and page UI. Do not overwrite another owner's files. Use shared contracts; communicate changes.

Validation: `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run test:e2e`, `npm run build`. Record actual results, including blocked checks, in IMPLEMENTATION_MATRIX.md. Only claims supported by observed evidence are acceptable.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
