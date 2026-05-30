-- VectorScape — RLS cross-tenant isolation test
--
-- Proves that a user in tenant B cannot read, update, or delete a project
-- owned by tenant A. The DO block sets local role + JWT claims to simulate
-- each authenticated user and RAISEs on any policy leak. The surrounding
-- transaction is rolled back so the test leaves no residue.
--
-- Run with: `supabase db query --linked --file supabase/tests/rls_cross_tenant.sql`
-- A successful run prints `NOTICE: RLS cross-tenant test: PASS` and rolls back.

begin;

-- Two synthetic auth.users + matching profiles. We bypass the auto-trigger
-- by inserting profiles explicitly so each user lands in a known tenant.
do $$
declare
  user_a uuid := '00000000-0000-0000-0000-00000000000a';
  user_b uuid := '00000000-0000-0000-0000-00000000000b';
  tenant_a uuid := '11111111-1111-1111-1111-1111111111aa';
  tenant_b uuid := '22222222-2222-2222-2222-2222222222bb';
  project_a uuid;
  visible_count integer;
  affected integer;
begin
  insert into auth.users (id, email, instance_id, aud, role)
  values
    (user_a, 'a@example.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
    (user_b, 'b@example.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
  on conflict (id) do nothing;

  insert into public.profiles (user_id, tenant_id) values
    (user_a, tenant_a),
    (user_b, tenant_b)
  on conflict (user_id) do update set tenant_id = excluded.tenant_id;

  -- --- Act as user A: create a project in tenant A. -----------------------
  perform set_config('role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text,
    true
  );

  insert into public.projects (tenant_id, name)
  values (tenant_a, 'tenant-a secret project')
  returning id into project_a;

  select count(*) into visible_count from public.projects where id = project_a;
  if visible_count <> 1 then
    raise exception 'setup: tenant A should see its own project (saw %)', visible_count;
  end if;

  -- --- Switch to user B (tenant B). ---------------------------------------
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', user_b::text, 'role', 'authenticated')::text,
    true
  );

  -- SELECT must return zero rows (RLS hides tenant A's project).
  select count(*) into visible_count from public.projects where id = project_a;
  if visible_count <> 0 then
    raise exception
      'RLS LEAK: tenant B saw tenant A''s project (count=%) — fix policies before shipping',
      visible_count;
  end if;

  -- UPDATE must affect zero rows.
  update public.projects set name = 'pwned' where id = project_a;
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'RLS LEAK: tenant B updated tenant A''s project (rows=%)', affected;
  end if;

  -- DELETE must affect zero rows.
  delete from public.projects where id = project_a;
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'RLS LEAK: tenant B deleted tenant A''s project (rows=%)', affected;
  end if;

  -- INSERT into tenant A while acting as tenant B must be blocked by WITH CHECK.
  begin
    insert into public.projects (tenant_id, name)
    values (tenant_a, 'tenant B forging into tenant A');
    raise exception 'RLS LEAK: tenant B inserted a row tagged with tenant A';
  exception
    when insufficient_privilege then
      null;  -- expected: WITH CHECK rejects.
    when check_violation then
      null;
  end;

  -- Sanity: tenant A still sees its row, unmodified.
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text,
    true
  );
  select count(*) into visible_count
  from public.projects
  where id = project_a and name = 'tenant-a secret project';
  if visible_count <> 1 then
    raise exception 'tenant A lost visibility of its own project (count=%)', visible_count;
  end if;

  raise notice 'RLS cross-tenant test: PASS';
end;
$$;

-- Visible in result rows. Only reached if every assertion above passed,
-- because raise exception aborts the transaction before this point.
select 'PASS'::text as rls_cross_tenant_test;

rollback;
