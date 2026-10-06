"use client";



import { useEffect, useMemo, useState } from "react";

import { useSearchParams } from "next/navigation";

import Link from "next/link";

import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type SortingState, type VisibilityState } from "@tanstack/react-table";

import type { DomainDefinition, FieldDefinition, RecordRow } from "@/lib/types";

import { domains } from "@/lib/registry";

import { api, isDenied, messageFrom } from "./api";

import { ReferencePicker, referenceDomainFor } from "./reference-picker";

import { safeWorkspaceHref } from "./safe-workspace-link";

import { consideredForRoles } from '@/lib/role-consideration';



type Page = { rows: RecordRow[]; total: number };

type HistoryEntry = { version: number; action?: string; actorId?: string; actor_id?: string; createdAt?: string; created_at?: string; snapshot?: RecordRow };

type DrawerState = { mode: "create" | "detail" | "edit"; row?: RecordRow } | null;



function serverOwnedField(domain: string, field: string): boolean {

  return (field === "requesterId" && ["demands", "overrides", "reveals"].includes(domain)) ||

    (field === "ownerId" && ["saved-views", "report-schedules"].includes(domain)) ||

    (field === "scenarioVersion" && domain === "scenarios");

}



function visibleFields(domain: string, definition: DomainDefinition) {

  const legacyDemandFields = ['activityId', 'requestType', 'positionId', 'fundingStatus', 'requesterId'];

  if (domain === 'movements') return ['businessCase','demandId','sourceOrgId','destinationOrgId','destinationManagerId','roleId','fte','kind'].map(key => [key, definition.fields[key]] as [string, FieldDefinition]);

  return Object.entries(definition.fields).filter(([key]) => domain !== 'demands' || !legacyDemandFields.includes(key));

}



function newValue(domain: string, key: string, date: string): string | undefined {

  const defaults: Record<string, string> = domain === 'demands' ? { requestType: 'transfer', fundingStatus: 'pending', priority: 'normal', fte: '1', headcount: '1', expectedStart: date } : domain === 'redeployments' ? { availableFrom: date, fte: '1' } : {};

  return defaults[key];

}



function asText(value: unknown): string {

  if (value === null || value === undefined) return "—";

  if (typeof value === "boolean") return value ? "Yes" : "No";

  if (typeof value === "object") return JSON.stringify(value);

  return String(value);

}



function notificationLink(value: unknown) {

  const href = safeWorkspaceHref(value);

  return href ? <Link href={href} prefetch={false}>Open report</Link> : asText(value);

}



function scheduleFilters(value: string): { date?: string; orgId?: string } {

  try {

    const parsed: unknown = JSON.parse(value || "{}");

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const fields = parsed as Record<string, unknown>;

    return { date: typeof fields.date === "string" ? fields.date : undefined, orgId: typeof fields.orgId === "string" ? fields.orgId : undefined };

  } catch { return {}; }

}



export function actionsFor(domain: string, context: string, state: string): string[] {

  const s = state.toLowerCase();

  if (domain === "scenarios") {

    if (["draft", "returned"].includes(s)) return ["submit", "compare", "fork"];

    if (["submitted", "pending", "in-review"].includes(s)) return ["approve", "reject", "return", "cancel", "compare", "fork"];

    if (s === "approved") return ["commit", "compare", "fork"];

    return ["compare", "fork"];

  }

  if (domain === "reconciliation") return s === "resolved" ? [] : ["resolve"];

  if (domain === "movements" && s === "approved") return ["commit", "cancel"];

  if (domain === "reveals" && s === "approved") return ["reveal", "revoke"];

  if (["demands", "movements", "overrides", "reveals"].includes(domain)) {

    if (["draft", "returned"].includes(s)) return ["submit", "cancel"];

    if (["submitted", "pending", "in-review"].includes(s)) return ["approve", "reject", "return", "cancel"];

  }

  if (context === "approvals" && !s) return ["submit"];

  return [];

}



