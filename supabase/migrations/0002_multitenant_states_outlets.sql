-- =====================================================================
-- BAIZEBOSS — Stage 2: Companies (tenant root) + States + Outlets
-- =====================================================================
-- Run this once in Supabase: Dashboard > SQL Editor > New query > paste
-- this whole file > Run. Or via CLI: supabase db push
--
-- This migration is purely additive. It does not alter the shape or
-- behavior of anything from 0001_init.sql — every existing table,
-- policy, trigger, and RPC keeps working exactly as before. It adds:
--   1. companies   — the tenant root (one row: BaizeBoss, for now)
--   2. states      — geographic grouping under a company
--   3. outlets     — enterprise-hierarchy location, linked to the
--                    existing `branches` rows (1:1) so nothing about
--                    `branches` itself changes
--   4. company_id  — added to every existing table, backfilled to the
--                    single BaizeBoss company, so the whole system is
--                    tenant-aware from today even though only one
--                    tenant exists.
--
-- See BAIZEBOSS_Stage2_Spec.md for the full design rationale, including
-- why existing tables' RLS policies are deliberately left unchanged in
-- this stage (Security Impact section).
-- =====================================================================

-- ---------------------------------------------------------------------
-- COMPANIES  (tenant root)
-- ---------------------------------------------------------------------
create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);

insert into companies (name, slug)
values ('BaizeBoss', 'baizeboss')
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------
-- STATES
-- ---------------------------------------------------------------------
create table if not exists states (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);

insert into states (company_id, name)
select c.id, s.name
from companies c
cross join (values ('Rivers'), ('FCT'), ('Kaduna')) as s(name)
where c.slug = 'baizeboss'
on conflict (company_id, name) do nothing;

-- ---------------------------------------------------------------------
-- OUTLETS  (enterprise-hierarchy location; linked 1:1 to existing
-- `branches` rows so Phase 1 code and data are untouched)
-- ---------------------------------------------------------------------
create table if not exists outlets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  state_id uuid not null references states(id),
  branch_id text references branches(id),
  name text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_outlets_branch on outlets (branch_id);

-- Seed: one outlet per existing branch, mapped to the correct state.
-- ph -> Rivers, abj -> FCT, kad -> Kaduna
insert into outlets (company_id, state_id, branch_id, name)
select c.id, st.id, b.id, b.name
from branches b
join companies c on c.slug = 'baizeboss'
join states st on st.company_id = c.id
  and st.name = case b.id
    when 'ph'  then 'Rivers'
    when 'abj' then 'FCT'
    when 'kad' then 'Kaduna'
  end
where b.id in ('ph','abj','kad')
  and not exists (
    select 1 from outlets o where o.branch_id = b.id
  );

-- ---------------------------------------------------------------------
-- company_id RETROFIT — added nullable, backfilled, then locked to
-- NOT NULL, so the migration can never fail partway through and leave
-- existing rows unreadable.
-- ---------------------------------------------------------------------

-- branches
alter table branches add column if not exists company_id uuid references companies(id);
update branches set company_id = (select id from companies where slug = 'baizeboss')
  where company_id is null;
alter table branches alter column company_id set not null;

-- profiles
alter table profiles add column if not exists company_id uuid references companies(id);
update profiles set company_id = (select id from companies where slug = 'baizeboss')
  where company_id is null;
alter table profiles alter column company_id set not null;

-- stations
alter table stations add column if not exists company_id uuid references companies(id);
update stations set company_id = (select id from companies where slug = 'baizeboss')
  where company_id is null;
alter table stations alter column company_id set not null;

-- transactions
alter table transactions add column if not exists company_id uuid references companies(id);
update transactions set company_id = (select id from companies where slug = 'baizeboss')
  where company_id is null;
alter table transactions alter column company_id set not null;

-- remittances
alter table remittances add column if not exists company_id uuid references companies(id);
update remittances set company_id = (select id from companies where slug = 'baizeboss')
  where company_id is null;
alter table remittances alter column company_id set not null;

-- ---------------------------------------------------------------------
-- current_company() — security-definer helper, same pattern as
-- current_role()/current_branch() from 0001_init.sql
-- ---------------------------------------------------------------------
create or replace function public.current_company()
returns uuid
language sql stable security definer set search_path = public as $$
  select company_id from profiles where id = auth.uid();
$$;

-- =====================================================================
-- ROW LEVEL SECURITY — new tables only.
--
-- Existing tables (branches, profiles, stations, transactions,
-- remittances) are NOT touched here. Their current policies already
-- correctly protect real data, and with a single tenant there is no
-- functional gap. The tenant-isolation clause
-- (`and company_id = public.current_company()`) gets added to those
-- five tables' policies in whichever future stage actually onboards a
-- second company — see Stage 2 spec, Security Impact section.
-- =====================================================================
alter table companies enable row level security;
alter table states enable row level security;
alter table outlets enable row level security;

-- ---------------------- COMPANIES ----------------------
drop policy if exists companies_select on companies;
create policy companies_select on companies
  for select using (id = public.current_company());

drop policy if exists companies_write_owner on companies;
create policy companies_write_owner on companies
  for all using (public.is_owner() and id = public.current_company())
  with check (public.is_owner() and id = public.current_company());

-- ---------------------- STATES ----------------------
drop policy if exists states_select on states;
create policy states_select on states
  for select using (company_id = public.current_company());

drop policy if exists states_write_owner on states;
create policy states_write_owner on states
  for all using (public.is_owner() and company_id = public.current_company())
  with check (public.is_owner() and company_id = public.current_company());

-- ---------------------- OUTLETS ----------------------
drop policy if exists outlets_select on outlets;
create policy outlets_select on outlets
  for select using (company_id = public.current_company());

drop policy if exists outlets_write_owner on outlets;
create policy outlets_write_owner on outlets
  for all using (public.is_owner() and company_id = public.current_company())
  with check (public.is_owner() and company_id = public.current_company());

-- =====================================================================
-- Done. Verification queries (run these after, not part of the
-- migration itself):
--
--   select count(*) from companies;              -- expect 1
--   select count(*) from states;                  -- expect 3
--   select count(*) from outlets;                 -- expect 3
--   select * from outlets;                         -- confirm branch_id
--                                                    links are correct
--   select count(*) from branches where company_id is null;      -- 0
--   select count(*) from profiles where company_id is null;      -- 0
--   select count(*) from stations where company_id is null;      -- 0
--   select count(*) from transactions where company_id is null;  -- 0
--   select count(*) from remittances where company_id is null;   -- 0
-- =====================================================================