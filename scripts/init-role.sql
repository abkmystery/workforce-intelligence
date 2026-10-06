-- Isolated local development credentials only. Provision managed credentials separately in Azure.
CREATE ROLE workforce_app LOGIN PASSWORD 'local-development-only' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
