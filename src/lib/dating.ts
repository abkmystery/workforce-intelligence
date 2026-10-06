import { domains } from './registry';
export function currentRows(domain:string,tenant='$1',date='$2'){
 const d=domains[domain];if(!d)throw new Error('Unknown domain');
 return `(SELECT id,tenant_id,org_id,worker_id,valid_from,valid_to,version,state,data FROM ${d.table} WHERE tenant_id=${tenant}::uuid AND valid_from<=${date}::date)`;
}
export function historicalRows(domain:string,tenant='$1',date='$2'){
 const d=domains[domain];if(!d)throw new Error('Unknown domain');
 // Effective starts never move backwards. Current rows therefore win whenever
 // their start is reached; only future-dated current rows need a history lookup.
 return `(SELECT h.* FROM ${d.table} current_revision CROSS JOIN LATERAL (
 SELECT record_id AS id,tenant_id,(snapshot->>'orgId')::uuid AS org_id,(snapshot->>'workerId')::uuid AS worker_id,(snapshot->>'validFrom')::date AS valid_from,(snapshot->>'validTo')::date AS valid_to,version,snapshot->>'state' AS state,snapshot->'data' AS data
 FROM record_history WHERE tenant_id=current_revision.tenant_id AND domain='${d.key}' AND record_id=current_revision.id AND snapshot->>'validFrom'<=(${date}::date)::text ORDER BY snapshot->>'validFrom' DESC,version DESC LIMIT 1
 ) h WHERE current_revision.tenant_id=${tenant}::uuid AND current_revision.valid_from>${date}::date)`;
}
export function effectiveRows(domain:string,tenant='$1',date='$2'){
 return `(SELECT * FROM ${currentRows(domain,tenant,date)} UNION ALL SELECT * FROM ${historicalRows(domain,tenant,date)})`;
}
/** Preserve primary-key statistics for large joins; history never changes the ID. */
export function effectiveRowsById(domain:string,tenant='$1',date='$2'){
 const d=domains[domain];if(!d)throw new Error('Unknown domain');
 const columns=['org_id','worker_id','valid_from','valid_to','version','state','data'].map(column=>`CASE WHEN c.valid_from<=${date}::date THEN c.${column} ELSE h.${column} END AS ${column}`).join(',');
 return `(SELECT c.id,c.tenant_id,${columns} FROM ${d.table} c LEFT JOIN ${historicalRows(domain,tenant,date)} h ON h.id=c.id
 WHERE c.tenant_id=${tenant}::uuid AND (c.valid_from<=${date}::date OR h.id IS NOT NULL))`;
}
