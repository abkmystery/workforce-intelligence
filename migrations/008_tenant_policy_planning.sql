-- Keep the indexed tenant UUID on the column side. Casting every tenant_id to
-- text prevented useful selectivity estimates in large, RLS-protected joins.
-- Unset or reset transaction context still yields NULL and denies every row.
CREATE OR REPLACE FUNCTION tenant_visible(row_tenant uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT row_tenant = NULLIF(current_setting('app.tenant_id',true),'')::uuid
$$;
