# Azure Container Apps operations

This repository deploys one image as two Azure Container Apps: a public HTTPS Next.js web app on container port 3000 (minimum one, maximum three replicas) and an ingress-free PostgreSQL worker (one replica). The worker runs `node --conditions=react-server --import tsx src/worker.ts`. The image runs as a non-root Linux user. The Bicep file provisions only these two apps; it accepts resource IDs for an existing secured Container Apps environment, PostgreSQL flexible server, private Blob account, Key Vault, and user-assigned identity. It does not create those base resources, network links, identities, registry, secrets, DNS, certificates, backups, or role assignments.

## Before either environment is deployed

Use separate staging and production resource groups, PostgreSQL servers, Key Vault secrets, Entra registrations, and tenant data. The Container Apps environment needs egress and private DNS to its PostgreSQL flexible server, Key Vault, and Blob account. The Blob account should have private access, soft delete, and versioning. Pre-create a private `workforce-exports` container (or pass `exportContainerName` to Bicep); grant the user-assigned identity **Storage Blob Data Contributor** at the narrowest supported scope. Set a lifecycle rule to delete stored export objects after the 24-hour application download expiry, allowing for lifecycle evaluation delay. Set the identity's **AcrPull** grant on the registry and **Key Vault Secrets User** grant on the vault. The worker's Graph application still authenticates with a client secret; the managed identity is for registry, Key Vault, and Blob access. Confirm the registry login server matches the image reference. Allow the deployment principal to create/update Container Apps in the target resource group.

Create three Key Vault secrets with versionless URI support: `workforce-database-url`, `workforce-entra-client-secret`, and `workforce-graph-client-secret` (or pass alternative secret names to Bicep). `workforce-database-url` must point to the **runtime** PostgreSQL role, with TLS and certificate validation, and is shared by web and worker. The runtime role must be a login role that is **not** table owner, superuser, or `BYPASSRLS`; grant only the schema/table/sequence privileges needed by `scripts/migrate.ts`. Keep a distinct migration role and connection URL outside both Container Apps. The migration account must own or have DDL privileges; never put its URL in app secrets.

Configure the HTTPS origin, Entra tenant/client IDs, web redirect URI `${APP_URL}/api/auth/callback`, and separate Graph application as described in [ENTRA.md](ENTRA.md). The app registration's OIDC secret goes only to the web app; the read-only Graph secret goes only to the worker. Tenant bootstrap and administrator grants are controlled database operations. No demo account or automatic first administrator exists. Because `APP_URL` must match the public origin, bind a custom domain and TLS certificate before enabling sign-in if the generated Container Apps FQDN is not the intended origin. Follow the [Container Apps custom domain guide](https://learn.microsoft.com/en-us/azure/container-apps/custom-domains-certificates).

## CI and release

`.github/workflows/ci.yml` runs typecheck, lint, unit tests, PostgreSQL 17 migrations twice, integration tests under a non-owner/non-bypass role, the Next.js build, Chrome E2E tests, a production dependency audit, Docker build, and Bicep compilation. The PostgreSQL and role passwords in CI are synthetic, scoped to that ephemeral service, and never reused outside CI. A green CI run validates the build and synthetic checks; it does not establish Azure connectivity or a successful production Entra sign-in. The deployment pipeline must record an immutable image digest, approval, migration checksum, and the exact parameters used for each environment.

Build and push one image per commit, then promote its immutable digest. A release operator can use a secured runner with Docker and Azure CLI:

```bash
export ACR_LOGIN_SERVER='<registry>.azurecr.io'
export GIT_SHA='<commit-sha>'
docker build -t "$ACR_LOGIN_SERVER/workforce-intelligence:$GIT_SHA" .
docker push "$ACR_LOGIN_SERVER/workforce-intelligence:$GIT_SHA"
# Resolve and record the pushed sha256 digest in the registry before deployment.
export IMAGE="$ACR_LOGIN_SERVER/workforce-intelligence@sha256:<digest>"
```

From a runner that can reach the private PostgreSQL server, take a verified recovery point, provide `MIGRATION_DATABASE_URL` through the runner's secret facility, and apply migrations **before** deploying the image. `npm run migrate` checks prior migration hashes and refuses changed applied files. Review forward compatibility first: a database migration can outlive an image rollback.

```bash
npm ci
npm run migrate
npm run migrate  # idempotency/checksum check
```

Deploy staging first with parameter values for its own resources. Run `what-if` and have an operator review it before `create`. This example shows the required parameters; use the same command with production values only after staging acceptance. Do not paste secret values into deployment parameters.

```bash
export RESOURCE_GROUP='<staging-resource-group>'
export ENV_ID='<existing-container-apps-environment-resource-id>'
export POSTGRES_ID='<existing-postgresql-flexible-server-resource-id>'
export BLOB_ID='<existing-private-storage-account-resource-id>'
export KEYVAULT_ID='<existing-key-vault-resource-id>'
export IDENTITY_ID='<existing-user-assigned-identity-resource-id>'
export IDENTITY_CLIENT_ID="$(az identity show --ids "$IDENTITY_ID" --query clientId -o tsv)"
export APP_URL='https://<staging-hostname>'
export ENTRA_TENANTS='<comma-separated-tenant-guids>'
export ENTRA_CLIENT_ID='<web-client-guid>'
export GRAPH_CLIENT_ID='<graph-client-guid>'
PARAMS=(environmentResourceId="$ENV_ID" postgresServerResourceId="$POSTGRES_ID" blobStorageAccountResourceId="$BLOB_ID" keyVaultResourceId="$KEYVAULT_ID" userAssignedIdentityResourceId="$IDENTITY_ID" userAssignedIdentityClientId="$IDENTITY_CLIENT_ID" registryLoginServer="$ACR_LOGIN_SERVER" image="$IMAGE" appUrl="$APP_URL" entraAllowedTenants="$ENTRA_TENANTS" entraClientId="$ENTRA_CLIENT_ID" graphClientId="$GRAPH_CLIENT_ID" webAppName='workforce-web-stg' workerAppName='workforce-worker-stg')
az deployment group what-if -g "$RESOURCE_GROUP" -f infra/container-apps.bicep --parameters "${PARAMS[@]}"
az deployment group create -g "$RESOURCE_GROUP" -f infra/container-apps.bicep --parameters "${PARAMS[@]}"
```

