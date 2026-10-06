import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("unauthenticated users reach the sign-in screen", async ({ page }) => {
  await page.goto("/workspace/workforce", { waitUntil: "domcontentloaded", timeout: 90_000 });
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  await expect(page.getByRole("heading", { name: "Sign in to your workspace" })).toBeVisible();
  const signIn = page.getByRole("link", { name: /Continue with Microsoft Entra/ });
  await expect(signIn).toHaveAttribute("href", "/api/auth/login");
  await page.keyboard.press("Tab");
  await expect(signIn).toBeFocused();
  const scan = await new AxeBuilder({ page }).analyze();
  expect(scan.violations.filter((item) => ["critical", "serious"].includes(item.impact || ""))).toEqual([]);
});
