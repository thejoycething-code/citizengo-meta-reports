-- Read-only role for the shared MCP server. Applied 26 Aug 2026.
--
-- The MCP endpoint is reachable over HTTP. Holding service_role there would mean
-- a compromised endpoint had full read/write on EVERY table in the project,
-- including clacton_actions (2,192 supporter records with names, emails and
-- postcodes). This role reads the meta_* reporting tables and nothing else.
--
-- Verified after applying: SELECT yes on the five reporting objects, no INSERT,
-- and no access at all to meta_page_tokens, clacton_actions or clacton_events.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'meta_readonly') then
    create role meta_readonly nologin noinherit;
  end if;
end
$$;

grant meta_readonly to authenticator;
grant usage on schema public to meta_readonly;

grant select on public.meta_pages           to meta_readonly;
grant select on public.meta_posts           to meta_readonly;
grant select on public.meta_post_metrics    to meta_readonly;
grant select on public.meta_collection_runs to meta_readonly;
grant select on public.meta_post_latest     to meta_readonly;

-- RLS is on with no policies, so grants alone return zero rows. These permit
-- SELECT for this role only. No policy is added for anon, which is what keeps
-- the widget's public key away from this data.
do $$
declare t text;
begin
  foreach t in array array['meta_pages','meta_posts','meta_post_metrics','meta_collection_runs']
  loop
    execute format('drop policy if exists %I on public.%I', 'meta_readonly_select_' || t, t);
    execute format('create policy %I on public.%I for select to meta_readonly using (true)',
      'meta_readonly_select_' || t, t);
  end loop;
end
$$;

revoke all on public.meta_page_tokens from meta_readonly;
