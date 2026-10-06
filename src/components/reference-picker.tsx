"use client";

import { useEffect, useId, useState } from "react";
import { domains } from "@/lib/registry";
import type { RecordRow } from "@/lib/types";
import { api, isDenied, messageFrom } from "./api";

export function referenceDomainFor(domain: string, field: string): string | null {
  if (field === "homeOrgId" || field === "sourceOrgId" || field === "destinationOrgId" || field === "budgetOrgId") return "org-units";
  if (field === "parentId") return domain === "scenarios" ? "scenarios" : "org-units";
  if (field === "childId") return "org-units";
  if (field === "managerId" || field === "destinationManagerId") return "workers";
  if (field === "workerId") return "workers";
  if (field === "roleId") return "roles";
  if (field === "activityId") return "activities";
  if (field === "familyId") return "role-families";
  if (field === "positionId") return "positions";
  if (field === "skillId") return "skills";
  if (field === "calendarId") return "calendars";
  if (field === "demandId") return "demands";
  if (field === "placementId") return "redeployments";
  if (field === "movementId") return "movements";
  if (field === "sourceAssignmentId") return "assignments";
  if (field === "scenarioId") return "scenarios";
  if (field === "recordId") return null;
  return null;
}

function recordLabel(domain: string, row: RecordRow): string {
  const fields = Object.keys(domains[domain]?.fields || {});
  const preferred = ["name", "code", "title", "displayName", "alias", ...fields];
  const value = preferred.map((key) => row.data[key]).find((item) => typeof item === "string" && item.trim());
  return value ? String(value) : row.id;
}

export function ReferencePicker({ id, label, domain, value, onChange, date, orgId, required }: { id: string; label: string; domain: string; value: string; onChange: (value: string) => void; date: string; orgId?: string; required?: boolean }) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [selectedLabel, setSelectedLabel] = useState("");
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [open, setOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!value) { setSelectedLabel(""); return; }
    let live = true;
    api<RecordRow>(`/api/records/${domain}/${encodeURIComponent(value)}?${new URLSearchParams({date})}`).then((row) => { if (live) setSelectedLabel(recordLabel(domain, row)); }).catch(() => { if (live) setSelectedLabel(value); });
    return () => { live = false; };
  }, [domain, value, date]);

  useEffect(() => {
    if (!open || advanced) return;
    let live = true;
    const timer = setTimeout(() => {
      const q = new URLSearchParams({ page: "1", pageSize: "10", date });
      if (query) q.set("search", query);
      if (orgId && !["org-units", "roles", "role-families", "skills", "calendars", "activities"].includes(domain)) q.set("orgId", orgId);
      setBusy(true); setError(null);
      api<{ rows: RecordRow[] }>(`/api/records/${domain}?${q}`).then((data) => { if (live) { setRows(data.rows); setActive(0); } }).catch((reason) => { if (live) { setRows([]); setError(reason); } }).finally(() => { if (live) setBusy(false); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [open, advanced, query, domain, date, orgId]);

  function choose(row: RecordRow) { onChange(row.id); setSelectedLabel(recordLabel(domain, row)); setQuery(""); setOpen(false); setAdvanced(false); }

  return <div className="field" style={{ position: "relative" }}><label htmlFor={id}>{label}{required ? " *" : ""}</label>
    {value && !open && !advanced ? <div className="action-row" style={{ justifyContent: "space-between", border: "1px solid #ccd9ce", borderRadius: 8, padding: 8 }}><span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={value}>{selectedLabel || value}</span><button className="btn text" type="button" onClick={() => { setOpen(true); setQuery(""); }}>Change</button></div> : advanced ? <input id={id} type="text" value={value} required={required} placeholder="Record UUID" onChange={(event) => onChange(event.target.value)} /> : <input id={id} type="search" role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listId} aria-activedescendant={open && rows[active] ? `${listId}-${active}` : undefined} value={query} placeholder={`Search ${domains[domain]?.label.toLowerCase() || "records"}`} onFocus={() => setOpen(true)} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setActive((n) => Math.min(n + 1, rows.length - 1)); } if (event.key === "ArrowUp") { event.preventDefault(); setActive((n) => Math.max(n - 1, 0)); } if (event.key === "Enter" && rows[active]) { event.preventDefault(); choose(rows[active]); } if (event.key === "Escape") setOpen(false); }} />}
    {open && !advanced && <div id={listId} role="listbox" aria-label={`${label} results`} className="panel" style={{ position: "absolute", zIndex: 15, top: "100%", left: 0, right: 0, maxHeight: 210, overflowY: "auto", padding: 4 }}>{error ? <div className="hint" role="alert" style={{ padding: 10 }}>{isDenied(error) ? "Access denied to these references." : messageFrom(error)}</div> : busy ? <div className="hint" style={{ padding: 10 }}>Searching…</div> : rows.length ? rows.map((row, index) => <button id={`${listId}-${index}`} role="option" aria-selected={index === active} type="button" key={row.id} onClick={() => choose(row)} className="btn text" style={{ display: "block", width: "100%", textAlign: "left", background: index === active ? "#edf4e7" : "transparent", whiteSpace: "normal" }}>{recordLabel(domain, row)}<span className="hint" style={{ display: "block" }}>{row.id}</span></button>) : <div className="hint" style={{ padding: 10 }}>No permitted records found.</div>}</div>}
    <div className="action-row"><button className="btn text" type="button" onClick={() => { setAdvanced(!advanced); setOpen(false); }}>{advanced ? "Search records" : "Enter UUID manually"}</button>{value && <button className="btn text" type="button" onClick={() => { onChange(""); setSelectedLabel(""); setOpen(true); setAdvanced(false); }}>Clear</button>}</div>
  </div>;
}
