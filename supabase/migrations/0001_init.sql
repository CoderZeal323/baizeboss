-- =====================================================================
-- BAIZEBOSS — multi-branch game station management: schema + RLS
-- "Where skill meets style."
-- =====================================================================
-- Run this once in Supabase: Dashboard > SQL Editor > New query > paste
-- this whole file > Run. Or via CLI: supabase db push
--
-- Phase 1 scope: branches, 3-tier roles (owner / manager / sales_rep),
-- stations (games), the append-only revenue + remittance ledgers, and
-- the reconciliation math. Later phases (inventory, loyalty, scorecards,
-- approvals, audit log, etc.) will add tables alongside these without
-- needing to change anything below.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- BRANCHES
-- ---------------------------------------------------------------------
create table if not exists branches (
  id text primary key,
  name text not null unique
);

insert into branches (id, name) values
  ('ph',  'Port Harcourt'),
  ('abj', 'Abuja'),
  ('kad', 'Kaduna')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- PROFILES  (one row per auth.users row — role + branch assignment)
--
-- Three-tier RBAC:
--   owner       — global, every branch, no branch_id
--   manager     — one branch; same floor access as sales_rep PLUS
--                 read access to their branch's reconciliation data
--   sales_rep   — one branch; runs sessions, customers, remittances
-- ---------------------------------------------------------------------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null default 'sales_rep' check (role in ('sales_rep','manager','owner')),
  branch_id text references branches(id),
  created_at timestamptz not null default now(),
  constraint branch_role_needs_branch check (
    (role in ('sales_rep','manager') and branch_id is not null) or (role = 'owner')
  )
);

-- Security-definer helpers so RLS policies on `profiles` don't recurse
-- into themselves when checking the caller's own role/branch.
create or replace function public.current_role()
returns text
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function public.current_branch()
returns text
language sql stable security definer set search_path = public as $$
  select branch_id from profiles where id = auth.uid();
$$;

create or replace function public.is_owner()
returns boolean
language sql stable as $$
  select coalesce(public.current_role() = 'owner', false);
$$;

create or replace function public.is_manager()
returns boolean
language sql stable as $$
  select coalesce(public.current_role() = 'manager', false);
$$;

-- ---------------------------------------------------------------------
-- STATIONS  (games/tables/consoles — name/type/rate is Owner-controlled
-- pricing; `active` is the live session state that branch staff flip)
-- ---------------------------------------------------------------------
create table if not exists stations (
  id uuid primary key default gen_random_uuid(),
  branch_id text not null references branches(id),
  name text not null,
  type text not null,          -- e.g. Snooker, PS5, Table Tennis, Chess, Scrabble
  rate numeric not null check (rate >= 0),
  active jsonb,                 -- {customer_name, phone, start_time, rate} | null
  created_at timestamptz not null default now()
);

-- Column-level lock: only the Owner may change name/type/rate/branch_id.
-- Branch staff may only ever flip the `active` (session) column.
create or replace function public.enforce_station_pricing_lock()
returns trigger
language plpgsql as $$
begin
  if not public.is_owner() then
    if new.name <> old.name or new.type <> old.type
       or new.rate <> old.rate or new.branch_id <> old.branch_id then
      raise exception 'Only the Owner account may change station name, type, rate, or branch.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_station_pricing_lock on stations;
create trigger trg_station_pricing_lock
  before update on stations
  for each row execute function public.enforce_station_pricing_lock();

