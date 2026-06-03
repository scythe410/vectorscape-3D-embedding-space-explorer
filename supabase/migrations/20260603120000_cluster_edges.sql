-- VectorScape — cluster_edges
--
-- Top semantic adjacencies between named clusters, computed in the original
-- embedding space (NOT in 3D — UMAP/PaCMAP distort global distance, so 3D
-- nearness lies). The reducer writes 0..top_n rows per project; the engine
-- reads them and draws faint lines.
--
-- Canonical form: cluster_a < cluster_b in every row, enforced by check.

create table public.cluster_edges (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  tenant_id   uuid not null,
  cluster_a   integer not null,
  cluster_b   integer not null,
  similarity  real not null,
  created_at  timestamptz not null default now(),
  unique (project_id, cluster_a, cluster_b),
  check (cluster_a < cluster_b)
);

create index cluster_edges_project_idx on public.cluster_edges (project_id);
create index cluster_edges_tenant_idx  on public.cluster_edges (tenant_id);

alter table public.cluster_edges enable row level security;

create policy cluster_edges_tenant_rw on public.cluster_edges
  for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());
