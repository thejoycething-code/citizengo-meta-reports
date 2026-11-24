-- México team (3 Nov 2026): Elisa trials the desk for CitizenGO México and
-- CitizenGO Latam. Run once in the Supabase SQL editor BEFORE deploying the
-- code that reads these columns. Safe to run twice.

-- 1. Each team's time zone (Analytics best times, inbox hours). Existing teams
--    keep UK time.
alter table public.engine_teams add column if not exists tz text not null default 'Europe/London';
comment on column public.engine_teams.tz is 'IANA time zone the team works in: Analytics best times and inbox hours use it.';

-- 2. The México team: Mexico and Latam pages (both already collected nightly).
--    Elisa joins through an invite link from Settings › Team and access; her
--    posting rights come from her own Facebook connection, as for everyone.
insert into public.engine_teams (id, name, flag, tz, accounts) values ('mx', 'México', '🇲🇽', 'America/Mexico_City', '[
  {"key": "mx-fb", "name": "Citizengo México", "page_id": "1281328458390126", "platform": "facebook"},
  {"key": "mx-ig", "name": "citizengo_mexico", "ig_id": "17841417546423111", "handle": "citizengo_mexico", "platform": "instagram"},
  {"key": "latam-fb", "name": "CitizenGO Latam", "page_id": "113661646716028", "platform": "facebook"},
  {"key": "latam-ig", "name": "citizengo_latam", "ig_id": "17841465038522259", "handle": "citizengo_latam", "platform": "instagram"},
  {"key": "latam-x", "name": "@CitizenGOes", "handle": "CitizenGOes", "platform": "x"}
]'::jsonb) on conflict (id) do nothing;
insert into public.engine_members (team_id, who, role, added_by) values ('mx', 'chris', 'admin', 'setup')
  on conflict (team_id, who) do nothing;

-- 3. Mexican key dates for the calendar (the 19 CitizenGO-wide ones show too).
insert into public.engine_key_dates (team_id, starts, title, kind, confidence)
select 'mx', d.starts::date, d.title, d.kind, 'calendar' from (values
  ('2026-12-12', 'Our Lady of Guadalupe (Día de la Virgen de Guadalupe)', 'key'),
  ('2027-01-06', 'Epiphany (Día de Reyes)', 'key'),
  ('2027-03-07', 'Family Day (Día de la Familia, first Sunday of March)', 'key'),
  ('2027-04-30', 'Children''s Day (Día del Niño)', 'key'),
  ('2027-05-10', 'Mother''s Day (Día de las Madres)', 'mothers_day'),
  ('2027-06-20', 'Father''s Day (Día del Padre)', 'key'),
  ('2027-09-16', 'Independence Day (Día de la Independencia)', 'key'),
  ('2027-11-02', 'Day of the Dead (Día de Muertos)', 'key'),
  ('2027-12-12', 'Our Lady of Guadalupe (Día de la Virgen de Guadalupe)', 'key')
) as d(starts, title, kind)
where not exists (select 1 from public.engine_key_dates k where k.team_id = 'mx' and k.starts = d.starts::date and k.title = d.title);

-- 4. Listening news: which Google News edition a headline came from (UK, or
--    Mexico in Spanish). Existing rows are the UK edition.
alter table public.listen_news add column if not exists edition text not null default 'uk';
create index if not exists listen_news_edition_published on public.listen_news (edition, published_at desc);
