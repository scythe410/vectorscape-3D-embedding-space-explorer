-- VectorScape — waitlist RLS test
--
-- Proves the waitlist's two-policy contract:
--   1. anon AND authenticated can INSERT (public marketing capture).
--   2. NO ONE can SELECT — not anon, not authenticated, not even via
--      reading their own row by email. The waitlist is a write-only sink
--      for the application; analytics queries use service-role.
--
-- The unique-on-(email, platform) constraint is also exercised so the
-- "23505 → already on the list" branch in /api/waitlist is grounded in
-- the actual schema.
--
-- Run with: `supabase db query --linked --file supabase/tests/waitlist_rls.sql`
-- A successful run prints `NOTICE: waitlist RLS test: PASS` and rolls back.

begin;

do $$
declare
  anon_visible integer;
  auth_visible integer;
  inserted_id uuid;
  user_x uuid := '00000000-0000-0000-0000-0000000000bb';
  caught text;
begin
  -- Seed: write one row via service-role (the DO block runs as superuser
  -- by default, so this bypasses RLS). The two RLS-scoped probes below
  -- should still see ZERO rows because there is no SELECT policy.
  insert into public.waitlist (email, platform)
  values ('seeded@example.test', 'quest')
  on conflict do nothing;

  -- ----------------------------------------------------------------------
  -- 1. anon SELECT must see nothing.
  -- ----------------------------------------------------------------------
  perform set_config('role', 'anon', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('role', 'anon')::text,
    true
  );
  set local role anon;

  select count(*) into anon_visible from public.waitlist;
  if anon_visible <> 0 then
    raise exception 'waitlist: anon should see 0 rows, saw %', anon_visible;
  end if;

  -- ----------------------------------------------------------------------
  -- 2. anon INSERT must succeed (public capture).
  -- ----------------------------------------------------------------------
  insert into public.waitlist (email, platform)
  values ('anon-probe@example.test', 'vision_pro')
  returning id into inserted_id;
  if inserted_id is null then
    raise exception 'waitlist: anon insert should have succeeded';
  end if;

  -- ----------------------------------------------------------------------
  -- 3. Re-insert the same (email, platform) must violate the unique index
  --    with sqlstate 23505 — this is the contract /api/waitlist relies on
  --    when surfacing "already on the list".
  -- ----------------------------------------------------------------------
  begin
    insert into public.waitlist (email, platform)
    values ('anon-probe@example.test', 'vision_pro');
    raise exception 'waitlist: duplicate insert should have raised 23505';
  exception when unique_violation then
    caught := 'expected';
  end;
  if caught <> 'expected' then
    raise exception 'waitlist: duplicate insert did not raise';
  end if;

  -- ----------------------------------------------------------------------
  -- 4. authenticated SELECT must also see nothing.
  -- ----------------------------------------------------------------------
  reset role;
  perform set_config('role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', user_x::text, 'role', 'authenticated')::text,
    true
  );
  set local role authenticated;

  select count(*) into auth_visible from public.waitlist;
  if auth_visible <> 0 then
    raise exception 'waitlist: authenticated should see 0 rows, saw %', auth_visible;
  end if;

  -- ----------------------------------------------------------------------
  -- 5. authenticated INSERT must succeed too (same capture, signed-in).
  -- ----------------------------------------------------------------------
  insert into public.waitlist (email, platform)
  values ('auth-probe@example.test', 'quest')
  returning id into inserted_id;
  if inserted_id is null then
    raise exception 'waitlist: authenticated insert should have succeeded';
  end if;

  reset role;
  raise notice 'waitlist RLS test: PASS';
end $$;

-- Surface a visible success row for the Management API JSON envelope.
select 'PASS' as waitlist_rls_test;

rollback;
