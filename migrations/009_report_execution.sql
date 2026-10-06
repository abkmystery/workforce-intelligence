CREATE TABLE report_schedule_cursors(
 tenant_id uuid NOT NULL REFERENCES tenants(id),schedule_id uuid NOT NULL,
 schedule_version integer NOT NULL,next_run_at timestamptz NOT NULL,error_code text,
 PRIMARY KEY(tenant_id,schedule_id),
 FOREIGN KEY(tenant_id,schedule_id) REFERENCES report_schedules(tenant_id,id)
);
CREATE TABLE report_runs(
 id uuid NOT NULL,tenant_id uuid NOT NULL REFERENCES tenants(id),schedule_id uuid NOT NULL,
 schedule_version integer NOT NULL,actor_id uuid NOT NULL,due_at timestamptz NOT NULL,
 request jsonb NOT NULL,job_id uuid NOT NULL,export_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,schedule_id,schedule_version,due_at),
 FOREIGN KEY(tenant_id,schedule_id) REFERENCES report_schedules(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['report_schedule_cursors','report_runs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_visible(tenant_id)) WITH CHECK(tenant_visible(tenant_id))',t);
 END LOOP;
END $$;
