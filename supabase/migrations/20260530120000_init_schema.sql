-- VectorScape — initial schema
-- Tables: profiles (auth.user <-> tenant), projects, points (pgvector 384), clusters, waitlist.
-- RLS: tenant-scoped reads/writes for projects/points/clusters; public insert for waitlist.

-- pgvector is shipped as the "vector" extension in the Supabase Postgres image.
create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------
-- profiles: links an auth.users row to a tenant_id. RLS uses this to scope.
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  tenant_id uuid not null,
  created_at timestamptz not null default now()
);

create index profiles_tenant_id_idx on public.profiles (tenant_id);

-- Helper: tenant of the current authenticated user. Stable so RLS can inline it.
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select tenant_id from public.profiles where user_id = auth.uid();
$$;

-- On signup, auto-create a profile with a fresh tenant_id (one tenant per user
-- by default; teams join an existing tenant by updating this row).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, tenant_id)
  values (new.id, gen_random_uuid());
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
create type public.project_status as enum ('pending', 'reducing', 'ready', 'error');

create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  name        text not null,
  status      public.project_status not null default 'pending',
  point_count integer not null default 0,
  embed_model text not null default 'all-MiniLM-L6-v2',
  reducer     text not null default 'pacmap',
  created_at  timestamptz not null default now()
);

create index projects_tenant_id_idx on public.projects (tenant_id);

-- ---------------------------------------------------------------------------
-- points: one row per embedded text. Carries tenant_id for direct RLS so we
-- never need a join on the hot path. embedding is pgvector 384-dim.
-- ---------------------------------------------------------------------------
create table public.points (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.projects (id) on delete cascade,
  tenant_id           uuid not null,
  text                text not null,
  x                   real not null,
  y                   real not null,
  z                   real not null,
  cluster_id          integer,
  cluster_probability real,
  embedding           extensions.vector(384)
);

create index points_project_id_idx on public.points (project_id);
create index points_tenant_id_idx  on public.points (tenant_id);
create index points_cluster_idx    on public.points (project_id, cluster_id);

-- ---------------------------------------------------------------------------
-- clusters
-- ---------------------------------------------------------------------------
create table public.clusters (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete cascade,
  tenant_id       uuid not null,
  cluster_id      integer not null,
  label           text,
  cx              real not null,
  cy              real not null,
  cz              real not null,
  medoid_point_id uuid references public.points (id) on delete set null,
  size            integer not null default 0,
  unique (project_id, cluster_id)
);

create index clusters_tenant_id_idx on public.clusters (tenant_id);

-- ---------------------------------------------------------------------------
-- waitlist (public insert; no reads from anon)
-- ---------------------------------------------------------------------------
create type public.waitlist_platform as enum ('quest', 'vision_pro');

create table public.waitlist (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  platform   public.waitlist_platform not null,
  created_at timestamptz not null default now()
);

create unique index waitlist_email_platform_idx on public.waitlist (email, platform);
