"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { navItemFor, navigation } from "./navigation";

export function WorkspaceShell({ children, actorLabel }: { children: React.ReactNode; actorLabel: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const search = useSearchParams();
  const [open, setOpen] = useState(false);
  const slug = pathname.split("/")[2] || "overview";
  const selected = navItemFor(slug);
  const date = search.get("date") || new Date().toISOString().slice(0, 10);
  const orgId = search.get("orgId") || "";

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(search.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page");
    router.replace(`${pathname}?${next.toString()}`);
  }

  const filterQuery = search.toString();
  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${open ? "open" : ""}`} aria-label="Main navigation">
        <Link href="/workspace/overview" className="brand" onClick={() => setOpen(false)}>
          <span className="brand-mark" aria-hidden="true">WI</span>
          <span className="brand-text"><strong>Workforce</strong><small>Intelligence</small></span>
        </Link>
        <nav>
          {navigation.map((group) => (
            <div className="nav-group" key={group.label}>
              <p className="nav-label">{group.label}</p>
              {group.items.map((item) => (
                <Link
                  key={item.slug}
                  className={`nav-link ${slug === item.slug ? "active" : ""}`}
                  href={`/workspace/${item.slug}${filterQuery ? `?${filterQuery}` : ""}`}
                  aria-current={slug === item.slug ? "page" : undefined}
                  onClick={() => setOpen(false)}
                >
                  <span className="nav-icon" aria-hidden="true">{item.label.charAt(0)}</span>
                  <span>{item.short || item.label}</span>
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer"><span>Signed in as</span><strong>{actorLabel}</strong><button type="button" onClick={logout}>Sign out</button></div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <div className="topbar-start">
            <button className="btn mobile-menu" type="button" aria-label="Open navigation" onClick={() => setOpen(!open)}>☰</button>
            <div>
              <div className="eyebrow">Workforce intelligence</div>
              <div className="breadcrumb" aria-label="Breadcrumb"><span>Workspace</span><span aria-hidden="true">/</span><span>{selected?.label || "Workspace"}</span></div>
            </div>
          </div>
          <div className="filterbar" aria-label="Global filters">
            <label className="filter-control"><span>As of</span><input aria-label="As of date" type="date" value={date} onChange={(event) => setFilter("date", event.target.value)} /></label>
            <label className="filter-control"><span>Org ID</span><input aria-label="Organization ID filter" placeholder="All organizations" value={orgId} onChange={(event) => setFilter("orgId", event.target.value)} /></label>
          </div>
        </header>
        <main id="main-content" className="content">{children}</main>
      </div>
      {open && <button type="button" aria-label="Close navigation" className="drawer-backdrop" style={{ zIndex: 20, border: 0 }} onClick={() => setOpen(false)} />}
    </div>
  );
}
