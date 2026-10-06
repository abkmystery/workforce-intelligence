"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { domains } from "@/lib/registry";
import { api, isDenied, messageFrom } from "./api";

type PreviewRow = { rowNumber: number; values: Record<string, unknown>; errors: string[]; status: string; outcome?: unknown };
type Preview = { batchId: string; hash: string; status: string; rowCount: number; validCount: number; rows: PreviewRow[] };
type Batch = Preview & { jobId?: string; error?: string };
const domainOptions = ["workers", "redeployments", "demands", "request-skills", "worker-skills", "skills", "roles", "org-units", "assignments", "contracts", "calendars"].map(key => domains[key]);

export function ImportCenter() {
  const [domain, setDomain] = useState("workers");
  const [operation, setOperation] = useState("UPSERT");
  const [mode, setMode] = useState("ALL");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function runPreview(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!file) return;
    setBusy(true); setError(null); setPreview(null); setBatch(null);
    const body = new FormData(); body.set("file", file); body.set("domain", domain); body.set("operation", operation); body.set("mode", mode);
    try { const result = await api<Preview>("/api/imports/preview", { method: "POST", body }); setPreview(result); setSelected(result.rows.filter((row) => row.errors.length === 0).map((row) => row.rowNumber)); }
    catch (reason) { setError(reason); } finally { setBusy(false); }
  }

  async function commit() {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      const result = await api<{ batchId: string; status: string; jobId?: string }>("/api/imports/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batchId: preview.batchId, hash: preview.hash, ...(mode === "SELECTED" ? { selectedRows: selected } : {}) }) });
      setBatch({ ...preview, ...result });
    } catch (reason) { setError(reason); } finally { setBusy(false); }
  }

  async function refresh() {
    const id = batch?.batchId || preview?.batchId; if (!id) return;
    setBusy(true); setError(null);
    try { setBatch(await api<Batch>(`/api/imports/${id}`)); } catch (reason) { setError(reason); } finally { setBusy(false); }
  }

  async function reverse() {
    if (!batch) return;
    setBusy(true); setError(null);
    try { await api("/api/imports/reverse", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batchId: batch.batchId }) }); await refresh(); }
    catch (reason) { setError(reason); } finally { setBusy(false); }
  }

  return <div className="stack">
    <div className="panel"><div className="panel-header"><h2>1. Prepare a source file</h2></div><div className="panel-body"><form onSubmit={runPreview} className="stack"><div className="form-grid"><div className="field"><label htmlFor="import-domain">Domain</label><select id="import-domain" value={domain} onChange={(event) => { setDomain(event.target.value); setPreview(null); }}>{domainOptions.map((def) => <option key={def.key} value={def.key}>{def.label}</option>)}</select></div><div className="field"><label htmlFor="import-operation">Operation</label><select id="import-operation" value={operation} onChange={(event) => setOperation(event.target.value)}>{["CREATE", "UPDATE", "UPSERT", "ARCHIVE", "RESTORE", "VALIDATE_ONLY"].map((value) => <option key={value}>{value}</option>)}</select></div><div className="field"><label htmlFor="import-mode">Commit mode</label><select id="import-mode" value={mode} onChange={(event) => setMode(event.target.value)}><option value="ALL">All valid rows</option><option value="SELECTED">Selected rows</option></select></div><div className="field"><label>Download template</label><div className="action-row"><a className="btn" href={`/api/imports/templates?domain=${domain}&format=csv&example=false`}>CSV</a><a className="btn" href={`/api/imports/templates?domain=${domain}&format=xlsx&example=false`}>Excel</a></div></div></div><label className="file-drop"><strong>Select a CSV or Excel file</strong><p className="hint">The preview checks rows before you commit them.</p><input type="file" accept=".csv,.xlsx" required onChange={(event) => { setFile(event.target.files?.[0] || null); setPreview(null); }} /></label><div><button className="btn primary" type="submit" disabled={busy || !file}>{busy ? "Checking…" : "Preview file"}</button></div></form></div></div>
    {error !== null && <div className="alert" role="alert"><strong>{isDenied(error) ? "Access denied" : "Import action failed"}</strong>{messageFrom(error)}</div>}
    {preview && <div className="panel"><div className="panel-header"><div><h2>2. Review the diff</h2><span className="hint">Batch {preview.batchId} · {preview.validCount} valid of {preview.rowCount} rows</span></div><span className={`badge ${preview.status.toLowerCase()}`}>{preview.status}</span></div><div className="table-wrap"><table className="data-table"><thead><tr>{mode === "SELECTED" && <th scope="col">Include</th>}<th scope="col">Row</th><th scope="col">Status</th><th scope="col">Values</th><th scope="col">Validation</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={row.rowNumber}>{mode === "SELECTED" && <td><input type="checkbox" aria-label={`Include row ${row.rowNumber}`} disabled={row.errors.length > 0 || !!batch} checked={selected.includes(row.rowNumber)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, row.rowNumber] : current.filter((n) => n !== row.rowNumber))} /></td>}<td>{row.rowNumber}</td><td><span className={`badge ${row.status.toLowerCase()}`}>{row.status}</span></td><td><span className="code">{JSON.stringify(row.values)}</span></td><td>{row.errors.length ? row.errors.join("; ") : "Ready"}</td></tr>)}</tbody></table></div><div className="panel-body action-row"><button className="btn primary" type="button" onClick={commit} disabled={busy || !!batch || preview.validCount === 0 || operation === "VALIDATE_ONLY" || (mode === "SELECTED" && selected.length === 0)}>{busy ? "Working…" : "Commit valid rows"}</button>{operation === "VALIDATE_ONLY" && <span className="hint">Validation only: nothing will be committed.</span>}</div></div>}
    {batch && <div className="panel"><div className="panel-header"><h2>3. Batch status</h2><span className={`badge ${batch.status.toLowerCase()}`}>{batch.status}</span></div><div className="panel-body"><p>Batch <span className="code">{batch.batchId}</span>{batch.jobId && <> · Job <span className="code">{batch.jobId}</span></>}</p>{batch.error && <div className="alert" role="alert">{batch.error}</div>}<div className="action-row"><button type="button" className="btn" onClick={refresh} disabled={busy}>Refresh status</button>{batch.status === "completed" && <button type="button" className="btn danger" onClick={reverse} disabled={busy}>Reverse batch</button>}</div>{batch.rows?.length ? <div className="table-wrap" style={{ marginTop: 18 }}><table className="data-table"><thead><tr><th>Row</th><th>Outcome</th><th>Detail</th></tr></thead><tbody>{batch.rows.map((item) => <tr key={item.rowNumber}><td>{item.rowNumber}</td><td>{item.status}</td><td>{item.outcome ? JSON.stringify(item.outcome) : item.errors?.join("; ") || "—"}</td></tr>)}</tbody></table></div> : null}</div></div>}
  </div>;
}

