-- Adds projects.error_message so the worker can surface failure reasons
-- alongside status='error' instead of swallowing exceptions.

alter table public.projects
  add column if not exists error_message text;
