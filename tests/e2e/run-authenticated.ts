import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import next from "next";
import { domains } from "../../src/lib/registry";
import { createIsolatedPostgres } from "../../scripts/isolated-postgres";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No E2E port"));
      server.close(() => resolve(address.port));
    });
  });
}

function opensslCertificate(directory: string): { key: string; cert: string } {
  const openssl = process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\openssl.exe" : "openssl";
  const key = path.join(directory, "localhost.key.pem");
  const cert = path.join(directory, "localhost.cert.pem");
  const result = spawnSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { windowsHide: true, stdio: "ignore" });
  if (result.status !== 0) throw new Error("Could not create the local E2E certificate");
  return { key, cert };
}

function runBrowser(env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--reporter=line", "--workers=1"], { env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

const isolated = await createIsolatedPostgres("e2e");
const tenantId = randomUUID();
const principalId = randomUUID();
const managerPrincipalId = randomUUID();
const managerWorkerId = randomUUID();
const restrictedPrincipalId = randomUUID();
const managerToken = randomBytes(32).toString('base64url');
const restrictedToken = randomBytes(32).toString('base64url');
const orgId = randomUUID();
const fixtureWorkerId = randomUUID();
const roleId = randomUUID();
const skillId = randomUUID();
const needId = randomUUID();
const needCode = "E2E-INTERNAL-NEED";
const identityId = randomUUID();
const compensationId = randomUUID();
const notificationId = randomUUID();
const missingExportId = randomUUID();
const transferWorkerId = randomUUID();
const transferOrgId = randomUUID();
const transferManagerId = randomUUID();
const transferOldManagerId = randomUUID();
const transferTokens = Array.from({length:4}, () => randomBytes(32).toString('base64url'));
const transferCode = 'E2E-TRANSFER-PERSON';
const transferOrgName = 'Synthetic receiving team';
const token = randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(token).digest("hex");
const port = await freePort();
const baseURL = `https://localhost:${port}`;
const orgName = `Synthetic E2E Organization ${randomUUID().slice(0, 8)}`;
const workerCode = `E2E-${randomUUID().slice(0, 8)}`;
const scheduleName = `Synthetic report ${randomUUID().slice(0, 8)}`;
const identitySentinel = `SENSITIVE-IDENTITY-${randomUUID()}`;
const salarySentinel = `SENSITIVE-SALARY-${randomUUID()}`;
// Run the built artifact by default; development mode can be selected for route diagnostics.
const production = process.env.E2E_NEXT_MODE !== "development";
let app: ReturnType<typeof next> | undefined;
let server: ReturnType<typeof createHttpsServer> | undefined;

try {
  const db = isolated.pg.getPgClient("workforce_test", "127.0.0.1");
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("INSERT INTO tenants(id,name,settings) VALUES($1,$2,$3)", [tenantId, "Synthetic E2E tenant", { synthetic: true }]);
    await db.query("INSERT INTO principals(id,tenant_id,entra_object_id,roles,enabled,auth_version) VALUES($1,$2,$3,$4,true,1)", [principalId, tenantId, randomUUID(), JSON.stringify([])]);
    await db.query("INSERT INTO org_units(id,tenant_id,org_id,valid_from,version,state,data) VALUES($1,$2,$1,'2026-01-01',1,'active',$3)", [orgId, tenantId, { code: "E2E-ORG", name: orgName, orgType: "Team" }]);
    await db.query("INSERT INTO workers(id,tenant_id,org_id,valid_from,version,state,data) VALUES($1,$2,$3,'2026-01-01',1,'active',$4)", [fixtureWorkerId, tenantId, orgId, { code: "E2E-PROTECTED", workerType: "manual-only", employmentStatus: "active", homeOrgId: orgId }]);
    await db.query("INSERT INTO principals(id,tenant_id,entra_object_id,roles) VALUES($1,$2,$3,$4),($5,$2,$6,$7)", [managerPrincipalId, tenantId, randomUUID(), JSON.stringify(['Manager']), restrictedPrincipalId, randomUUID(), JSON.stringify(['HR'])]);
    await db.query("INSERT INTO workers(id,tenant_id,org_id,valid_from,data) VALUES($1,$2,$3,'2026-01-01',$4)", [managerWorkerId, tenantId, orgId, { code: 'E2E-MANAGER', workerType: 'manual-only', employmentStatus: 'active', homeOrgId: orgId }]);
    await db.query("INSERT INTO reporting_lines(tenant_id,org_id,worker_id,valid_from,data) VALUES($1,$2,$3,'2026-01-01',$4)", [tenantId, orgId, fixtureWorkerId, { managerId: managerWorkerId, kind: 'primary' }]);
    for (const [domain, operation, scope, root] of [
      ['workers', 'READ', 'reports', managerWorkerId], ['worker-skills', 'READ', 'reports', managerWorkerId], ['org-units', 'READ', 'org', orgId],
      ...['READ', 'CREATE', 'UPDATE', 'FLAG_FOR_ROLES'].map(operation => ['redeployments', operation, 'reports', managerWorkerId]),
      ...['demands', 'request-skills', 'skills', 'roles'].map(domain => [domain, 'READ', 'tenant', null]),
    ]) await db.query("INSERT INTO access_grants(tenant_id,principal_id,domain,operation,data_class,org_id,scope,valid_from,source) VALUES($1,$2,$3,$4,'planning',$5,$6,'2026-01-01','manual')", [tenantId, managerPrincipalId, domain, operation, root, scope]);
    for (const operation of ['READ', 'UPDATE', 'ARCHIVE']) await db.query("INSERT INTO access_grants(tenant_id,principal_id,domain,operation,data_class,org_id,scope,valid_from,source) VALUES($1,$2,'redeployments',$3,'planning',$4,'org','2026-01-01','manual')", [tenantId, restrictedPrincipalId, operation, orgId]);
    for (const [principal, rawToken] of [[managerPrincipalId, managerToken], [restrictedPrincipalId, restrictedToken]]) await db.query("INSERT INTO sessions(tenant_id,principal_id,token_hash,expires_at,auth_version,entitlements_checked_at) VALUES($1,$2,$3,now()+interval '2 hours',1,now())", [tenantId, principal, createHash('sha256').update(rawToken).digest('hex')]);
    await db.query("INSERT INTO identities(id,tenant_id,org_id,worker_id,valid_from,version,state,data) VALUES($1,$2,$3,$4,'2026-01-01',1,'active',$5)", [identityId, tenantId, orgId, fixtureWorkerId, { displayName: identitySentinel, email: "synthetic-secret@example.invalid" }]);
    await db.query("INSERT INTO compensation(id,tenant_id,org_id,worker_id,valid_from,version,state,data) VALUES($1,$2,$3,$4,'2026-01-01',1,'active',$5)", [compensationId, tenantId, orgId, fixtureWorkerId, { amount: 999999, currency: "USD", basis: "annual", burdenPercent: 20, paidFte: 1, source: salarySentinel }]);
    await db.query("INSERT INTO notifications(id,tenant_id,org_id,valid_from,version,state,data) VALUES($1,$2,$3,'2026-01-01',1,'active',$4)", [notificationId, tenantId, orgId, { title: "Synthetic scheduled report ready", link: `/workspace/exports?exportId=${missingExportId}`, recipientId: principalId, read: false }]);
    await db.query("INSERT INTO access_grants(tenant_id,principal_id,domain,operation,data_class,org_id,scope,valid_from,source) VALUES($1,$2,'workers','*','planning',NULL,'tenant','2026-01-01','manual'),($1,$2,'org-units','READ','planning',NULL,'tenant','2026-01-01','manual'),($1,$2,'report-schedules','*','planning',NULL,'tenant','2026-01-01','manual'),($1,$2,'notifications','READ','planning',NULL,'tenant','2026-01-01','manual'),($1,$2,'notifications','UPDATE','planning',NULL,'tenant','2026-01-01','manual')", [tenantId, principalId]);
    await db.query("INSERT INTO roles(id,tenant_id,valid_from,data) VALUES($1,$2,'2026-01-01',$3)", [roleId, tenantId, { name: "Synthetic analyst" }]);
    await db.query("INSERT INTO skills(id,tenant_id,valid_from,data) VALUES($1,$2,'2026-01-01',$3)", [skillId, tenantId, { name: "Synthetic SQL" }]);
    await db.query("INSERT INTO demands(id,tenant_id,org_id,valid_from,state,data) VALUES($1,$2,$3,'2026-01-01','draft',$4)", [needId, tenantId, orgId, { code: needCode, roleId, requestType: "transfer", fte: 1, priority: "normal", businessCase: "Internal retention", fundingStatus: "funded", requesterId: principalId, geography: "Chicago", workMode: "hybrid", expectedStart: "2026-11-01", maxAnnualSalary: 100000, salaryCurrency: "USD" }]);
    await db.query("INSERT INTO request_skills(tenant_id,org_id,valid_from,data) VALUES($1,$2,'2026-01-01',$3)", [tenantId, orgId, { demandId: needId, skillId, required: true }]);
    await db.query("INSERT INTO worker_skills(tenant_id,org_id,worker_id,valid_from,data) VALUES($1,$2,$3,'2026-01-01',$4)", [tenantId, orgId, fixtureWorkerId, { skillId, level: "proficient", verified: true, expiresOn: "2027-01-01" }]);
    for (const domain of ["redeployments", "demands", "request-skills", "worker-skills", "roles", "skills"]) {
      await db.query("INSERT INTO access_grants(tenant_id,principal_id,domain,operation,data_class,scope,valid_from,source) VALUES($1,$2,$3,'*','planning','tenant','2026-01-01','manual')", [tenantId, principalId, domain]);
    }
    await db.query("INSERT INTO sessions(tenant_id,principal_id,token_hash,expires_at,auth_version,entitlements_checked_at) VALUES($1,$2,$3,now()+interval '2 hours',1,now())", [tenantId, principalId, tokenHash]);
    await db.query("INSERT INTO org_units(id,tenant_id,org_id,valid_from,data) VALUES($1,$2,$1,'2026-01-01',$3)", [transferOrgId, tenantId, {code:'E2E-DEST',name:transferOrgName,orgType:'Team'}]);
    for (const [id, org, code] of [[transferWorkerId, orgId, transferCode], [transferOldManagerId, orgId, 'E2E-OLD-TRANSFER-MANAGER'], [transferManagerId, transferOrgId, 'E2E-DESTINATION-MANAGER']])
      await db.query("INSERT INTO workers(id,tenant_id,org_id,valid_from,data) VALUES($1,$2,$3,'2026-01-01',$4)", [id,tenantId,org,{code,workerType:'manual-only',employmentStatus:'active',homeOrgId:org}]);
    const calendarId=randomUUID();
    await db.query("INSERT INTO calendars(id,tenant_id,valid_from,data) VALUES($1,$2,'2026-01-01',$3)",[calendarId,tenantId,{name:'Synthetic weekdays',weekdays:'1,2,3,4,5',hoursPerDay:8}]);
    await db.query("INSERT INTO assignments(tenant_id,org_id,worker_id,valid_from,data) VALUES($1,$2,$3,'2026-01-01',$4)",[tenantId,orgId,transferWorkerId,{roleId,fte:1,allocationStatus:'committed',kind:'primary'}]);
    await db.query("INSERT INTO contracts(tenant_id,org_id,worker_id,valid_from,data) VALUES($1,$2,$3,'2026-01-01',$4)",[tenantId,orgId,transferWorkerId,{fte:1,weeklyHours:40,calendarId,movable:true,confirmedOn:'2026-10-01'}]);
    await db.query("INSERT INTO reporting_lines(tenant_id,org_id,worker_id,valid_from,data) VALUES($1,$2,$3,'2026-01-01',$4)",[tenantId,orgId,transferWorkerId,{managerId:transferOldManagerId,kind:'primary'}]);
    await db.query("INSERT INTO worker_skills(tenant_id,org_id,worker_id,valid_from,data) VALUES($1,$2,$3,'2026-01-01',$4)",[tenantId,orgId,transferWorkerId,{skillId,level:'proficient',verified:true}]);
    await db.query("INSERT INTO redeployments(tenant_id,org_id,worker_id,valid_from,data) VALUES($1,$2,$3,'2026-10-01',$4)",[tenantId,orgId,transferWorkerId,{reason:'Synthetic team closing',considerForRoles:true,availableFrom:'2026-11-01',location:'Chicago',workMode:'hybrid',relocationPossible:false,fte:1}]);
    await db.query("INSERT INTO identities(tenant_id,org_id,worker_id,valid_from,data) VALUES($1,$2,$3,'2026-01-01',$4)",[tenantId,orgId,transferWorkerId,{displayName:'SYNTHETIC transfer protected identity'}]);
    await db.query("INSERT INTO compensation(tenant_id,org_id,worker_id,valid_from,data) VALUES($1,$2,$3,'2026-01-01',$4)",[tenantId,orgId,transferWorkerId,{amount:91234,currency:'USD',basis:'annual',paidFte:1,burdenPercent:20,source:'Synthetic transfer payroll'}]);
    for (const domain of ['assignments','contracts','reporting-lines','movements','fulfillments','calendars','hired-for'])
      await db.query("INSERT INTO access_grants(tenant_id,principal_id,domain,operation,data_class,scope,valid_from,source) VALUES($1,$2,$3,'*','planning','tenant','2026-01-01','manual')",[tenantId,principalId,domain]);
    for (const domain of ['identities','directory-accounts','external-identifiers','compensation','reveals'])
      await db.query("INSERT INTO access_grants(tenant_id,principal_id,domain,operation,data_class,scope,valid_from,source) VALUES($1,$2,$3,'TRANSFER_SCOPE',$4,'tenant','2026-01-01','manual')",[tenantId,principalId,domain,domains[domain].dataClass]);
    for (const [index, stage] of ['source-manager','destination-manager','HR','Finance'].entries()) {
      const principal=randomUUID();
      await db.query("INSERT INTO principals(id,tenant_id,entra_object_id,roles) VALUES($1,$2,$3,'[]')",[principal,tenantId,randomUUID()]);
      for (const domain of ['demands','movements']) await db.query("INSERT INTO access_grants(tenant_id,principal_id,domain,operation,data_class,scope,valid_from,source) VALUES($1,$2,$3,'READ','planning','tenant','2026-01-01','manual')",[tenantId,principal,domain]);
      await db.query("INSERT INTO access_grants(tenant_id,principal_id,domain,operation,data_class,org_id,scope,valid_from,source) VALUES($1,$2,'movements',$3,'planning',$4,'org','2026-01-01','manual')",[tenantId,principal,'APPROVE:'+stage,index===0?orgId:transferOrgId]);
      if(index<2) await db.query("INSERT INTO access_grants(tenant_id,principal_id,domain,operation,data_class,org_id,scope,valid_from,source) VALUES($1,$2,'demands',$3,'planning',$4,'org','2026-01-01','manual')",[tenantId,principal,'APPROVE:'+(index===0?'manager':'HR'),transferOrgId]);
      await db.query("INSERT INTO sessions(tenant_id,principal_id,token_hash,expires_at,auth_version,entitlements_checked_at) VALUES($1,$2,$3,now()+interval '2 hours',1,now())",[tenantId,principal,createHash('sha256').update(transferTokens[index]).digest('hex')]);
    }
    // Seed history as a real create would, so future dated moves retain the pre-transfer view.
    for (const domain of ['workers','identities','compensation','contracts','redeployments','worker-skills','assignments','reporting-lines']) {
      await db.query(`INSERT INTO record_history(tenant_id,domain,record_id,version,snapshot,actor_id) SELECT tenant_id,$2,id,version,jsonb_build_object('id',id,'tenantId',tenant_id,'orgId',org_id,'workerId',worker_id,'validFrom',valid_from,'validTo',valid_to,'version',version,'state',state,'data',data),$3 FROM ${domain.replaceAll('-','_')} WHERE tenant_id=$1`,[tenantId,domain,principalId]);
    }
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { await db.end(); }

  Object.assign(process.env, isolated.env, { APP_URL: baseURL, ENTRA_ALLOWED_TENANTS: tenantId });
  delete process.env.MIGRATION_DATABASE_URL;
  const tls = opensslCertificate(isolated.clusterDir);
  app = next({ dev: !production, dir: process.cwd(), hostname: "localhost", port });
  await app.prepare();
  const handle = app.getRequestHandler();
  server = createHttpsServer({ key: await readFile(tls.key), cert: await readFile(tls.cert) }, (request, response) => { void handle(request, response); });
  await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(port, "localhost", resolve); });
  console.log(`Synthetic authenticated E2E on ${baseURL}`);
  const code = await runBrowser({ ...process.env, E2E_TRANSFER_WORKER_ID: transferWorkerId, E2E_TRANSFER_ORG_ID: transferOrgId, E2E_TRANSFER_ORG_NAME: transferOrgName, E2E_TRANSFER_TOKENS: JSON.stringify(transferTokens), E2E_BASE_URL: baseURL, E2E_AUTH_TOKEN: token, E2E_MANAGER_TOKEN: managerToken, E2E_RESTRICTED_TOKEN: restrictedToken, E2E_ORG_ID: orgId, E2E_ORG_NAME: orgName, E2E_WORKER_CODE: workerCode, E2E_NEED_CODE: needCode, E2E_SCHEDULE_NAME: scheduleName, E2E_MISSING_EXPORT_ID: missingExportId, E2E_IDENTITY_ID: identityId, E2E_COMPENSATION_ID: compensationId, E2E_IDENTITY_SENTINEL: identitySentinel, E2E_SALARY_SENTINEL: salarySentinel });
  process.exitCode = code;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await app?.close();
  // The app's PostgreSQL pool has a 30-second idle timeout. Let it drain before stopping
  // the isolated cluster so normal teardown does not surface forced-connection errors.
  if (app) await new Promise<void>((resolve) => setTimeout(resolve, 31_000));
  await isolated.stop();
}
process.exit(process.exitCode || 0);
