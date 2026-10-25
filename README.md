# Workforce Intelligence

I'm building Workforce Intelligence to help companies retain people when their current team's needs change.

It gives HR and managers a place to record people who may need a new role, describe teams' staffing needs, compare the fit, and agree an internal transfer.

A manager or HR partner can flag someone for consideration even if that person has not started looking. The flag does not change their employment, and a match does not make a decision on anyone's behalf.

## How it works

1. **Flag a person for internal roles.** Record the reason, availability, location, working arrangement and any placement deadline. Skills sit on the person's profile.
2. **Describe a team's need.** Add the role, skills, location, dates, capacity and an optional salary budget.
3. **Review possible matches.** See where skills, timing, location and capacity line up, and where evidence is missing. Salary comparisons require separate permission; hidden pay does not affect who appears or their order.
4. **Agree and record the move.** A proposed transfer goes through approvals before someone explicitly commits it. The move has an effective date and a history.

This is an internal workforce planning tool. Payroll writeback, external recruitment and automated redundancy decisions are outside its scope. Some older modules remain in the source for compatibility; the [current product scope](docs/PRODUCT_SCOPE.md) describes the supported direction.

## Where the project stands

The core workflow has synthetic unit, PostgreSQL and browser coverage. Real Microsoft Entra sign-in, live directory connections and a production deployment still need acceptance testing. I would start with a test tenant and synthetic people before considering real employee records.

The [implementation matrix](IMPLEMENTATION_MATRIX.md) records actual checks and known gaps. The [security review](docs/SECURITY_REVIEW.md) covers the controls inspected and the concerns that remain. Neither is a claim of an independent audit or production certification.

## Run locally

You need Node.js 22.12 or later, Docker with Compose (or PostgreSQL 17+), and a Microsoft Entra test tenant where you can register an application. There is no shared demo password or sign-in bypass.

From the repository directory in PowerShell:

```powershell
npm ci
Copy-Item .env.example .env.local
docker compose up -d --wait db
```

### Configure sign-in

In [Microsoft Entra](https://entra.microsoft.com), register a single-tenant **Web** application with this redirect URI:

```text
https://localhost:3000/api/auth/callback
```

Copy the directory tenant ID and application client ID from the registration's Overview. Create a client secret under Certificates & secrets and copy its **Value**, not its secret ID. Enter these in `.env.local`:

```dotenv
APP_URL=https://localhost:3000
ENTRA_ALLOWED_TENANTS=your-directory-tenant-id
ENTRA_CLIENT_ID=your-application-client-id
ENTRA_CLIENT_SECRET=your-client-secret-value
BOOTSTRAP_TENANT_ID=your-directory-tenant-id
BOOTSTRAP_TENANT_NAME=Workforce test
```

The callback is derived from `APP_URL`. Keep the template's database URLs when using the included local Docker database. Those passwords are local development defaults, not deployment credentials. Keep `.env.local` private; Git ignores it.

Create an enabled app role with the value `SecurityAdmin` and member type Users/Groups. Under Enterprise applications, assign that role to your test account. Then initialize the database and start the app:

```powershell
node --env-file=.env.local --import tsx scripts/migrate.ts
node --env-file=.env.local --import tsx scripts/bootstrap.ts
npm run dev -- --experimental-https
```

Open [https://localhost:3000/login](https://localhost:3000/login). Local HTTPS uses a development certificate; secure session cookies require HTTPS.

Bootstrap gives the assigned account access to Administration. It does not grant workforce planning, identity, salary or administration rights over other domains. Initial domain-administration grants still need controlled database provisioning. The admin form also does not yet cover every transfer-specific operation; see the [security review](docs/SECURITY_REVIEW.md#remaining-concerns-before-production). `NO_ACCESS_GRANTS` means the account authenticated but has no effective application grant. More detail is in the [Entra guide](docs/ENTRA.md).

When testing queued imports or directory jobs, start the worker in another terminal:

```powershell
node --env-file=.env.local --conditions=react-server --import tsx src/worker.ts
```

Graph and private Azure export storage are optional integrations. Neither is needed for the first sign-in. See the [import guide](docs/IMPORTS.md) and [deployment notes](docs/AZURE.md) before configuring them.

## Check your changes

```powershell
npm run test:ready
```

This runs type generation, type checking, lint, unit tests, isolated PostgreSQL tests, a production build and Chrome browser tests. Chrome and OpenSSL must be available. The database runners create fresh synthetic databases; they do not need your Entra credentials. They also do not prove that a live Microsoft login works.

For individual commands and a walkthrough of the retention workflow, see [testing](docs/TESTING.md). A skipped test is not a pass.

## Under the hood

One Next.js application, PostgreSQL and a durable PostgreSQL worker. TypeScript, parameterized SQL and database constraints keep the main rules close to the records they protect. There is no separate message broker or service fleet to operate.

Business records are tenant scoped and dated. Identity and compensation have separate storage and permissions. Access checks run on the server; an administrator role does not automatically grant access to names or pay. Audit entries contain record identifiers and operation metadata rather than those protected values.

[User guide](docs/USER_GUIDE.md) · [Architecture](docs/ARCHITECTURE.md) · [Security reporting](SECURITY.md)
