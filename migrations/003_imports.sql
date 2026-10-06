CREATE TABLE IF NOT EXISTS import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL,
  domain text NOT NULL,
  operation text NOT NULL,
  mode text NOT NULL,
  format text NOT NULL,
  file_name text NOT NULL,
  file_sha256 text NOT NULL,
  schema_hash text NOT NULL,
  permission_hash text NOT NULL,
  auth_version integer NOT NULL,
  preview_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('previewed','queued','processing','completed','failed','reversed','validated')),
  row_count integer NOT NULL DEFAULT 0,
  valid_count integer NOT NULL DEFAULT 0,
  selected_rows jsonb,
  job_id uuid,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  reversed_at timestamptz,
  CONSTRAINT import_batches_tenant_id_id UNIQUE (tenant_id,id)
);
CREATE INDEX IF NOT EXISTS import_batches_tenant_actor ON import_batches(tenant_id,actor_id,created_at DESC);

CREATE TABLE IF NOT EXISTS import_rows (
  tenant_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  row_number integer NOT NULL,
  raw jsonb NOT NULL,
  mutation jsonb,
  preview_diff jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL CHECK (status IN ('valid','invalid','skipped','applied','reversed')),
  prior_snapshot jsonb,
  applied_snapshot jsonb,
  outcome jsonb,
  PRIMARY KEY (tenant_id,batch_id,row_number),
  FOREIGN KEY (tenant_id,batch_id) REFERENCES import_batches(tenant_id,id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS export_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL,
  domain text NOT NULL,
  format text NOT NULL,
  row_count integer NOT NULL,
  scope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS export_files_tenant_actor ON export_files(tenant_id,actor_id,created_at DESC);

ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY import_batches_tenant ON import_batches USING (tenant_visible(tenant_id)) WITH CHECK (tenant_visible(tenant_id));
ALTER TABLE import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY import_rows_tenant ON import_rows USING (tenant_visible(tenant_id)) WITH CHECK (tenant_visible(tenant_id));
ALTER TABLE export_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_files FORCE ROW LEVEL SECURITY;
CREATE POLICY export_files_tenant ON export_files USING (tenant_visible(tenant_id)) WITH CHECK (tenant_visible(tenant_id));
