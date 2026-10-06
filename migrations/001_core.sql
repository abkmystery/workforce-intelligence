CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE tenants(id uuid PRIMARY KEY,name text NOT NULL,settings jsonb NOT NULL DEFAULT '{}',auth_version integer NOT NULL DEFAULT 1);
CREATE TABLE principals(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),entra_object_id uuid NOT NULL,roles jsonb NOT NULL DEFAULT '[]',enabled boolean NOT NULL DEFAULT true,auth_version integer NOT NULL DEFAULT 1,UNIQUE(tenant_id,id),UNIQUE(tenant_id,entra_object_id));
CREATE TABLE sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),principal_id uuid NOT NULL,token_hash text NOT NULL UNIQUE,expires_at timestamptz NOT NULL,auth_version integer NOT NULL,entitlements_checked_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id));
CREATE TABLE access_grants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),principal_id uuid NOT NULL,domain text NOT NULL,operation text NOT NULL,data_class text NOT NULL,org_id uuid,scope text NOT NULL CHECK(scope IN ('tenant','org','subtree','reports')),valid_from date NOT NULL DEFAULT CURRENT_DATE,valid_to date,source text,source_key text,FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id),CHECK(valid_to IS NULL OR valid_to>valid_from),CHECK((scope='tenant')=(org_id IS NULL)));
CREATE INDEX grants_principal ON access_grants(tenant_id,principal_id);
CREATE TABLE group_mappings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),group_id uuid,app_role text,domain text NOT NULL,operation text NOT NULL,data_class text NOT NULL,org_id uuid,scope text NOT NULL,enabled boolean NOT NULL DEFAULT true,CHECK(group_id IS NOT NULL OR app_role IS NOT NULL));
CREATE TABLE record_history(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),domain text NOT NULL,record_id uuid NOT NULL,version integer NOT NULL,snapshot jsonb NOT NULL,actor_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,domain,record_id,version));
CREATE TABLE audit_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),actor_id uuid NOT NULL,action text NOT NULL,domain text NOT NULL,record_id uuid,metadata jsonb NOT NULL DEFAULT '{}',previous_hash text NOT NULL,event_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX audit_scope ON audit_events(tenant_id,domain,record_id,id DESC);
CREATE FUNCTION immutable_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Append-only audit'; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION immutable_audit();
CREATE TABLE approvals(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),domain text NOT NULL,record_id uuid NOT NULL,record_version integer NOT NULL,stage text NOT NULL,actor_id uuid NOT NULL,decision text NOT NULL CHECK(decision IN ('approved','rejected','returned')),comment text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,domain,record_id,record_version,stage));
CREATE TABLE jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),kind text NOT NULL,payload jsonb NOT NULL,actor_id uuid NOT NULL,status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','dead','cancelled')),attempts integer NOT NULL DEFAULT 0,run_after timestamptz NOT NULL DEFAULT now(),locked_at timestamptz,locked_by text,error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX jobs_ready ON jobs(status,run_after) WHERE status IN ('queued','running');
CREATE TABLE field_provenance(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),domain text NOT NULL,record_id uuid NOT NULL,field text NOT NULL,owner text NOT NULL,source_key text,confidence text NOT NULL DEFAULT 'verified',actor_id uuid NOT NULL,seen_at timestamptz NOT NULL DEFAULT now(),override_id uuid,UNIQUE(tenant_id,domain,record_id,field));
CREATE TABLE scenario_baselines(tenant_id uuid NOT NULL REFERENCES tenants(id),scenario_id uuid NOT NULL,domain text NOT NULL,record_id uuid NOT NULL,version integer NOT NULL,snapshot jsonb NOT NULL,PRIMARY KEY(tenant_id,scenario_id,domain,record_id));
CREATE TABLE request_limits(tenant_id uuid NOT NULL,principal_id uuid NOT NULL,bucket timestamptz NOT NULL,count integer NOT NULL,PRIMARY KEY(tenant_id,principal_id,bucket));
CREATE FUNCTION tenant_visible(row_tenant uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT row_tenant::text=current_setting('app.tenant_id',true) $$;
DO $$ DECLARE t text; domain_tables text[]:=ARRAY['workers','identities','directory_accounts','external_identifiers','org_units','org_edges','reporting_lines','positions','vacancies','occupancy','role_families','roles','activities','title_mappings','hired_for','skills','worker_skills','contracts','calendars','holidays','assignments','availability','demands','request_skills','fulfillments','hiring_pipeline','movements','scenarios','scenario_deltas','compensation','fx_rates','budgets','cost_allocations','settings','field_policies','overrides','reconciliation','privacy_requests','reveals','saved_views','report_schedules','notifications'];
BEGIN
 FOREACH t IN ARRAY domain_tables LOOP
  EXECUTE format('CREATE TABLE %I(id uuid NOT NULL DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),org_id uuid,worker_id uuid,valid_from date NOT NULL DEFAULT CURRENT_DATE,valid_to date,version integer NOT NULL DEFAULT 1 CHECK(version>0),state text NOT NULL DEFAULT ''active'',data jsonb NOT NULL CHECK(jsonb_typeof(data)=''object''),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),CHECK(valid_to IS NULL OR valid_to>valid_from))',t);
  EXECUTE format('CREATE INDEX %I ON %I(tenant_id,org_id,valid_from,valid_to)',t||'_scope',t);
  EXECUTE format('CREATE INDEX %I ON %I(tenant_id,worker_id,valid_from,valid_to) WHERE worker_id IS NOT NULL',t||'_worker',t);
 END LOOP;
 FOREACH t IN ARRAY domain_tables LOOP
  IF t<>'workers' THEN EXECUTE format('ALTER TABLE %I ADD FOREIGN KEY(tenant_id,worker_id) REFERENCES workers(tenant_id,id)',t); END IF;
  EXECUTE format('ALTER TABLE %I ADD FOREIGN KEY(tenant_id,org_id) REFERENCES org_units(tenant_id,id)',t);
 END LOOP;
 FOREACH t IN ARRAY domain_tables||ARRAY['record_history','audit_events','approvals','jobs','field_provenance','scenario_baselines','request_limits','access_grants','group_mappings'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_visible(tenant_id)) WITH CHECK(tenant_visible(tenant_id))',t);
 END LOOP;
END $$;
CREATE UNIQUE INDEX worker_code_unique ON workers(tenant_id,(data->>'code'));
CREATE UNIQUE INDEX worker_hris_unique ON workers(tenant_id,(data->>'hrisKey')) WHERE data->>'hrisKey' IS NOT NULL AND data->>'hrisKey'<>'';
CREATE UNIQUE INDEX directory_object_unique ON directory_accounts(tenant_id,(data->>'objectId'));
CREATE UNIQUE INDEX external_key_unique ON external_identifiers(tenant_id,(data->>'source'),(data->>'externalKey'));
CREATE UNIQUE INDEX org_code_unique ON org_units(tenant_id,(data->>'code'));
CREATE UNIQUE INDEX position_code_unique ON positions(tenant_id,(data->>'code'));
CREATE UNIQUE INDEX demand_code_unique ON demands(tenant_id,(data->>'code'));
ALTER TABLE org_edges ADD CONSTRAINT no_overlapping_org_parents EXCLUDE USING gist(tenant_id WITH =,(data->>'childId') WITH =,(data->>'hierarchy') WITH =,daterange(valid_from,valid_to,'[)') WITH &&) WHERE(state<>'archived');
ALTER TABLE reporting_lines ADD CONSTRAINT no_overlapping_primary_managers EXCLUDE USING gist(tenant_id WITH =,worker_id WITH =,daterange(valid_from,valid_to,'[)') WITH &&) WHERE(state<>'archived' AND data->>'kind'='primary');
ALTER TABLE contracts ADD CONSTRAINT no_overlapping_contracts EXCLUDE USING gist(tenant_id WITH =,worker_id WITH =,daterange(valid_from,valid_to,'[)') WITH &&) WHERE(state<>'archived');
ALTER TABLE compensation ADD CONSTRAINT no_overlapping_pay EXCLUDE USING gist(tenant_id WITH =,worker_id WITH =,daterange(valid_from,valid_to,'[)') WITH &&) WHERE(state<>'archived');
ALTER TABLE assignments ADD CONSTRAINT valid_allocation CHECK((data->>'fte')::numeric>0 AND (data->>'fte')::numeric<=1);
ALTER TABLE contracts ADD CONSTRAINT valid_contract_fte CHECK((data->>'fte')::numeric>0 AND (data->>'fte')::numeric<=1);
ALTER TABLE compensation ADD CONSTRAINT positive_pay CHECK((data->>'amount')::numeric>=0 AND (data->>'burdenPercent')::numeric>=0);
-- Runtime role must not own tables, have DDL rights, or bypass RLS. Authentication bootstrap tables contain no workforce identity/pay.