-- ---------------------------------------------------------------------
-- TRANSACTIONS  (system ledger — append-only, never editable)
-- ---------------------------------------------------------------------
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  receipt_no text not null unique,
  branch_id text not null references branches(id),
  clerk_id uuid not null references profiles(id),
  clerk_name text not null,
  station_id uuid references stations(id),
  station_name text not null,
  station_type text not null,
  customer_name text not null,
  phone text,
  minutes numeric not null check (minutes > 0),
  rate numeric not null check (rate >= 0),
  total numeric not null check (total >= 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_transactions_branch_time on transactions (branch_id, created_at);

-- ---------------------------------------------------------------------
-- REMITTANCES  (staff-submitted cash handovers — also append-only)
-- ---------------------------------------------------------------------
create table if not exists remittances (
  id uuid primary key default gen_random_uuid(),
  branch_id text not null references branches(id),
  worker_id uuid not null references profiles(id),
  worker_name text not null,
  remit_date date not null,
  amount numeric not null check (amount > 0),
  note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_remittances_branch_time on remittances (branch_id, created_at);

-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
alter table branches enable row level security;
alter table profiles enable row level security;
alter table stations enable row level security;
alter table transactions enable row level security;
alter table remittances enable row level security;

-- ---------------------- BRANCHES ----------------------
drop policy if exists branches_select on branches;
create policy branches_select on branches
  for select using (auth.role() = 'authenticated');

drop policy if exists branches_write_owner on branches;
create policy branches_write_owner on branches
  for all using (public.is_owner()) with check (public.is_owner());

-- ---------------------- PROFILES ----------------------
-- Everyone can read their own profile; the Owner can read every profile.
drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles
  for select using (id = auth.uid() or public.is_owner());

-- Public self-registration may ONLY ever create a 'sales_rep' row for
-- itself with a branch attached. There is no client path to create an
-- 'owner' or 'manager' profile — 'manager' is granted later by the
-- Owner (Workers tab), and 'owner' must be created directly in the
-- database by whoever administers Supabase (see README).
drop policy if exists profiles_insert_self_sales_rep on profiles;
create policy profiles_insert_self_sales_rep on profiles
  for insert with check (
    id = auth.uid() and role = 'sales_rep' and branch_id is not null
  );

-- Only the Owner can edit/reassign/promote/delete a profile (branch
-- reassignment, rename, promotion to manager, deactivation).
drop policy if exists profiles_update_owner on profiles;
create policy profiles_update_owner on profiles
  for update using (public.is_owner()) with check (public.is_owner());

drop policy if exists profiles_delete_owner on profiles;
create policy profiles_delete_owner on profiles
  for delete using (public.is_owner());

-- ---------------------- STATIONS ----------------------
drop policy if exists stations_select on stations;
create policy stations_select on stations
  for select using (public.is_owner() or branch_id = public.current_branch());

-- Insert/delete of stations is Owner-only (pricing/inventory control).
drop policy if exists stations_insert_owner on stations;
create policy stations_insert_owner on stations
  for insert with check (public.is_owner());

drop policy if exists stations_delete_owner on stations;
create policy stations_delete_owner on stations
  for delete using (public.is_owner());

-- Update is allowed for the Owner (any field) OR branch staff acting on
-- their own branch's station (the trigger above still blocks non-owners
-- from changing name/type/rate/branch_id — only `active` may change).
drop policy if exists stations_update on stations;
create policy stations_update on stations
  for update using (public.is_owner() or branch_id = public.current_branch())
  with check (public.is_owner() or branch_id = public.current_branch());

-- ---------------------- TRANSACTIONS (immutable ledger) ----------------------
drop policy if exists transactions_select on transactions;
create policy transactions_select on transactions
  for select using (public.is_owner() or branch_id = public.current_branch());

-- Only branch staff (sales_rep or manager) may log a completed session,
-- only for their own branch, only attributed to themselves.
drop policy if exists transactions_insert_staff on transactions;
create policy transactions_insert_staff on transactions
  for insert with check (
    not public.is_owner()
    and branch_id = public.current_branch()
    and clerk_id = auth.uid()
  );

-- Deliberately no UPDATE or DELETE policy exists on this table for ANY
-- role, including the Owner. This is what makes it an uneditable
-- "System Expected Revenue" ledger.

-- ---------------------- REMITTANCES (immutable ledger) ----------------------
-- A sales rep sees only their own submissions. A manager sees every
-- remittance for their own branch (needed to spot-check before the
-- Owner does). The Owner sees everything.
drop policy if exists remittances_select on remittances;
create policy remittances_select on remittances
  for select using (
    public.is_owner()
    or worker_id = auth.uid()
    or (public.is_manager() and branch_id = public.current_branch())
  );

drop policy if exists remittances_insert_staff on remittances;
create policy remittances_insert_staff on remittances
  for insert with check (
    not public.is_owner()
    and branch_id = public.current_branch()
    and worker_id = auth.uid()
  );

-- No UPDATE/DELETE policy for anyone — once cash is remitted and
-- logged, the record cannot be altered by staff, a manager, or the
-- Owner. This is what makes the reconciliation trustworthy: neither
-- side of the A vs. B comparison can be quietly edited after the fact.

-- =====================================================================
-- end_session() — atomic "close out a station" operation
-- =====================================================================
-- Ending a session needs two writes (insert the ledger row, clear the
-- station) to happen together. Wrapping both in one SQL function makes
-- that atomic, and because the function runs SECURITY INVOKER (the
-- default), it still executes with the caller's own permissions — so
-- every RLS policy above still applies. Staff cannot use this to touch
-- another branch's station or forge a ledger entry.
create or replace function public.end_session(
  p_station_id uuid,
  p_minutes numeric,
  p_rate numeric,
  p_receipt_no text
) returns transactions
language plpgsql
as $$
declare
  v_station stations%rowtype;
  v_active jsonb;
  v_total numeric;
  v_row transactions%rowtype;
begin
  select * into v_station from stations where id = p_station_id;

  if v_station.id is null then
    raise exception 'Station not found';
  end if;

  if v_station.branch_id <> public.current_branch() and not public.is_owner() then
    raise exception 'Not authorized for this branch';
  end if;

  v_active := v_station.active;
  if v_active is null then
    raise exception 'Station has no active session to end';
  end if;

  if p_minutes <= 0 or p_rate < 0 then
    raise exception 'Invalid minutes or rate';
  end if;

  v_total := round((p_rate / 60.0) * p_minutes);

  insert into transactions (
    receipt_no, branch_id, clerk_id, clerk_name, station_id, station_name,
    station_type, customer_name, phone, minutes, rate, total
  ) values (
    p_receipt_no,
    v_station.branch_id,
    auth.uid(),
    (select full_name from profiles where id = auth.uid()),
    v_station.id,
    v_station.name,
    v_station.type,
    v_active ->> 'customer_name',
    v_active ->> 'phone',
    p_minutes,
    p_rate,
    v_total
  ) returning * into v_row;

  update stations set active = null where id = p_station_id;

  return v_row;
end;
$$;

revoke execute on function public.end_session(uuid, numeric, numeric, text) from public;
grant execute on function public.end_session(uuid, numeric, numeric, text) to authenticated;

-- =====================================================================
-- Done. Next step: create your first Owner account — see README.md
-- =====================================================================
