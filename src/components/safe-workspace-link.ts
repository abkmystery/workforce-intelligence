/** Accept only local workspace routes before rendering a record-provided link. */
export function safeWorkspaceHref(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/workspace/") || value.includes("\\")) return null;
  try {
    const url = new URL(value, "https://workforce.invalid");
    if (url.origin !== "https://workforce.invalid" || !url.pathname.startsWith("/workspace/")) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
