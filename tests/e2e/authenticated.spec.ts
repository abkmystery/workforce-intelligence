import { expect, test } from "@playwright/test";

const token = process.env.E2E_AUTH_TOKEN;
const orgName = process.env.E2E_ORG_NAME || "";
const workerCode = process.env.E2E_WORKER_CODE || "";
const scheduleName = process.env.E2E_SCHEDULE_NAME || "";
const missingExportId = process.env.E2E_MISSING_EXPORT_ID || "";
const identityId = process.env.E2E_IDENTITY_ID || "";
const compensationId = process.env.E2E_COMPENSATION_ID || "";
const identitySentinel = process.env.E2E_IDENTITY_SENTINEL || "";
const salarySentinel = process.env.E2E_SALARY_SENTINEL || "";

test.skip(!token, "Run with tests/e2e/run-authenticated.ts and its isolated PostgreSQL fixture.");

test('a manager can flag a report for roles, remove and restore consideration, without an employee request', async ({ page, context }) => {
  const managerToken = process.env.E2E_MANAGER_TOKEN!;
  const cookie = (value: string) => ({ name: '__Host-wi_session', value, domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' as const });
  await context.addCookies([cookie(managerToken)]);
  await page.goto('/workspace/redeployment?date=2026-10-02');
  await expect(page.getByRole('heading', { name: 'People needing a role', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /Add person needing a role/ }).click();
  const form = page.getByRole('dialog', { name: 'Create People needing a role' });
  await form.getByRole('combobox', { name: 'Organization', exact: true }).fill(orgName);
  await form.getByRole('option').filter({ hasText: orgName }).click();
  await form.getByRole('combobox', { name: /Person/ }).fill('E2E-PROTECTED');
  await form.getByRole('option').filter({ hasText: 'E2E-PROTECTED' }).click();
  await form.getByLabel(/Why a new role is needed/).fill('Synthetic project ending');
  await form.getByLabel(/Available from/).fill('2026-11-01');
  await form.getByLabel(/Place before/).fill('2026-12-01');
  await form.getByLabel(/Location/).fill('Chicago');
  await form.getByLabel(/Work mode/).selectOption('hybrid');
  await expect(form.getByLabel('Consider for internal roles')).toHaveValue('true');
  await form.getByRole('button', { name: 'Save record' }).click();
  await expect(form).toBeHidden();
  await expect(page.getByRole('button', { name: 'Synthetic project ending', exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Find matches', exact: true }).click();
  await page.getByRole('combobox', { name: /Team request/ }).fill(process.env.E2E_NEED_CODE!);
  await page.getByRole('option').filter({ hasText: process.env.E2E_NEED_CODE! }).click();
  const response = page.waitForResponse(r => r.url().includes('/api/matches?'));
  await page.getByRole('button', { name: 'Find matches', exact: true }).click();
  expect((await response).ok()).toBeTruthy();
  const result = page.getByRole('row').filter({ hasText: 'E2E-PROTECTED' });
  await expect(result).toContainText('All required skills have current verified evidence');
  await expect(result).toContainText('Available by the requested start');
  await expect(result).toContainText('Salary permission required');
  const payload = await (await response).text();
  expect(payload).not.toContain(identitySentinel);
  expect(payload).not.toContain('999999');
  await expect(page.getByRole('link', { name: 'Scenarios', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Budgets', exact: true })).toHaveCount(0);

  const placement = JSON.parse(payload).candidates[0];
  const initial = await (await page.request.get(`/api/records/redeployments/${placement.placementId}`)).json();
  await context.addCookies([cookie(process.env.E2E_RESTRICTED_TOKEN!)]);
  const denied = await page.request.post('/api/records/redeployments', { headers: { Origin: new URL(page.url()).origin }, data: { operation: 'UPDATE', id: placement.placementId, version: initial.version, data: { considerForRoles: false } } });
  expect(denied.status()).toBe(403);
  expect(await denied.text()).not.toContain(identitySentinel);
  await context.addCookies([cookie(managerToken)]);

  await page.getByRole('link', { name: 'People needing a role', exact: true }).click();
  await page.getByRole('button', { name: 'Stop considering Synthetic project ending for internal roles', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Consider Synthetic project ending for internal roles', exact: true })).toBeVisible();
  await page.getByLabel('Consideration for internal roles').selectOption('false');
  await expect(page.getByRole('button', { name: 'Synthetic project ending', exact: true })).toBeVisible();
  const counts = await (await page.request.get('/api/planning-overview?date=2026-10-02')).json();
  expect(counts.metrics.find((metric: { label: string }) => metric.label === 'People considered for roles').value).toBe(0);

  await page.goto('/workspace/matches?date=2026-10-02');
  await page.getByRole('combobox', { name: /Team request/ }).fill(process.env.E2E_NEED_CODE!);
  await page.getByRole('option').filter({ hasText: process.env.E2E_NEED_CODE! }).click();
  await page.getByRole('button', { name: 'Find matches', exact: true }).click();
  await expect(page.getByText(/No visible people are flagged for consideration/)).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'E2E-PROTECTED' })).toHaveCount(0);

  await page.getByRole('link', { name: 'People needing a role', exact: true }).click();
  await page.getByRole('button', { name: 'Consider Synthetic project ending for internal roles', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop considering Synthetic project ending for internal roles', exact: true })).toBeVisible();
  const restored = await (await page.request.get(`/api/matches?requestId=${JSON.parse(payload).requestId}&date=2026-10-02`)).json();
  expect(restored.candidates.map((candidate: { workerId: string }) => candidate.workerId)).toEqual([placement.workerId]);
  const history = await (await page.request.get(`/api/history/redeployments/${placement.placementId}`)).json();
  expect(history.rows.map((row: { data: { considerForRoles: boolean } }) => row.data.considerForRoles)).toEqual([true, false, true]);
  const worker = await (await page.request.get(`/api/records/workers/${placement.workerId}`)).json();
  expect(worker.version).toBe(1);
  expect(worker.data.employmentStatus).toBe('active');
});

test("real session can manage a worker while protected data stays private", async ({ page, context }) => {
  await context.addCookies([{ name: "__Host-wi_session", value: token!, domain: "localhost", path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
  await page.goto("/workspace/workforce", { waitUntil: "domcontentloaded", timeout: 90_000 });
  await expect(page.getByRole("heading", { name: "People & skills", level: 1 })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Loading records" })).toBeHidden({ timeout: 45_000 });

  await page.getByRole("button", { name: /New record/ }).click();
  const create = page.getByRole("dialog", { name: "Create Workforce" });
  await expect(create).toBeVisible();
  await create.getByRole("combobox", { name: "Organization", exact: true }).fill(orgName);
  await create.getByRole("option").filter({ hasText: orgName }).click();
  await create.getByRole("combobox", { name: /Home organization/ }).fill(orgName);
  await create.getByRole("option").filter({ hasText: orgName }).click();
  await create.getByLabel(/Resource code/).fill(workerCode);
  await create.getByLabel(/Worker type/).selectOption("manual-only");
  await create.getByLabel(/Employment status/).selectOption("active");
  await create.getByRole("button", { name: "Save record" }).click();
  await expect(create).toBeHidden();

  await page.getByRole("searchbox", { name: "Search Workforce" }).fill(workerCode);
  await page.getByRole("button", { name: workerCode }).click();
  let detail = page.getByRole("dialog", { name: "View Workforce" });
  await expect(detail.getByText("Version 1")).toBeVisible();
  await detail.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit Workforce" });
  await edit.getByLabel(/Official title/).fill("Synthetic updated title");
  await edit.getByRole("button", { name: "Save record" }).click();
  await expect(edit).toBeHidden();

  await page.getByRole("button", { name: workerCode }).click();
  detail = page.getByRole("dialog", { name: "View Workforce" });
  await expect(detail.getByText("Synthetic updated title")).toBeVisible();
  await detail.getByRole("tab", { name: "History" }).click();
  await expect(detail.getByRole("listitem").filter({ hasText: "Version 2" })).toBeVisible();
  await expect(detail.getByRole("listitem").filter({ hasText: "Version 1" })).toBeVisible();
  await detail.getByRole("button", { name: "Archive" }).click();
  await expect(detail).toBeHidden();

  await page.getByLabel("State").selectOption("archived");
  await page.getByRole("button", { name: workerCode }).click();
  detail = page.getByRole("dialog", { name: "View Workforce" });
  await detail.getByRole("button", { name: "Restore" }).click();
  await expect(detail).toBeHidden();
  await page.getByLabel("State").selectOption("");
  await expect(page.getByRole("button", { name: workerCode })).toBeVisible();

  for (const [domain, id, sentinel] of [["identities", identityId, identitySentinel], ["compensation", compensationId, salarySentinel]] as const) {
    const direct = await page.request.get(`/api/records/${domain}/${id}`);
    expect(direct.status()).toBe(403);
    const deniedBody = await direct.text();
    expect(deniedBody).not.toContain(sentinel);
    expect(deniedBody).not.toContain("stack");
    const listing = await page.request.get(`/api/records/${domain}?date=2026-09-26`);
    expect(listing.ok()).toBeTruthy();
    expect(await listing.text()).not.toContain(sentinel);
  }
  await page.goto("/workspace/identity", { waitUntil: "domcontentloaded" });
  expect(await page.content()).not.toContain(identitySentinel);
  await page.goto("/workspace/cost", { waitUntil: "domcontentloaded" });
  expect(await page.content()).not.toContain(salarySentinel);
});

test("a scheduled report can be configured and its notification opens an explicit download", async ({ page, context }) => {
  await context.addCookies([{ name: "__Host-wi_session", value: token!, domain: "localhost", path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
  await page.goto("/workspace/reports", { waitUntil: "domcontentloaded", timeout: 90_000 });
  await expect(page.getByRole("heading", { name: "Reports", level: 1 })).toBeVisible();
  await page.getByRole("tab", { name: "Scheduled reports" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Loading records" })).toBeHidden({ timeout: 45_000 });
  await page.getByRole("button", { name: /New record/ }).click();
  const create = page.getByRole("dialog", { name: "Create Scheduled reports" });
  await create.getByLabel(/^Name/).fill(scheduleName);
  await create.getByLabel("Export domain").selectOption("workers");
  await create.getByRole("combobox", { name: "Organization filter" }).fill(orgName);
  await create.getByRole("option").filter({ hasText: orgName }).click();
  await create.getByLabel("Format").selectOption("csv");
  await create.getByLabel("Repeat every (hours)").fill("24");
  await create.getByLabel("Enabled").selectOption("true");
  await create.getByRole("button", { name: "Save record" }).click();
  await expect(create).toBeHidden();
  await expect(page.getByRole("button", { name: scheduleName })).toBeVisible();

  await page.getByRole("tab", { name: "Tasks and notifications" }).click();
  const notification = page.getByRole("row").filter({ hasText: "Synthetic scheduled report ready" });
  await expect(notification).toBeVisible();
  const storedRequests: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname === `/api/exports/${missingExportId}`) storedRequests.push(request.url()); });
  await notification.getByRole("link", { name: "Open report" }).click();
  await expect(page.getByRole("heading", { name: "Stored report" })).toBeVisible();
  expect(storedRequests).toHaveLength(0);
  await page.getByRole("button", { name: "Download stored report" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Report unavailable" })).toBeVisible();
  expect(storedRequests).toHaveLength(1);

  await page.goto("/workspace/reports", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Tasks and notifications" }).click();
  const unread = page.getByRole("row").filter({ hasText: "Synthetic scheduled report ready" });
  await unread.getByRole("button", { name: "Mark read" }).click();
  await expect(unread.getByText("Read", { exact: true })).toBeVisible();
});
