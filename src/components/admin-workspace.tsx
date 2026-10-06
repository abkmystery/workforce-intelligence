"use client";

import { useEffect, useState } from "react";
import { api, isDenied, messageFrom } from "./api";

type AdminSummary = Record<string, unknown>;
type AdminKind = "admin" | "access" | "entra";
const actionSets: Record<AdminKind, { name: string; label: string; help: string; template: Record<string, unknown> }[]> = {
  admin: [
    { name: "settings", label: "Save tenant settings", help: "Update approved tenant configuration.", template: { enabled: false, includeGuests: false, inclusionGroups: [] } },
    { name: "connection-test", label: "Test directory connection", help: "Verify credentials and permissions before a sync.", template: {} },
    { name: "department-mapping", label: "Map department", help: "Connect an Entra department to an organization unit.", template: { department: "", orgId: "" } },
    { name: "mappings", label: "Save group mapping", help: "Map one Entra group to an application role or domain grant.", template: { groupId: "", appRole: null, domain: "workers", operation: "read", dataClass: "planning", orgId: null, scope: "tenant" } },
    { name: "grants", label: "Save access grant", help: "Assign one scoped grant to a principal.", template: { principalId: "", domain: "workers", operation: "read", dataClass: "planning", orgId: null, scope: "tenant", validFrom: new Date().toISOString().slice(0, 10), validTo: null } },
  ],
  entra: [
    { name: "connection-test", label: "Test connection", help: "Check Entra credentials and required permissions.", template: {} },
    { name: "sync", label: "Start sync", help: "Queue a directory synchronization.", template: {} },
    { name: "pause", label: "Pause sync", help: "Pause scheduled synchronization.", template: {} },
    { name: "resume", label: "Resume sync", help: "Resume scheduled synchronization.", template: {} },
    { name: "manager-refresh", label: "Refresh managers", help: "Refresh manager relationships from Entra.", template: {} },
    { name: "group-refresh", label: "Refresh groups", help: "Refresh group based role mappings.", template: {} },
    { name: "department-mapping", label: "Map department", help: "Connect an Entra department to an organization unit.", template: { department: "", orgId: "" } },
    { name: "mappings", label: "Update group mapping", help: "Map one Entra group to an application role or domain grant.", template: { groupId: "", appRole: null, domain: "workers", operation: "read", dataClass: "planning", orgId: null, scope: "tenant" } },
  ],
  access: [
    { name: "grants", label: "Save grant", help: "Assign one scoped grant to a principal.", template: { principalId: "", domain: "workers", operation: "read", dataClass: "planning", orgId: null, scope: "tenant", validFrom: new Date().toISOString().slice(0, 10), validTo: null } },
    { name: "revoke", label: "Revoke grant", help: "Remove one grant or mapping by ID.", template: { grantId: "" } },
    { name: "simulate", label: "Simulate access", help: "Check your effective access for a domain and operation.", template: { domain: "workers", operation: "read", orgId: null, dataClass: "planning" } },
    { name: "mappings", label: "Update group mapping", help: "Connect one Entra group to an application role or domain grant.", template: { groupId: "", appRole: null, domain: "workers", operation: "read", dataClass: "planning", orgId: null, scope: "tenant" } },
  ],
};

function display(value: unknown) { return value === undefined || value === null ? "—" : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value); }

