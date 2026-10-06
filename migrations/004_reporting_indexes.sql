CREATE INDEX history_effective ON record_history(tenant_id,domain,record_id,((snapshot->>'validFrom')),version DESC);
CREATE INDEX assignment_status ON assignments(tenant_id,worker_id,(data->>'allocationStatus'));
CREATE INDEX fulfillment_request ON fulfillments(tenant_id,(data->>'demandId'),valid_from,valid_to);
CREATE INDEX org_parent ON org_edges(tenant_id,(data->>'parentId'),valid_from,valid_to);
CREATE INDEX manager_reports ON reporting_lines(tenant_id,(data->>'managerId'),valid_from,valid_to);
