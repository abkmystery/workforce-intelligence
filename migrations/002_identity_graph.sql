CREATE TABLE IF NOT EXISTS oauth_transactions (
 token_hash text PRIMARY KEY, tenant_id uuid NOT NULL, state text NOT NULL, nonce text NOT NULL,
 verifier text NOT NULL, expires_at timestamptz NOT NULL
);
ALTER TABLE access_grants ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE access_grants ADD COLUMN IF NOT EXISTS source_key text;
CREATE TABLE IF NOT EXISTS sync_connections (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id), enabled boolean NOT NULL DEFAULT false,
 paused boolean NOT NULL DEFAULT true, include_guests boolean NOT NULL DEFAULT false,
 inclusion_groups jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sync_runs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), kind text NOT NULL,
 status text NOT NULL, processed integer NOT NULL DEFAULT 0, error_code text,
 started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS sync_checkpoints (
 tenant_id uuid NOT NULL REFERENCES tenants(id), stream text NOT NULL, next_url text,
 delta_url text, generation uuid, full_scan boolean NOT NULL DEFAULT true,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,stream)
);
CREATE TABLE IF NOT EXISTS graph_directory_projection (
 tenant_id uuid NOT NULL REFERENCES tenants(id), object_id uuid NOT NULL,
 display_name text, mail text, user_principal_name text, job_title text, department text,
 account_enabled boolean NOT NULL DEFAULT false, user_type text, active boolean NOT NULL DEFAULT false,
 generation uuid, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,object_id)
);
CREATE INDEX IF NOT EXISTS graph_directory_active ON graph_directory_projection(tenant_id,active,object_id);
CREATE TABLE IF NOT EXISTS graph_manager_projection (
 tenant_id uuid NOT NULL REFERENCES tenants(id), object_id uuid NOT NULL, manager_object_id uuid,
 checked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,object_id)
);
CREATE TABLE IF NOT EXISTS graph_group_memberships (
 tenant_id uuid NOT NULL REFERENCES tenants(id), group_id uuid NOT NULL, object_id uuid NOT NULL,
 generation uuid NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,group_id,object_id)
);
CREATE TABLE IF NOT EXISTS graph_entitlement_refresh (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id), checked_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS graph_department_mappings (
 tenant_id uuid NOT NULL REFERENCES tenants(id),department text NOT NULL,org_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,department),FOREIGN KEY(tenant_id,org_id) REFERENCES org_units(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS graph_object_links (
 tenant_id uuid NOT NULL REFERENCES tenants(id),object_id uuid NOT NULL,worker_id uuid,
 directory_id uuid NOT NULL,identity_id uuid,PRIMARY KEY(tenant_id,object_id),
 FOREIGN KEY(tenant_id,worker_id) REFERENCES workers(tenant_id,id),
 FOREIGN KEY(tenant_id,directory_id) REFERENCES directory_accounts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS sensitive_access_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),
 kind text NOT NULL CHECK(kind IN ('grants','mappings')),payload jsonb NOT NULL,
 requested_by uuid NOT NULL,approved_by uuid,state text NOT NULL DEFAULT 'pending',
 created_at timestamptz NOT NULL DEFAULT now(),decided_at timestamptz,
 FOREIGN KEY(tenant_id,requested_by) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,approved_by) REFERENCES principals(tenant_id,id),
 CHECK(approved_by IS NULL OR approved_by<>requested_by)
);
-- OAuth browser transactions are bootstrap records addressed by an opaque hash.
-- Every directory/administration table requires the transaction's tenant context.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['sync_connections','sync_runs','sync_checkpoints','graph_directory_projection',
  'graph_manager_projection','graph_group_memberships','graph_entitlement_refresh','graph_department_mappings',
  'graph_object_links','sensitive_access_requests'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_visible(tenant_id)) WITH CHECK(tenant_visible(tenant_id))',t);
 END LOOP;
END $$;