export function AdminWorkspace({ kind }: { kind: AdminKind }) {
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const actions = actionSets[kind];
  const [selected, setSelected] = useState(actions[0].name);
  const [payload, setPayload] = useState(JSON.stringify(actions[0].template, null, 2));
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<unknown>(null);
  useEffect(() => {
    let live = true; setLoading(true); setError(null);
    api<AdminSummary>("/api/admin/settings").then((data) => { if (live) setSummary(data); }).catch((reason) => { if (live) setError(reason); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [revision]);
  const chosen = actions.find((action) => action.name === selected) || actions[0];
  function choose(name: string) { const action = actions.find((item) => item.name === name)!; setSelected(name); setPayload(JSON.stringify(action.template, null, 2)); setOutcome(null); setError(null); }
  async function execute() {
    let body: unknown;
    try { body = JSON.parse(payload); } catch { setError({ message: "Enter valid JSON before sending the request." }); return; }
    setBusy(true); setError(null); setOutcome(null);
    try {
      const response = await api<unknown>(`/api/admin/${selected}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      setOutcome(response); setRevision((value) => value + 1);
    } catch (reason) { setError(reason); } finally { setBusy(false); }
  }
  return <div className="stack">
    {kind === "admin" && <div className="status-strip"><span className="status-dot" />Setup sequence: review tenant settings, test the Entra connection, configure mappings and grants, then start a sync from the Entra page.</div>}
    <section className="panel"><div className="panel-header"><div><h2>{kind === "entra" ? "Directory status" : kind === "access" ? "Current access configuration" : "Tenant configuration"}</h2><span className="hint">Live server state</span></div><button className="btn" type="button" onClick={() => setRevision((value) => value + 1)} disabled={loading}>Refresh</button></div>{loading ? <div className="loading" role="status">Loading administration settings…</div> : error && !summary ? <div className="panel-body"><div className="alert" role="alert"><strong>{isDenied(error) ? "Access denied" : "Administration unavailable"}</strong>{messageFrom(error)}</div></div> : <div className="panel-body"><div className="inline-grid">{Object.entries(summary || {}).map(([key, value]) => <div className="kv-card" key={key}><span className="small-label">{key.replaceAll(/([A-Z])/g, " $1")}</span><div className="code" style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>{display(value)}</div></div>)}</div>{Object.keys(summary || {}).length === 0 && <p className="subtle">No settings have been configured yet.</p>}</div>}</section>
    <section className="panel"><div className="panel-header"><h2>{kind === "admin" ? "Setup actions" : kind === "access" ? "Access controls" : "Directory controls"}</h2></div><div className="panel-body"><div className="wizard-steps" role="group" aria-label="Administrative actions">{actions.map((item) => <button className={`wizard-step ${selected === item.name ? "active" : ""}`} key={item.name} type="button" onClick={() => choose(item.name)}>{item.label}</button>)}</div><div className="form-grid"><div className="field wide"><label htmlFor="admin-payload">{chosen.label} request</label><span className="help">{chosen.help} Submit only reviewed values. The server validates your role and scope.</span><textarea id="admin-payload" value={payload} spellCheck={false} onChange={(event) => setPayload(event.target.value)} style={{ minHeight: 150, fontFamily: "ui-monospace,Consolas,monospace" }} /></div></div>{error !== null && <div className="alert" role="alert" style={{ marginTop: 16 }}><strong>{isDenied(error) ? "Access denied" : "Action failed"}</strong>{messageFrom(error)}</div>}{outcome !== null && <div className="status-strip" role="status" style={{ marginTop: 16 }}>Server response: <span className="code">{display(outcome)}</span></div>}<button className="btn primary" type="button" onClick={execute} disabled={busy} style={{ marginTop: 16 }}>{busy ? "Working…" : chosen.label}</button></div></section>
  </div>;
}

type AuditEntry = { id: string; action: string; domain: string; record_id?: string; actor_id?: string; created_at?: string; metadata?: Record<string, unknown> };
export function AuditWorkspace() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setPage(1); }, 300); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    let live = true; setLoading(true); setError(null);
    const q = new URLSearchParams({ page: String(page), pageSize: "25" }); if (query) q.set("search", query);
    api<{ rows: AuditEntry[]; total: number }>(`/api/audit?${q}`).then((data) => { if (live) { setRows(data.rows); setTotal(data.total); } }).catch((reason) => { if (live) setError(reason); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [page, query]);
  return <section className="panel"><div className="panel-header"><h2>Audit events</h2><span className="hint">{total} events</span></div><div className="table-tools"><label className="sr-only" htmlFor="audit-search">Search audit events</label><input className="search-input" id="audit-search" type="search" placeholder="Search action or domain" value={search} onChange={(event) => setSearch(event.target.value)} /></div>{error ? <div className="panel-body"><div className="alert" role="alert"><strong>{isDenied(error) ? "Access denied" : "Audit unavailable"}</strong>{messageFrom(error)}</div></div> : loading ? <div className="loading" role="status">Loading audit events…</div> : rows.length === 0 ? <div className="empty-state">No audit events found.</div> : <div className="table-wrap"><table className="data-table"><thead><tr><th scope="col">When</th><th scope="col">Action</th><th scope="col">Domain</th><th scope="col">Record</th><th scope="col">Actor</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{row.created_at || "—"}</td><td>{row.action}</td><td>{row.domain}</td><td className="code">{row.record_id || "—"}</td><td className="code">{row.actor_id || "—"}</td></tr>)}</tbody></table></div>}<div className="pagination"><span>{total} events</span><div className="pagination-controls"><button className="btn" type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page}</span><button className="btn" type="button" disabled={page * 25 >= total} onClick={() => setPage(page + 1)}>Next</button></div></div></section>;
}
