-- Measured 100k-worker paging plans spent most time reading duplicate creation
-- history. Disjoint effective-row queries now use current rows directly; these
-- cover their count predicates and locate future revisions without heap scans.
CREATE INDEX workers_effective_count ON workers(tenant_id,valid_from,id) INCLUDE(org_id,valid_to,state);
CREATE INDEX workers_org_effective_count ON workers(tenant_id,org_id,valid_from,id) INCLUDE(valid_to,state);
CREATE INDEX history_effective_lookup ON record_history(tenant_id,domain,record_id,((snapshot->>'validFrom')) DESC,version DESC);
