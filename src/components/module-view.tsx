"use client";

import { useState } from "react";
import { domains } from "@/lib/registry";
import { modules } from "./module-config";
import { RecordsWorkspace } from "./records-workspace";
import { Overview } from "./overview";
import { ImportCenter, ExportCenter } from "./transfer-center";
import { AdminWorkspace, AuditWorkspace } from "./admin-workspace";
import { FinancePanel } from "./finance-panel";
import { NotificationsWorkspace } from "./notifications-workspace";
import { MatchesWorkspace } from "./matches-workspace";

export function ModuleView({ module }: { module: string }) {
  const config = modules[module];
  const [active, setActive] = useState(0);
  if (!config) return null;
  const special = config.kind === "overview" ? <Overview /> : config.kind === "matches" ? <MatchesWorkspace /> : config.kind === "imports" ? <ImportCenter /> : config.kind === "exports" ? <ExportCenter /> : config.kind === "audit" ? <AuditWorkspace /> : config.kind ? <AdminWorkspace kind={config.kind} /> : null;
  const keys = config.domains || [];
  return (
    <>
      <div className="page-intro"><div><div className="eyebrow">{module === "overview" ? "At a glance" : "Workspace"}</div><h1>{config.title}</h1><p>{config.description}</p></div></div>
      {special}
      {module === "cost" && <FinancePanel />}
      {keys.length > 0 && <>
        {keys.length > 1 && <div className="tabs" role="tablist" aria-label={`${config.title} data`}>
          {keys.map((key, index) => <button key={key} id={`tab-${key}`} className={`tab ${index === active ? "active" : ""}`} type="button" role="tab" aria-selected={index === active} aria-controls={`panel-${key}`} onClick={() => setActive(index)}>{domains[key]?.label || key}</button>)}
        </div>}
        {module === "reports" && keys[active] === "report-schedules" && <div className="status-strip" role="note" style={{ marginBottom: 16 }}>Enabled schedules repeat at the chosen interval in hours, with run times evaluated in UTC. Leave the report date blank to use each queued run’s UTC day; set a date to use that same day for every run. Organization filters limit the export. Scheduled files need private storage; successful runs send a notification, and downloads expire after 24 hours. Access is checked when the report runs and again when you download it.</div>}
        <div role="tabpanel" id={`panel-${keys[active]}`} aria-labelledby={keys.length > 1 ? `tab-${keys[active]}` : undefined}>
          {module === "reports" && keys[active] === "notifications" ? <NotificationsWorkspace /> : <RecordsWorkspace key={`${module}-${keys[active]}`} domain={keys[active]} context={module} />}
        </div>
      </>}
    </>
  );
}
