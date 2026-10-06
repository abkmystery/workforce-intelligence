-- JSON field addition: no rewrite of existing placement decisions/history.
ALTER TABLE redeployments ADD CONSTRAINT role_consideration_boolean
 CHECK(NOT (data ? 'considerForRoles') OR jsonb_typeof(data->'considerForRoles')='boolean');
