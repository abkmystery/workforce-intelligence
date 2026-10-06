import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import LoginPage from "../src/app/login/page";
import { navigation } from "../src/components/navigation";
import { modules } from "../src/components/module-config";
import { actionsFor } from "../src/components/records-workspace";
import { referenceDomainFor } from "../src/components/reference-picker";
import { safeWorkspaceHref } from "../src/components/safe-workspace-link";

describe("workspace navigation", () => {
  it("centers navigation on internal retention without enterprise finance and HR catalogs", () => {
    const slugs = navigation.flatMap(group => group.items.map(item => item.slug));
    expect(slugs).toEqual(['overview', 'redeployment', 'demand', 'matches', 'mobility', 'workforce', 'hr-import-center', 'admin']);
    expect(modules.demand.domains).not.toContain('hiring-pipeline');
    expect(modules.redeployment.domains).toEqual(['redeployments']);
  });
  it("has a working view configuration for every navigation destination", () => {
    const slugs = navigation.flatMap((group) => group.items.map((item) => item.slug));
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(modules[slug]).toBeDefined();
  });

  it("offers the real Entra sign-in entry point", () => {
    const html = renderToStaticMarkup(<LoginPage />);
    expect(html).toContain('href="/api/auth/login"');
    expect(html).toContain("Continue with Microsoft Entra");
  });

  it("exposes only actions supported at each approval stage", () => {
    expect(actionsFor("scenarios", "scenarios", "draft")).toEqual(["submit", "compare", "fork"]);
    expect(actionsFor("scenarios", "scenarios", "submitted")).toContain("approve");
    expect(actionsFor("scenarios", "scenarios", "approved")).toContain("commit");
    expect(actionsFor("movements", "mobility", "approved")).toEqual(["commit", "cancel"]);
    expect(actionsFor("reveals", "governance", "approved")).toEqual(["reveal", "revoke"]);
    expect(actionsFor("scenarios", "scenarios", "draft")).not.toContain("simulate");
  });

  it("maps common business references to searchable domains", () => {
    expect(referenceDomainFor("demands", "roleId")).toBe("roles");
    expect(referenceDomainFor("workers", "homeOrgId")).toBe("org-units");
    expect(referenceDomainFor("movements", "sourceAssignmentId")).toBe("assignments");
  });

  it("exposes report notifications with only local workspace links", () => {
    expect(modules.reports.domains).toContain("notifications");
    expect(safeWorkspaceHref("/workspace/exports?exportId=123")).toBe("/workspace/exports?exportId=123");
    expect(safeWorkspaceHref("/workspace/../admin")).toBeNull();
    expect(safeWorkspaceHref("/workspace/%2e%2e/admin")).toBeNull();
    expect(safeWorkspaceHref("https://example.invalid/workspace/exports")).toBeNull();
    expect(safeWorkspaceHref("javascript:alert(1)")).toBeNull();
  });
});
