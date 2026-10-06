CREATE TABLE redeployments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 org_id uuid NOT NULL,
 worker_id uuid NOT NULL,
 valid_from date NOT NULL,
 valid_to date,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 state text NOT NULL DEFAULT 'active',
 data jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,worker_id),
 FOREIGN KEY(tenant_id,org_id) REFERENCES org_units(tenant_id,id),
 FOREIGN KEY(tenant_id,worker_id) REFERENCES workers(tenant_id,id),
 CHECK(valid_to IS NULL OR valid_to>valid_from),
 CHECK((data->>'fte')::numeric>0 AND (data->>'fte')::numeric<=1),
 CHECK(data->>'placementDeadline' IS NULL OR (data->>'placementDeadline')::date>(data->>'availableFrom')::date)
);
CREATE INDEX redeployment_scope ON redeployments(tenant_id,org_id,valid_from);
ALTER TABLE redeployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE redeployments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON redeployments USING(tenant_visible(tenant_id)) WITH CHECK(tenant_visible(tenant_id));
