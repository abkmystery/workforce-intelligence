CREATE TABLE graph_manager_checkpoints (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id), generation uuid NOT NULL,
 after_object_id uuid, upper_object_id uuid,
 started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 processed integer NOT NULL DEFAULT 0 CHECK(processed>=0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE graph_manager_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_manager_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON graph_manager_checkpoints
 USING(tenant_visible(tenant_id)) WITH CHECK(tenant_visible(tenant_id));
ALTER TABLE graph_manager_projection ADD COLUMN resolution text NOT NULL DEFAULT 'unknown'
 CHECK(resolution IN ('unknown','resolved','missing','inactive'));
