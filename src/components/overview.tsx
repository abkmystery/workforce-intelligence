"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, isDenied, messageFrom } from "./api";

type OverviewData = { metrics: { label: string; value: number | string; description?: string }[]; quality: { label: string; value: number | string }[]; asOf: string };
const links = [{ label: "People needing a role", slug: "redeployment" }, { label: "Teams needing people", slug: "demand" }, { label: "Find matches", slug: "matches" }, { label: "Review transfers", slug: "mobility" }, { label: "People & skills", slug: "workforce" }, { label: "Import data", slug: "hr-import-center" }];

export function Overview() {
  const params = useSearchParams();
  const date = params.get("date") || new Date().toISOString().slice(0, 10);
  const orgId = params.get("orgId") || "";
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    const q = new URLSearchParams({ date }); if (orgId) q.set("orgId", orgId);
    setLoading(true); setError(null);
    api<OverviewData>(`/api/planning-overview?${q}`).then((response) => { if (live) setData(response); }).catch((reason) => { if (live) setError(reason); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [date, orgId, revision]);
  const query = params.toString();
  if (loading) return <div className="panel loading" role="status">Loading your workforce view…</div>;
  if (error) return <div role="alert" className="alert"><strong>{isDenied(error) ? "Access denied" : "Overview unavailable"}</strong>{messageFrom(error)}<br /><button type="button" onClick={() => setRevision((n) => n + 1)}>Try again</button></div>;
  if (!data) return <div className="panel empty-state">No overview data is available.</div>;
  return <>
    <div className="status-strip"><span className="status-dot" aria-hidden="true" />Data as of {data.asOf || date}. Metrics reflect your current access and filters.</div>
    <div className="card-grid">{data.metrics.map((metric) => <article className="panel metric" key={metric.label}><span className="metric-label">{metric.label}</span><strong className="metric-value">{metric.value}</strong><span className="metric-note">{metric.description}</span></article>)}</div>
    <section className="panel"><div className="panel-header"><h2>Plan an internal placement</h2></div><div className="panel-body quick-links">{links.map((link) => <Link className="quick-link" key={link.slug} href={`/workspace/${link.slug}${query ? `?${query}` : ""}`}>{link.label}<span aria-hidden="true">↗</span></Link>)}</div></section>
  </>;
}
