-- VectorScape — Row Level Security policies
-- Rule: a user can only see/touch tenant-scoped rows whose tenant_id matches
-- their profile. waitlist is write-only for anon.

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.points   enable row level security;
alter table public.clusters enable row level security;
alter table public.waitlist enable row level security;

-- ---------------------------------------------------------------------------
-- profiles: a user can read/update only their own profile row.
-- ---------------------------------------------------------------------------
create policy profiles_self_select on public.profiles
  for select to authenticated
  using (user_id = auth.uid());

create policy profiles_self_update on public.profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- projects / points / clusters: tenant-scoped CRUD.
-- public.current_tenant_id() resolves auth.uid() -> tenant_id via profiles.
-- ---------------------------------------------------------------------------
create policy projects_tenant_rw on public.projects
  for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy points_tenant_rw on public.points
  for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy clusters_tenant_rw on public.clusters
  for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- ---------------------------------------------------------------------------
-- waitlist: anyone (anon) can insert; nobody reads via the API.
-- ---------------------------------------------------------------------------
create policy waitlist_public_insert on public.waitlist
  for insert to anon, authenticated
  with check (true);
