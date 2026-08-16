-- Fixes withRlsBypass() failing on any RLS-protected table when the database
-- connection previously served a tenant-scoped request.
--
-- TenantScopeInterceptor sets app.tenant_id with `SET LOCAL` (via
-- set_config(..., true)) for one request's transaction. On COMMIT, Postgres
-- does not fully unset a custom GUC like that — it reverts to the session
-- default, which for a custom parameter no session-level SET has touched is
-- '' (empty string), not NULL. The next request landing on that same pooled
-- connection then sees current_setting('app.tenant_id', true) return '',
-- and casting '' to uuid raises a hard Postgres error (22P02) — regardless of
-- the `OR current_setting('app.bypass_rls', true) = 'on'` clause, since
-- Postgres does not guarantee the cast is skipped once the OR is already true.
--
-- withRlsBypass() (platform-admin, cross-tenant reads) only ever sets
-- app.bypass_rls, never app.tenant_id, so it has no way to clear that stale
-- value itself. The robust fix belongs in the policy: nullif(value, '') turns
-- an empty string into NULL before the cast, and NULL::uuid never raises —
-- it simply compares false, falling through to the bypass check as intended.
--
-- Confirmed with a real request sequence in test/rls.e2e-spec.ts: a
-- tenant-scoped request followed by a platform-admin request reusing the same
-- connection (DATABASE_URL?connection_limit=1) reproduced this on every run
-- before this migration, and passes after it.

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'customers',
    'product_categories',
    'product_taxes',
    'products',
    'product_category_assignments',
    'product_tax_assignments',
    'product_variants',
    'product_images',
    'locations',
    'shippings',
    'coupons',
    'orders',
    'order_items',
    'tenant_payment_settings',
    'visits'
  ]
  LOOP
    EXECUTE format('DROP POLICY tenant_isolation ON %I', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid OR current_setting(''app.bypass_rls'', true) = ''on'')
         WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid OR current_setting(''app.bypass_rls'', true) = ''on'')',
      tbl
    );
  END LOOP;
END $$;

DROP POLICY tenant_isolation ON "email_templates";
CREATE POLICY tenant_isolation ON "email_templates"
  USING (
    tenant_id IS NULL
    OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    OR current_setting('app.bypass_rls', true) = 'on'
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    OR current_setting('app.bypass_rls', true) = 'on'
  );