For production, set production resource IDs, host, registration IDs, and app names. Keep the same tested image digest. Confirm the web FQDN and current revisions with `az containerapp show -g "$RESOURCE_GROUP" -n "$WEB_APP" --query properties.configuration.ingress.fqdn -o tsv` and `az containerapp revision list -g "$RESOURCE_GROUP" -n "$WEB_APP" -o table`. Check the login redirect, a denied unauthorized API request, one authorized scoped read, a queued worker job, and audit/job records using synthetic or approved data. Watch both app logs with `az containerapp logs show -g "$RESOURCE_GROUP" -n "$WEB_APP" --follow` and the worker equivalent. Alert on repeated worker failures, dead jobs, stale Graph entitlements, database connection failures, Key Vault reference failures, and replica readiness failures. The web probes check TCP readiness; they do not prove PostgreSQL or Entra health.

## Rollback and secret rotation

Keep the previous **image digest** and Bicep parameter set. If the new revision fails but the database schema remains backward compatible, redeploy the previous digest by setting `IMAGE` to that digest and repeating `az deployment group what-if` and `az deployment group create` with the same environment parameters. The apps use single-revision mode: Container Apps switches the web revision after the replacement becomes ready; the worker remains one replica. Verify both revision states and run the same smoke checks. Do not downgrade schema by editing an applied migration or assuming image rollback reverses data changes. Escalate to restore when the data or schema itself must be recovered.

The Key Vault references use versionless secret URLs. After rotating a Key Vault value, check both apps' resolved configuration and restart the active revision if the new value has not propagated. Azure documents automatic pickup of a newer version within about 30 minutes, with restarts for environment-variable references. Rotate OIDC/Graph credentials in their registrations and Key Vault as a coordinated change; verify staging first. Never print connection strings or client secrets in logs. See [Container Apps secret references](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets) and [revision operations](https://learn.microsoft.com/en-us/azure/container-apps/revisions-manage).

## Backup and restore drill

Before production release, confirm PostgreSQL flexible server backup retention, availability zone/geo policy, and the latest available restore point in Azure. Document an RPO/RTO target and run a staging recovery drill at least quarterly. A point-in-time restore creates a **new server**; it does not overwrite the source. From a secured Azure CLI session, use a time within the configured retention period:

```bash
export SOURCE_SERVER_ID='<existing-postgresql-flexible-server-resource-id>'
export SOURCE_SERVER_NAME="${SOURCE_SERVER_ID##*/}"
export RESTORE_NAME='workforce-restore-<unique-suffix>'
export RESTORE_UTC='2026-09-24T18:20:22Z'
az postgres flexible-server show -g "$RESOURCE_GROUP" -n "$SOURCE_SERVER_NAME" --query '{retentionDays:backup.backupRetentionDays,geoRedundancy:backup.geoRedundantBackup}' -o json
az postgres flexible-server backup list -g "$RESOURCE_GROUP" -s "$SOURCE_SERVER_NAME" -o table
az postgres flexible-server restore -g "$RESOURCE_GROUP" -n "$RESTORE_NAME" --source-server "$SOURCE_SERVER_ID" --restore-time "$RESTORE_UTC"
az postgres flexible-server show -g "$RESOURCE_GROUP" -n "$RESTORE_NAME" --query '{state:state,fqdn:fullyQualifiedDomainName}' -o json
```

Attach the restored server to the staging private network and DNS, create a least-privilege runtime login if needed, and set a **staging-only** Key Vault database URL to the restored server. Restart the staging web and worker revisions. From the secured runner, inject a migration-role `RESTORE_DATABASE_URL` for schema inspection and a runtime-role `DRILL_DATABASE_URL` for a separate role check:

```bash
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'SELECT name, sha256 FROM schema_migrations ORDER BY name;'
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'SELECT count(*) AS tenants FROM tenants; SELECT count(*) AS audit_events FROM audit_events;'
psql "$DRILL_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;'
```

Verify a representative scoped read, job backlog behavior, and audit continuity in the staging application. Record measured recovery time, data gap, and any missing linked Blob objects. Do not run the drill against production traffic. Blob recovery is separate: enable and test soft delete/versioning or point-in-time restore on the existing private account before relying on it. Stored export bytes live in private Blob storage; export metadata lives in PostgreSQL. Direct exports and imports remain buffered in the application. See [PostgreSQL backup and restore](https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/concepts-backup-restore), [flexible-server restore CLI](https://learn.microsoft.com/en-us/cli/azure/postgres/flexible-server?view=azure-cli-latest), and [Blob versioning](https://learn.microsoft.com/en-us/azure/storage/blobs/versioning-enable).

Current limits: the template does not provision private endpoints, WAF/front door, private DNS, Key Vault secrets/RBAC, ACR, PostgreSQL, Blob, monitoring alerts, storage lifecycle rules, or automated database backups. Graph scheduling and Blob-backed import storage remain unfinished; stored export Blob access is implemented but not verified against a live account. The audit hash chain lacks external anchoring, so this deployment does not claim independently verified tamper evidence. Production acceptance requires an authorized Azure deployment, a real Entra sign-in and revocation test, an observed worker restart, and the restore drill above.
