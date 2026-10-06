ALTER TABLE export_files
  ADD COLUMN IF NOT EXISTS storage_key text,
  ADD COLUMN IF NOT EXISTS sha256 text,
  ADD COLUMN IF NOT EXISTS byte_count integer,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS auth_version integer,
  ADD COLUMN IF NOT EXISTS permission_hash text;

CREATE INDEX IF NOT EXISTS export_files_expiry ON export_files(tenant_id,expires_at)
  WHERE storage_key IS NOT NULL;
