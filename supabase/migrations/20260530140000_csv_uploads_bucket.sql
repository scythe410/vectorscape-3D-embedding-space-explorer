-- Private bucket for raw CSV uploads. Each file lives at <user_id>/<project_id>/<filename>;
-- RLS pins access to the owning user. Service role bypasses RLS for downstream jobs.

insert into storage.buckets (id, name, public)
values ('csv-uploads', 'csv-uploads', false)
on conflict (id) do nothing;

-- The folder convention is <auth.uid()>/...; storage.foldername() splits on '/'
-- so the first element is the user's UUID.

drop policy if exists csv_uploads_owner_read on storage.objects;
create policy csv_uploads_owner_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'csv-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists csv_uploads_owner_insert on storage.objects;
create policy csv_uploads_owner_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'csv-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists csv_uploads_owner_update on storage.objects;
create policy csv_uploads_owner_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'csv-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'csv-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists csv_uploads_owner_delete on storage.objects;
create policy csv_uploads_owner_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'csv-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
