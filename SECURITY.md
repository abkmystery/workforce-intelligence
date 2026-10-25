# Security

This project handles workforce planning information. Use synthetic records until your deployment, identity provider and access rules have been verified in a test tenant. The repository's tests are not an independent security audit.

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/abkmystery/workforce-intelligence/security/advisories/new) for this repository. Include the affected commit, a minimal reproduction using synthetic records, and the expected and observed access. Do not put credentials, session cookies, employee details or compensation in a public issue.

Only the current default branch is maintained. There is no promised response time or supported production release yet.

## Running the application

- Keep server secrets in an untracked local environment file or the deployment's secret manager. The example database passwords are for isolated development and CI only.
- Use HTTPS and a PostgreSQL runtime login that cannot own tables, become superuser or bypass row-level security. Keep migration credentials out of the web and worker environments.
- Grant access by domain, operation, organization scope and data class. Planning access does not imply permission to read identity or pay.
- Apply dependency updates and run the checks before deploying. Configure request size limits and throttling at the ingress, including sign-in and multipart upload routes.

See the [review and remaining concerns](docs/SECURITY_REVIEW.md), [Entra setup](docs/ENTRA.md) and [deployment notes](docs/AZURE.md).
