# Security review — October 25, 2026

This is a focused source and dependency review before publishing the repository. It is not a penetration test, an independent audit, or approval to use real employee data.

## What was inspected

Server authentication and session handling, shared request parsing, domain authorization, tenant SQL context, CRUD/history, protected data separation, audit metadata, import/export boundaries, worker identity checks, response headers, local configuration, CI and tracked Git history were inspected. Legacy modules were sampled; this was not an exhaustive review of every route or workflow.

Controls present in the inspected code:

- Tenant-specific Microsoft Entra OIDC, an explicit tenant allowlist, PKCE, state, nonce and signed ID-token verification. Browser login transactions are single use.
- Random opaque session cookies with Secure, HttpOnly, SameSite=Lax and __Host- attributes. The database stores token hashes. Disabled accounts, expired sessions and authorization-version changes deny access.
- Server checks for domain, operation, organization/reporting scope, current grant dates and data class. Identity and compensation occupy separate domains/tables. Role names do not independently authorize access.
- Parameterized SQL values, registry-controlled SQL identifiers and a transaction-local tenant setting for PostgreSQL row-level security. The runtime login must not own tables or bypass RLS.
- Same-origin checks on mutations, no-store API responses, anti-framing and MIME-sniffing headers, and separately authorized salary comparisons.
- Scoped transfer approvals, optimistic versions and database locks. Moving protected metadata requires explicit scope-transfer permissions and does not imply permission to read its values.
- CSV formula neutralization, bounded spreadsheet parsing, private export storage checks, owner/permission rechecks and expiring export artifacts.
- Worker jobs reload the principal and effective grants. Inspected audit writes contain identifiers and operation metadata rather than direct names or salary amounts.

## Changes made in this review

The previous production dependency audit reported one critical and five high package findings. Next.js was updated to 16.4.3, Zod to 4.6.7, and compatible transitive packages were refreshed. Vitest was updated within version 4 to 4.1.12.

Azure Identity is deliberately pinned to 4.13.0, which uses MSAL Node 3, outside the reported MSAL 5–7.0.2 authorization-code advisory range. Its UUID dependency is overridden to the compatible CommonJS version 11.1.1 or later within major 11. MSAL's inspected use is uuid.v4(). Revisit the pin when a compatible Azure Identity release uses a patched MSAL line. Live Azure credential behavior is still unverified.

Shared JSON parsing now rejects oversized declared bodies before reading and cancels chunked bodies once they exceed 128,000 bytes. It checks actual UTF-8 bytes rather than trusting Content-Length. Regression tests cover exact limits, understated lengths, chunked cancellation, malformed JSON and misleading content types.

The unit-test command now quotes its exclusion globs. On Linux, shell expansion previously let integration files run before the CI database role was provisioned. CI now names Ubuntu 24.04 explicitly rather than changing operating systems with ubuntu-latest. The failed October 6 run remains a failed run; it is not counted as successful validation.

The environment template now includes tenant bootstrap fields, removes an unused redirect variable and uses the export container setting read by the implementation. The README explains setup and current limitations, and SECURITY.md provides a private reporting route.

## Remaining concerns before production

1. **Live identity acceptance is outstanding.** Verify the real Entra callback, assigned roles, scoped grants, revocation and session expiry in an authorized test tenant. Synthetic IdP tests do not establish this. Role-only external changes are picked up at sign-in; existing sessions can last eight hours. Group grants require a fresh entitlement snapshot.
2. **Ingress limits are required.** The shared API wrapper limits authenticated requests, but there is no comprehensive pre-authentication sign-in throttle. Multipart imports are parsed before their file-size check, and some separate admin/import/export JSON paths do not use the shared bounded reader. Set request-body limits, timeouts and rate limits at the ingress before exposing a deployment.
3. **Error disclosure needs a broader pass.** Import handlers and stored row/job failures can expose ordinary Error messages. Some may contain database or parser details. Normalize unexpected errors and review row-level error payloads before using sensitive imports. The shared API wrapper already replaces unexpected errors with a generic response.
4. **CSP still permits inline scripts/styles.** The current headers reduce several browser risks but are not a nonce-based strict Content Security Policy. A nonce rollout needs rendering and browser acceptance; it was not added as a cosmetic config change.
5. **Infrastructure remains an operator responsibility.** Verify PostgreSQL TLS, private storage, secret management, least-privilege roles, backups/restores and incident access. The Docker runtime currently carries development dependencies to run the TypeScript worker. No live cloud or restore drill was performed here.
6. **Initial permission setup is not self-service.** Bootstrap grants only settings administration. Creating a grant also requires administration over its target domain, which must be provisioned separately. The admin API's operation enum does not yet accept FLAG_FOR_ROLES, TRANSFER_SCOPE or stage-specific APPROVE operations. Synthetic tests provision these directly; a new real tenant cannot reproduce the core workflow solely through the current access form. Complete controlled grant provisioning and this form/API coverage before a real-user pilot, without granting implicit access to identity or salary.
7. **Legacy routes still exist.** Hiding them from navigation does not remove their attack surface. Restrict their domain grants and review them before enabling them for a tenant. Large-population performance and full accessibility acceptance are also outstanding.

## Publication checks and evidence

A targeted pattern scan of the original reachable commit inspected 162 text blobs (excluding the dependency lockfile) for private keys, common provider tokens and assigned credentials. A follow-up checked all 166 working source/document files. Candidate matches were reviewed: blank environment fields, README placeholders and an explicit synthetic auth-test secret. No real credential was identified. No tracked environment file other than .env.example, private key, database dump or local database directory was found. This is a limited pattern/manual check, not a guarantee that every secret format can be detected. Public Git history includes the author's existing name and commit email.

After the dependency changes, npm audit reported zero advisories across production and development dependencies. This describes the advisory database at review time; it does not prove the application is free of vulnerabilities. Final executed test results and any blocked checks are recorded in [IMPLEMENTATION_MATRIX.md](../IMPLEMENTATION_MATRIX.md).

References: [Next.js image optimization advisory](https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw), [Next.js cache advisory](https://github.com/vercel/next.js/security/advisories/GHSA-673q-mjm6-r5xr), [MSAL advisory](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5). The remaining limits above come from repository inspection, not from an external certification.