export function ExportCenter() {
  const params = useSearchParams();
  const exportId = params.get("exportId");
  const validExportId = !!exportId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(exportId);
  const [domain, setDomain] = useState("workers");
  const [format, setFormat] = useState("csv");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [storedBusy, setStoredBusy] = useState(false);
  const [storedError, setStoredError] = useState<unknown>(null);

  async function saveResponse(response: Response, fallbackName: string) {
    if (!response.ok) { const payload = await response.json().catch(() => ({})); throw { status: response.status, message: payload.error?.message || `Export failed (${response.status}).` }; }
    const extension = response.headers.get("content-type")?.includes("spreadsheetml") ? "xlsx" : "csv";
    const named = response.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/i)?.[1];
    const filename = named && /^[\w.-]+$/.test(named) ? named : `${fallbackName}.${extension}`;
    const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function download() {
    setBusy(true); setError(null);
    const q = new URLSearchParams({ domain, format, date: params.get("date") || new Date().toISOString().slice(0, 10) });
    if (params.get("orgId")) q.set("orgId", params.get("orgId")!);
    try {
      const response = await fetch(`/api/exports?${q}`, { credentials: "same-origin", cache: "no-store" });
      await saveResponse(response, `${domain}-${q.get("date")}`);
    } catch (reason) { setError(reason); } finally { setBusy(false); }
  }
  async function downloadStored() {
    if (!validExportId || !exportId) return;
    setStoredBusy(true); setStoredError(null);
    try { await saveResponse(await fetch(`/api/exports/${encodeURIComponent(exportId)}`, { credentials: "same-origin", cache: "no-store" }), `report-${exportId}`); }
    catch (reason) { setStoredError(reason); } finally { setStoredBusy(false); }
  }

  return <div className="stack">
    {exportId && <section className="panel" aria-label="Stored report"><div className="panel-header"><h2>Stored report</h2></div><div className="panel-body stack"><p className="hint">Open this file only when you need it. Access is checked again at download, and stored exports expire after 24 hours.</p><p>Export ID: <span className="code">{exportId}</span></p>{!validExportId && <div className="alert" role="alert">This report link is invalid.</div>}{storedError !== null && <div className="alert" role="alert"><strong>{isDenied(storedError) ? "Access denied" : "Report unavailable"}</strong>{messageFrom(storedError)}</div>}<div><button className="btn primary" type="button" onClick={downloadStored} disabled={!validExportId || storedBusy}>{storedBusy ? "Preparing…" : "Download stored report"}</button></div></div></section>}
    <section className="panel"><div className="panel-header"><h2>Create an export</h2></div><div className="panel-body stack"><p className="hint">Exports use the global date and organization filters and your current access.</p><div className="form-grid"><div className="field"><label htmlFor="export-domain">Domain</label><select id="export-domain" value={domain} onChange={(event) => setDomain(event.target.value)}>{Object.values(domains).map((def) => <option key={def.key} value={def.key}>{def.label}</option>)}</select></div><div className="field"><label htmlFor="export-format">Format</label><select id="export-format" value={format} onChange={(event) => setFormat(event.target.value)}><option value="csv">CSV</option><option value="xlsx">Excel</option></select></div></div>{error !== null && <div className="alert" role="alert"><strong>{isDenied(error) ? "Access denied" : "Export failed"}</strong>{messageFrom(error)}</div>}<div><button className="btn primary" type="button" onClick={download} disabled={busy}>{busy ? "Preparing…" : "Download export"}</button></div></div></section>
  </div>;
}