export function RecordsWorkspace({ domain, context }: { domain: string; context: string }) {

  const def = domains[domain];

  const params = useSearchParams();

  const date = params.get("date") || new Date().toISOString().slice(0, 10);

  const orgId = params.get("orgId") || "";

  const [page, setPage] = useState(0);

  const [pageSize, setPageSize] = useState(20);

  const [search, setSearch] = useState("");

  const [query, setQuery] = useState("");

  const [state, setState] = useState("");

  const [consideration, setConsideration] = useState('');

  const [considerationBusy, setConsiderationBusy] = useState<string | null>(null);

  const [sorting, setSorting] = useState<SortingState>([]);

  const [visibility, setVisibility] = useState<VisibilityState>({});

  const [columnsOpen, setColumnsOpen] = useState(false);

  const [result, setResult] = useState<Page>({ rows: [], total: 0 });

  const [loading, setLoading] = useState(true);

  const [error, setError] = useState<unknown>(null);

  const [drawer, setDrawer] = useState<DrawerState>(null);

  const [revision, setRevision] = useState(0);



  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setPage(0); }, 300); return () => clearTimeout(timer); }, [search]);

  useEffect(() => {

    let live = true;

    const queryParams = new URLSearchParams({ date, page: String(page + 1), pageSize: String(pageSize) });

    if (orgId) queryParams.set("orgId", orgId);

    if (query) queryParams.set("search", query);

    if (state) queryParams.set("state", state);

    if (domain === 'redeployments' && consideration) queryParams.set('considerForRoles', consideration);

    if (sorting[0]) { queryParams.set("sort", sorting[0].id === "record" ? Object.keys(def.fields)[0] || "id" : sorting[0].id); queryParams.set("direction", sorting[0].desc ? "desc" : "asc"); }

    setLoading(true); setError(null);

    api<Page>(`/api/records/${domain}?${queryParams}`).then((data) => { if (live) setResult(data); }).catch((reason) => { if (live) setError(reason); }).finally(() => { if (live) setLoading(false); });

    return () => { live = false; };

  }, [domain, date, orgId, page, pageSize, query, state, consideration, sorting, revision]);



  async function toggleConsideration(row: RecordRow) {

    setConsiderationBusy(row.id); setError(null);

    try {

      await api(`/api/records/redeployments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'UPDATE', id: row.id, version: row.version, validFrom: date, data: { considerForRoles: !consideredForRoles(row) } }) });

      setRevision(value => value + 1);

    } catch (reason) { setError(reason); }

    finally { setConsiderationBusy(null); }

  }



  useEffect(() => {

    const id = params.get('id'); if (!id) return;

    let live = true;

    api<RecordRow>(`/api/records/${domain}/${id}?${new URLSearchParams({date})}`).then(row => { if (live) setDrawer({mode: 'detail', row}); }).catch(reason => { if (live) setError(reason); });

    return () => { live = false; };

  }, [domain, params, date]);



  const fields = visibleFields(domain, def);

  const columns = useMemo<ColumnDef<RecordRow>[]>(() => [

    { id: "record", header: "Record", accessorFn: (row) => row.data[fields[0]?.[0] || "id"] || row.id, cell: ({ row }) => <button className="btn text" type="button" onClick={() => setDrawer({ mode: "detail", row: row.original })}>{asText(row.getValue("record"))}</button> },

    ...(['redeployments','movements'].includes(domain) ? [{id:'person',header:'Person',cell:({row}:{row:{original:RecordRow}})=><RecordReference domain="workers" id={row.original.workerId} date={date} />}]:[]),

    ...fields.slice(1).map(([key, field]) => ({ id: key, header: field.label, accessorFn: (row: RecordRow) => domain === 'redeployments' && key === 'considerForRoles' ? consideredForRoles(row) : row.data[key], cell: ({ getValue, row }: { getValue: () => unknown; row: { original: RecordRow } }) => domain === 'redeployments' && key === 'considerForRoles' ? <div><span>{asText(getValue())}</span> <button className="btn text" type="button" disabled={!['active','placed'].includes(row.original.state) || considerationBusy !== null} onClick={() => void toggleConsideration(row.original)} aria-label={`${consideredForRoles(row.original) ? 'Stop considering' : 'Consider'} ${row.original.data.reason} for internal roles`}>{considerationBusy === row.original.id ? 'Saving…' : consideredForRoles(row.original) ? 'Stop considering' : 'Consider'}</button></div> : domain === "notifications" && key === "link" ? notificationLink(getValue()) : asText(getValue()) })),

    { id: "state", header: "State", accessorKey: "state", cell: ({ row }) => <span className={`badge ${row.original.state.toLowerCase()}`}>{row.original.state}</span> },

    { id: "validFrom", header: "Effective", accessorKey: "validFrom", cell: ({ row }) => <span>{row.original.validFrom}{row.original.validTo ? ` → ${row.original.validTo}` : ""}</span> },

  ], [domain, date, considerationBusy]);

  const table = useReactTable({ data: result.rows, columns, state: { sorting, columnVisibility: visibility, pagination: { pageIndex: page, pageSize } }, onSortingChange: (updater) => { setSorting(updater); setPage(0); }, onColumnVisibilityChange: setVisibility, getCoreRowModel: getCoreRowModel(), manualPagination: true, manualSorting: true, pageCount: Math.ceil(result.total / pageSize) });

  const totalPages = Math.max(1, Math.ceil(result.total / pageSize));



  return <>

    <section className="panel" aria-label={def.label}>

      <div className="panel-header"><div><h2>{def.label}</h2><span className="hint">{loading ? "Loading…" : `${result.total.toLocaleString()} records`}</span></div>{domain === 'movements' ? <Link className="btn primary" href="/workspace/matches">Propose from matches</Link> : <button className="btn primary" type="button" onClick={() => setDrawer({ mode: "create" })}>＋ {domain === "redeployments" ? "Add person needing a role" : domain === "demands" ? "Add team request" : "New record"}</button>}</div>

      <div className="table-tools">

        <label className="sr-only" htmlFor={`search-${domain}`}>Search {def.label}</label>

        <input className="search-input" id={`search-${domain}`} type="search" placeholder={`Search ${def.label.toLowerCase()}`} value={search} onChange={(event) => setSearch(event.target.value)} />

        <label className="sr-only" htmlFor={`state-${domain}`}>State</label>

        <select className="select" id={`state-${domain}`} value={state} onChange={(event) => { setState(event.target.value); setPage(0); }}><option value="">All states</option><option value="draft">Draft</option><option value="submitted">Submitted</option><option value="approved">Approved</option><option value="active">Active</option><option value="archived">Archived</option></select>

        {domain === 'redeployments' && <><label className="sr-only" htmlFor="consideration-filter">Consideration for internal roles</label><select className="select" id="consideration-filter" value={consideration} onChange={event => { setConsideration(event.target.value); setPage(0); }}><option value="">All people</option><option value="true">Considered for roles</option><option value="false">Not considered</option></select></>}

        <div style={{ position: "relative", marginLeft: "auto" }}><button className="btn" type="button" aria-expanded={columnsOpen} onClick={() => setColumnsOpen(!columnsOpen)}>Columns</button>{columnsOpen && <div className="panel" style={{ position: "absolute", zIndex: 5, right: 0, top: 42, minWidth: 195, padding: 12, maxHeight: 340, overflowY: "auto" }}>{table.getAllLeafColumns().map((column) => <label key={column.id} style={{ display: "flex", gap: 7, alignItems: "center", padding: "5px 0", fontSize: 12 }}><input type="checkbox" checked={column.getIsVisible()} onChange={column.getToggleVisibilityHandler()} />{typeof column.columnDef.header === "string" ? column.columnDef.header : column.id}</label>)}</div>}</div>

      </div>

      {error ? <div className="panel-body"><div role="alert" className="alert"><strong>{isDenied(error) ? "Access denied" : "Could not load records"}</strong>{messageFrom(error)}<br /><button type="button" onClick={() => setRevision((n) => n + 1)}>Try again</button></div></div> : loading ? <div className="loading" role="status">Loading records…</div> : result.rows.length === 0 ? <div className="empty-state"><strong>No records found</strong><span>{query || state || orgId ? "Try different filters or another date." : "Create the first record when you have write access."}</span></div> : <div className="table-wrap"><table className="data-table"><thead>{table.getHeaderGroups().map((group) => <tr key={group.id}>{group.headers.map((header) => <th key={header.id} scope="col"><button type="button" onClick={header.column.getToggleSortingHandler()} aria-label={`Sort by ${typeof header.column.columnDef.header === "string" ? header.column.columnDef.header : header.id}`}>{flexRender(header.column.columnDef.header, header.getContext())} {header.column.getIsSorted() === "asc" ? "↑" : header.column.getIsSorted() === "desc" ? "↓" : ""}</button></th>)}</tr>)}</thead><tbody>{table.getRowModel().rows.map((row) => <tr key={row.id}>{row.getVisibleCells().map((cell) => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>)}</tbody></table></div>}

      <div className="pagination"><span>{result.total === 0 ? "0" : page * pageSize + 1}–{Math.min((page + 1) * pageSize, result.total)} of {result.total}</span><div className="pagination-controls"><label htmlFor={`size-${domain}`}>Rows</label><select className="select" id={`size-${domain}`} value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(0); }}><option value="10">10</option><option value="20">20</option><option value="50">50</option></select><button className="btn" type="button" onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}>Previous</button><span>Page {page + 1} of {totalPages}</span><button className="btn" type="button" onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page + 1 >= totalPages}>Next</button></div></div>

    </section>

    {drawer && <RecordDrawer domain={domain} definition={def} context={context} initial={drawer} orgId={orgId} date={date} onClose={() => setDrawer(null)} onChanged={() => { setRevision((n) => n + 1); setDrawer(null); }} />}

  </>;

}



function RecordDrawer({ domain, definition, context, initial, orgId, date, onClose, onChanged }: { domain: string; definition: DomainDefinition; context: string; initial: NonNullable<DrawerState>; orgId: string; date: string; onClose: () => void; onChanged: () => void }) {

  const [mode, setMode] = useState(initial.mode);

  const [row, setRow] = useState(initial.row);

  const [tab, setTab] = useState<"details" | "history">("details");

  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const [approvalProgress, setApprovalProgress] = useState<{ required: string[]; approved: { stage: string; decision: string; created_at: string }[] } | null>(null);

  const [approvalStage, setApprovalStage] = useState("");

  const [actionComment, setActionComment] = useState("");

  const [busy, setBusy] = useState(false);

  const [error, setError] = useState<unknown>(null);

  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(Object.entries(definition.fields).map(([key, field]) => [key, initial.row?.data[key] === undefined || initial.row?.data[key] === null ? (field.type === "boolean" ? domain === "redeployments" && key === "considerForRoles" : domain === "report-schedules" && key === "filters" ? "{}" : newValue(domain, key, date) ?? "") : field.type === "boolean" ? Boolean(initial.row.data[key]) : String(initial.row.data[key])])));

  const [effective, setEffective] = useState(domain === "redeployments" && initial.mode === "edit" ? (initial.row?.validFrom && initial.row.validFrom > date ? initial.row.validFrom : date) : initial.row?.validFrom || date);

  const [until, setUntil] = useState(initial.row?.validTo || "");

  const [recordOrg, setRecordOrg] = useState(initial.row?.orgId || orgId);

  const [skillIds, setSkillIds] = useState<string[]>([]);

  const [nextSkillId, setNextSkillId] = useState("");

  const [workerId, setWorkerId] = useState(initial.row?.workerId || "");



  useEffect(() => {

    if (!initial.row) return;

    let live = true;

    api<RecordRow>(`/api/records/${domain}/${initial.row.id}?${new URLSearchParams({date})}`).then((fresh) => { if (live) setRow(fresh); }).catch((reason) => { if (live) setError(reason); });

    return () => { live = false; };

  }, [domain, initial.row, date]);

  useEffect(() => {

    if (tab !== "history" || !row) return;

    let live = true;

    api<HistoryEntry[] | { rows: HistoryEntry[] }>(`/api/history/${domain}/${row.id}`).then((data) => { if (live) setHistory(Array.isArray(data) ? data : data.rows); }).catch((reason) => { if (live) setError(reason); });

    return () => { live = false; };

  }, [tab, domain, row]);

  useEffect(() => {

    if (!row || !["demands", "movements", "scenarios", "reveals", "overrides", "privacy-requests"].includes(domain)) return;

    let live = true;

    api<{ required: string[]; approved: { stage: string; decision: string; created_at: string }[] }>(`/api/approvals?domain=${encodeURIComponent(domain)}&id=${encodeURIComponent(row.id)}`).then((value) => {

      if (!live) return;

      setApprovalProgress(value);

      setApprovalStage(value.required.find((stage) => !value.approved.some((entry) => entry.stage === stage && entry.decision.toLowerCase() === "approved")) || "");

    }).catch((reason) => { if (live && !isDenied(reason) && (reason as { status?: number }).status !== 404) setError(reason); });

    return () => { live = false; };

  }, [domain, row]);



  async function save(event: React.FormEvent<HTMLFormElement>) {

    event.preventDefault(); setBusy(true); setError(null);

    const data = Object.fromEntries(Object.entries(definition.fields).filter(([key, field]) => !serverOwnedField(domain, key) && !(values[key] === "" && !field.required && !field.nullable)).map(([key, field]) => {

      const raw = values[key];

      return [key, field.type === "boolean" ? Boolean(raw) : raw === "" ? null : field.type === "number" ? Number(raw) : raw];

    }));

    try {

      const record = { operation: mode === "create" ? "CREATE" : "UPDATE", id: row?.id, version: row?.version, orgId: recordOrg || null, workerId: workerId || null, validFrom: effective, validTo: until || null, data };

      await api<RecordRow>(domain === "demands" && mode === "create" ? '/api/team-needs' : `/api/records/${domain}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(domain === "demands" && mode === "create" ? {record, skillIds} : record) });

      onChanged();

    } catch (reason) { setError(reason); } finally { setBusy(false); }

  }



  async function mutate(operation: "ARCHIVE" | "RESTORE") {

    if (!row) return;

    setBusy(true); setError(null);

    try { await api(`/api/records/${domain}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation, id: row.id, version: row.version }) }); onChanged(); }

    catch (reason) { setError(reason); } finally { setBusy(false); }

  }



  async function action(name: string, historyVersion?: number) {

    if (!row) return;

    setBusy(true); setError(null);

    try {

      await api("/api/actions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: name, domain, id: row.id, version: row.version, ...(historyVersion ? { historyVersion } : {}), ...(name === "approve" && approvalStage ? { stage: approvalStage } : {}), ...(actionComment.trim() ? { comment: actionComment.trim() } : {}) }) });

      onChanged();

    } catch (reason) { setError(reason); } finally { setBusy(false); }

  }



  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="drawer" role="dialog" aria-modal="true" aria-label={`${mode === "create" ? "Create" : mode === "edit" ? "Edit" : "View"} ${definition.label}`} onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>

    <div className="drawer-header"><div><div className="eyebrow">{definition.label}</div><h2>{mode === "create" ? "New record" : mode === "edit" ? "Edit record" : asText(row?.data[Object.keys(definition.fields)[0]])}</h2>{row && <span className="hint">Version {row.version} · <span className={`badge ${row.state.toLowerCase()}`}>{row.state}</span></span>}</div><button className="btn" type="button" onClick={onClose} aria-label="Close details">✕</button></div>

    {error !== null && <div style={{ padding: "16px 27px 0" }}><div className="alert" role="alert"><strong>{isDenied(error) ? "Access denied" : "Action could not complete"}</strong>{messageFrom(error)}</div></div>}

    {mode === "detail" && row ? <><div className="drawer-content"><div className="tabs" role="tablist" aria-label="Record details"><button className={`tab ${tab === "details" ? "active" : ""}`} type="button" role="tab" aria-selected={tab === "details"} onClick={() => setTab("details")}>Details</button><button className={`tab ${tab === "history" ? "active" : ""}`} type="button" role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>History</button></div>{tab === "details" ? <><dl className="detail-list"><dt>Record ID</dt><dd className="code">{row.id}</dd><dt>Organization</dt><dd><RecordReference domain="org-units" id={row.orgId} date={date} /></dd><dt>Person</dt><dd><RecordReference domain="workers" id={row.workerId} date={date} /></dd><dt>Effective from</dt><dd>{row.validFrom}</dd><dt>Effective until</dt><dd>{asText(row.validTo)}</dd>{visibleFields(domain, definition).map(([key, field]) => <FragmentField key={key} field={field} value={domain === "redeployments" && key === "considerForRoles" ? consideredForRoles(row) : row.data[key]} domain={domain} fieldKey={key} date={date} />)}</dl>{approvalProgress && <div className="status-strip" style={{ marginTop: 22 }}>Approval stages: {approvalProgress.required.map((stage) => `${stage} ${approvalProgress.approved.some((entry) => entry.stage === stage && entry.decision.toLowerCase() === "approved") ? "✓" : "pending"}`).join(" · ")}</div>}</> : history.length ? <ol className="timeline">{history.map((entry) => <li key={entry.version}><strong>Version {entry.version}{entry.action ? ` · ${entry.action}` : ""}</strong><small>{entry.createdAt || entry.created_at || ""}{entry.actorId || entry.actor_id ? ` · ${entry.actorId || entry.actor_id}` : ""}</small>{entry.version !== row.version && <div><button type="button" className="btn text" disabled={busy} onClick={() => action("restore-version", entry.version)}>Restore this version</button></div>}</li>)}</ol> : <div className="empty-state">No history entries are available.</div>}</div><div className="drawer-footer" style={{ display: "block" }}>{actionsFor(domain, context, row.state).length > 0 && <div className="form-grid" style={{ marginBottom: 14 }}><div className="field"><label htmlFor="action-comment">Decision note</label><input id="action-comment" value={actionComment} onChange={(event) => setActionComment(event.target.value)} placeholder="Add context for the audit trail" /></div>{approvalProgress && <div className="field"><label htmlFor="approval-stage">Approval stage</label><select id="approval-stage" value={approvalStage} onChange={(event) => setApprovalStage(event.target.value)}><option value="">Select a stage</option>{approvalProgress.required.map((stage) => <option key={stage} value={stage} disabled={approvalProgress.approved.some((entry) => entry.stage === stage && entry.decision.toLowerCase() === "approved")}>{stage}{approvalProgress.approved.some((entry) => entry.stage === stage && entry.decision.toLowerCase() === "approved") ? " (complete)" : ""}</option>)}</select></div>}</div>}<div className="action-row" style={{ justifyContent: "space-between" }}><div className="action-row"><button className="btn" type="button" disabled={busy} onClick={() => { setMode("edit"); if (domain === "redeployments") setEffective(row.validFrom > date ? row.validFrom : date); setTab("details"); }}>Edit</button><button className="btn danger" type="button" disabled={busy} onClick={() => mutate(row.state.toLowerCase() === "archived" ? "RESTORE" : "ARCHIVE")}>{row.state.toLowerCase() === "archived" ? "Restore" : "Archive"}</button></div><div className="action-row">{actionsFor(domain, context, row.state).map((name) => <button key={name} className={name === "approve" || name === "commit" ? "btn primary" : "btn"} type="button" disabled={busy || (name === "approve" && !!approvalProgress && !approvalStage)} onClick={() => action(name)}>{name.replace("-", " ")}</button>)}</div></div></div></> : <form onSubmit={save} style={{ display: "flex", flexDirection: "column", flex: 1 }}><div className="drawer-content"><div className="form-grid"><ReferencePicker id="record-org" label="Organization" domain="org-units" value={recordOrg} onChange={setRecordOrg} date={effective} />{domain !== "demands" && <ReferencePicker id="record-worker" label="Person" domain="workers" value={workerId} onChange={setWorkerId} date={effective} orgId={recordOrg} required={domain === "redeployments"} />}<div className="field"><label htmlFor="record-from">Effective from</label><input id="record-from" type="date" value={effective} required onChange={(event) => setEffective(event.target.value)} /></div><div className="field"><label htmlFor="record-until">Effective until</label><input id="record-until" type="date" value={until} min={effective} onChange={(event) => setUntil(event.target.value)} /><span className="help">End date is exclusive.</span></div>{visibleFields(domain, definition).filter(([key]) => !serverOwnedField(domain, key)).map(([key, field]) => <EditorField key={key} id={`field-${key}`} field={field} value={values[key]} domain={domain} fieldKey={key} date={effective} orgId={recordOrg} onChange={(value) => setValues((current) => ({ ...current, [key]: value }))} />)}{domain === 'demands' && mode === 'create' && <div className="wide"><h3>Required skills</h3><ReferencePicker id="need-skill" label="Required skill" domain="skills" value={nextSkillId} onChange={setNextSkillId} date={effective} /><button className="btn" type="button" disabled={!nextSkillId || skillIds.includes(nextSkillId)} onClick={() => { setSkillIds(current => [...current, nextSkillId]); setNextSkillId(''); }}>Add required skill</button>{skillIds.map((id, index) => <div className="action-row" key={id}><ReferencePicker id={`need-skill-${index}`} label={`Required skill ${index + 1}`} domain="skills" value={id} onChange={value => setSkillIds(current => current.map(item => item === id ? value : item))} date={effective} required /><button className="btn" type="button" onClick={() => setSkillIds(current => current.filter(item => item !== id))}>Remove skill {index + 1}</button></div>)}<p className="hint">Skills are saved with the request. You can maintain them later in Request skills.</p></div>}</div></div><div className="drawer-footer"><button className="btn" type="button" onClick={() => mode === "edit" ? setMode("detail") : onClose()}>Cancel</button><button className="btn primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save record"}</button></div></form>}

  </aside></div>;

}



function RecordReference({domain,id,date}:{domain:string;id:unknown;date:string}) {

  const [label,setLabel]=useState('Loading…');

  useEffect(()=>{

    if(!id) return;

    let live=true;

    api<RecordRow>(`/api/records/${domain}/${String(id)}?${new URLSearchParams({date})}`).then(row=>{if(live)setLabel(String(row.data.name ?? row.data.code ?? row.data.reason ?? row.id));}).catch(()=>{if(live)setLabel('Unavailable');});

    return ()=>{live=false;};

  },[domain,id,date]);

  return <span>{id ? label : '—'}</span>;

}

function FragmentField({ field, value, domain, fieldKey, date }: { field: FieldDefinition; value: unknown; domain: string; fieldKey: string; date:string }) {

  const reference=field.type==='uuid'?referenceDomainFor(domain,fieldKey):null;

  return <><dt>{field.label}</dt><dd>{reference ? <RecordReference domain={reference} id={value} date={date} /> : domain === "notifications" && fieldKey === "link" ? notificationLink(value) : asText(value)}</dd></>;

}



function EditorField({ id, field, value, onChange, domain, fieldKey, date, orgId }: { id: string; field: FieldDefinition; value: string | boolean; onChange: (value: string | boolean) => void; domain: string; fieldKey: string; date: string; orgId: string }) {

  if (domain === "report-schedules" && fieldKey === "domain") return <div className="field"><label htmlFor={id}>Export domain *</label><select id={id} value={String(value)} required onChange={(event) => onChange(event.target.value)}><option value="">Select a domain…</option>{Object.values(domains).map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select><span className="help">The report needs READ and EXPORT access to the selected domain.</span></div>;

  if (domain === "report-schedules" && fieldKey === "filters") {

    const filters = scheduleFilters(String(value));

    return <div className="wide"><div className="form-grid"><div className="field"><label htmlFor={`${id}-date`}>Report date</label><input id={`${id}-date`} type="date" value={filters.date || ""} onChange={(event) => onChange(JSON.stringify({ ...filters, date: event.target.value || undefined }))} /><span className="help">Optional. Blank uses the queued run’s UTC day.</span></div><ReferencePicker id={`${id}-org`} label="Organization filter" domain="org-units" value={filters.orgId || ""} onChange={(selected) => onChange(JSON.stringify({ ...filters, orgId: selected || undefined }))} date={filters.date || date} /></div></div>;

  }

  if (domain === "report-schedules" && fieldKey === "intervalHours") return <div className="field"><label htmlFor={id}>Repeat every (hours) *</label><input id={id} type="number" min="1" max="8760" step="1" required value={String(value)} onChange={(event) => onChange(event.target.value)} /><span className="help">The scheduler evaluates due times in UTC.</span></div>;

  const reference = field.type === "uuid" ? referenceDomainFor(domain, fieldKey) : null;

  if (reference) return <ReferencePicker id={id} label={field.label} domain={reference} value={String(value)} onChange={onChange} date={date} orgId={orgId} required={field.required} />;

  return <div className={`field ${field.type === "text" && (field.label.toLowerCase().includes("reason") || field.label.toLowerCase().includes("description")) ? "wide" : ""}`}><label htmlFor={id}>{field.label}{field.required ? " *" : ""}</label>{field.type === "boolean" ? <select id={id} value={value ? "true" : "false"} onChange={(event) => onChange(event.target.value === "true")}><option value="false">No</option><option value="true">Yes</option></select> : field.type === "select" ? <select id={id} value={String(value)} required={field.required} onChange={(event) => onChange(event.target.value)}><option value="">Select…</option>{field.options?.map((option) => <option value={option} key={option}>{option}</option>)}</select> : <input id={id} type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"} step={field.type === "number" ? "any" : undefined} required={field.required} value={String(value)} onChange={(event) => onChange(event.target.value)} />}{field.owner && field.owner !== "application" && <span className="help">Owned by {field.owner}</span>}</div>;

}

