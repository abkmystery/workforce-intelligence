# Local setup

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

Bootstrap gives the assigned account access to Administration. It does not grant workforce planning, identity, salary or administration rights over other domains. Initial domain-administration grants still need controlled database provisioning. The admin form also does not yet cover every transfer-specific operation; see the [security review](SECURITY_REVIEW.md#remaining-concerns-before-production). `NO_ACCESS_GRANTS` means the account authenticated but has no effective application grant. More detail is in the [Entra guide](ENTRA.md).

When testing queued imports or directory jobs, start the worker in another terminal:

```powershell
node --env-file=.env.local --conditions=react-server --import tsx src/worker.ts
```

Graph and private Azure export storage are optional integrations. Neither is needed for the first sign-in. See the [import guide](IMPORTS.md) and [deployment notes](AZURE.md) before configuring them.
