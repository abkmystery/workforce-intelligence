"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { RecordRow } from "@/lib/types";
import { api, isDenied, messageFrom } from "./api";
import { safeWorkspaceHref } from "./safe-workspace-link";

type Page = { rows: RecordRow[]; total: number };
const pageSize = 20;

export function NotificationsWorkspace() {
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<Page>({ rows: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true); setError(null);
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sort: "validFrom", direction: "desc" });
    api<Page>(`/api/records/notifications?${query}`).then((data) => { if (live) setResult(data); }).catch((reason) => { if (live) setError(reason); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [page, revision]);

  async function markRead(row: RecordRow) {
    setUpdatingId(row.id); setActionError(null);
    try {
      await api(`/api/records/notifications`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "UPDATE", id: row.id, version: row.version, data: { read: true } }) });
      setRevision((current) => current + 1);
    } catch (reason) { setActionError(reason); } finally { setUpdatingId(null); }
  }

  const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
  return <section className="panel" aria-label="Your report notifications">
    <div className="panel-header"><div><h2>Your notifications</h2><span className="hint">Only notifications addressed to you are shown.</span></div><button type="button" className="btn" onClick={() => setRevision((current) => current + 1)} disabled={loading}>Refresh</button></div>
    {actionError !== null && <div className="panel-body"><div className="alert" role="alert"><strong>{isDenied(actionError) ? "Access denied" : "Could not mark notification read"}</strong>{messageFrom(actionError)}</div></div>}
    {error !== null ? <div className="panel-body"><div className="alert" role="alert"><strong>{isDenied(error) ? "Access denied" : "Could not load notifications"}</strong>{messageFrom(error)}</div></div> : loading ? <div className="loading" role="status">Loading notifications…</div> : result.rows.length === 0 ? <div className="empty-state">No notifications yet.</div> : <div className="table-wrap"><table className="data-table"><thead><tr><th scope="col">Task</th><th scope="col">Report</th><th scope="col">Status</th><th scope="col">Date</th><th scope="col">Action</th></tr></thead><tbody>{result.rows.map((row) => { const href = safeWorkspaceHref(row.data.link); const read = row.data.read === true; return <tr key={row.id}><td>{String(row.data.title || "Notification")}</td><td>{href ? <Link href={href} prefetch={false}>Open report</Link> : <span className="hint">Link unavailable</span>}</td><td>{read ? "Read" : "Unread"}</td><td>{row.validFrom}</td><td>{read ? "—" : <button type="button" className="btn" onClick={() => markRead(row)} disabled={updatingId !== null}>{updatingId === row.id ? "Saving…" : "Mark read"}</button>}</td></tr>; })}</tbody></table></div>}
    <div className="pagination"><span>{result.total === 0 ? "0" : (page - 1) * pageSize + 1}–{Math.min(page * pageSize, result.total)} of {result.total}</span><div className="pagination-controls"><button className="btn" type="button" onClick={() => setPage(page - 1)} disabled={page <= 1}>Previous</button><span>Page {page} of {totalPages}</span><button className="btn" type="button" onClick={() => setPage(page + 1)} disabled={page >= totalPages}>Next</button></div></div>
  </section>;
}
