"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, isDenied, messageFrom } from "./api";

type FinanceReport = { period: { from: string; to: string }; currency: string; cost: string; budget: string; variance: string; cohort: number | string; quality?: { missingRates: number; missingContracts: number }; definition: string };

export function FinancePanel() {
  const params = useSearchParams();
  const date = params.get("date") || new Date().toISOString().slice(0, 10);
  const orgId = params.get("orgId") || "";
  const [currency, setCurrency] = useState("USD");
  const [report, setReport] = useState<FinanceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    const query = new URLSearchParams({ date, currency }); if (orgId) query.set("orgId", orgId);
    setLoading(true); setError(null);
    api<FinanceReport>(`/api/finance?${query}`).then((data) => { if (live) setReport(data); }).catch((reason) => { if (live) setError(reason); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [date, orgId, currency]);
  return <section className="panel" style={{ marginBottom: 19 }}><div className="panel-header"><div><h2>Monthly cost outlook</h2><span className="hint">Permission scoped aggregate · closed calendar month</span></div><label className="filter-control">Currency <input aria-label="Report currency" value={currency} maxLength={3} pattern="[A-Z]{3}" onChange={(event) => setCurrency(event.target.value.toUpperCase())} style={{ width: 46 }} /></label></div>{loading ? <div className="loading" role="status">Loading cost outlook…</div> : error !== null ? <div className="panel-body"><div className="alert" role="alert"><strong>{isDenied(error) ? "Access denied" : "Cost outlook unavailable"}</strong>{messageFrom(error)}</div></div> : report ? <div className="panel-body"><div className="inline-grid"><div className="kv-card"><span className="small-label">Forecast cost</span><strong>{report.cost === "suppressed" || report.cost === "incomplete" ? report.cost : `${report.currency} ${report.cost}`}</strong></div><div className="kv-card"><span className="small-label">Prorated budget</span><strong>{report.budget === "suppressed" ? report.budget : `${report.currency} ${report.budget}`}</strong></div><div className="kv-card"><span className="small-label">Variance</span><strong>{report.variance === "suppressed" || report.variance === "incomplete" ? report.variance : `${report.currency} ${report.variance}`}</strong></div></div><p className="hint" style={{ margin: "16px 0 0" }}>{report.period.from} to {report.period.to} (exclusive). {report.definition}</p>{report.quality && <p className="hint">Missing exchange rates: {report.quality.missingRates}; missing contracts: {report.quality.missingContracts}.</p>}</div> : <div className="empty-state">No cost outlook is available.</div>}</section>;
}
