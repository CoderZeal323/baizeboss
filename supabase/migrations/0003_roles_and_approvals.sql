-- =====================================================================
-- BAIZEBOSS — Stage 3: Roles (General Manager, Branch Supervisor) +
-- per-table pending-approval flags on States & Outlets
-- =====================================================================
-- Run this once in Supabase: Dashboard > SQL Editor > New query > paste
-- this whole file > Run. Or via CLI: supabase db push
--
-- Purely additive on top of 0001_init.sql and
-- 0002_multitenant_states_outlets.sql. Existing owner/manager/sales_rep
-- accounts and all Phase 1 behavior are untouched. See
-- BAIZEBOSS_Stage3_Spec.md for full rationale.
--
-- Design note on approval columns (slightly more precise than the
-- spec's plain-English description, same intent): `status` always
-- reflects the record's TRUE current operational state. A pending
-- activate/deactivate request does NOT change `status` — it sets
-- `pending_action` instead, so the record keeps behaving as whatever
-- it currently is until the Owner decides. Only a pending CREATE has
-- no prior state to preserve, so it legitimately sits in
-- status = 'pending_approval' until approved.
-- =====================================================================

-- ---------------------------------------------------------------------
-- PROFILES — widen roles, add outlet scoping for Branch Supervisor
-- ---------------------------------------------------------------------
alter table profiles add column if not exists outlet_id uuid references outlets(id);

alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('sales_rep','manager','owner','general_manager','branch_supervisor'));

alter table profiles drop constraint if exists branch_role_needs_branch;
alter table profiles add constraint branch_role_needs_branch check (
  (role in ('sales_rep','manager') and branch_id is not null)
  or (role = 'branch_supervisor' and outlet_id is not null)
  or (role in ('owner','general_manager'))
);

-- ---------------------------------------------------------------------
-- Role helpers — same pattern as current_role()/is_owner()/is_manager()
-- from 0001_init.sql
-- ---------------------------------------------------------------------
create or replace function public.current_outlet()
returns uuid
language sql stable security definer set search_path = public as $$
  select outlet_id from profiles where id = auth.uid();
$$;

create or replace function public.is_general_manager()
returns boolean
language sql stable as $$
  select coalesce(public.current_role() = 'general_manager', false);
$$;

create or replace function public.is_branch_supervisor()
returns boolean
language sql stable as $$
  select coalesce(public.current_role() = 'branch_supervisor', false);
$$;

-- ---------------------------------------------------------------------
-- STATES — add approval columns
-- ---------------------------------------------------------------------
alter table states add column if not exists status text not null default 'active'
  check (status in ('pending_approval','active','inactive','rejected'));
alter table states add column if not exists pending_action text
  check (pending_action in ('create','activate','deactivate'));
alter table states add column if not exists requested_by uuid references profiles(id);
alter table states add column if not exists requested_at timestamptz;
alter table states add column if not exists approved_by uuid references profiles(id);
alter table states add column if not exists approved_at timestamptz;

-- ---------------------------------------------------------------------
-- OUTLETS — same approval columns
-- ---------------------------------------------------------------------
alter table outlets add column if not exists status text not null default 'active'
  check (status in ('pending_approval','active','inactive','rejected'));
alter table outlets add column if not exists pending_action text
  check (pending_action in ('create','activate','deactivate'));
alter table outlets add column if not exists requested_by uuid references profiles(id);
alter table outlets add column if not exists requested_at timestamptz;
alter table outlets add column if not exists approved_by uuid references profiles(id);
alter table outlets add column if not exists approved_at timestamptz;

-- (Existing 3 seed rows in each table already default to status='active'
-- via the column default applied above — they're real, already-operating
-- locations, not subject to retroactive approval.)

-- =====================================================================
-- APPROVAL-FIELD LOCK TRIGGERS — same pattern as
-- enforce_station_pricing_lock() from 0001_init.sql. Non-owners may
-- only ever touch pending_action/requested_by/requested_at (i.e. file
-- a request); only the Owner may change status/approved_by/approved_at
-- directly. This closes the gap RLS alone can't close (partial-row
-- edits) and is the real enforcement point behind the RPCs below.
-- =====================================================================
create or replace function public.enforce_state_approval_lock()
returns trigger
language plpgsql as $$
begin
  if not public.is_owner() then
    if new.name <> old.name
       or new.company_id <> old.company_id
       or new.status <> old.status
       or coalesce(new.approved_by::text,'') <> coalesce(old.approved_by::text,'')
       or coalesce(new.approved_at::text,'') <> coalesce(old.approved_at::text,'')
    then
      raise exception 'Only the Owner may change a state''s status or approval fields directly.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_state_approval_lock on states;
create trigger trg_state_approval_lock
  before update on states
  for each row execute function public.enforce_state_approval_lock();

create or replace function public.enforce_outlet_approval_lock()
returns trigger
language plpgsql as $$
begin
  if not public.is_owner() then
    if new.name <> old.name
       or new.company_id <> old.company_id
       or new.state_id <> old.state_id
       or new.status <> old.status
       or coalesce(new.approved_by::text,'') <> coalesce(old.approved_by::text,'')
       or coalesce(new.approved_at::text,'') <> coalesce(old.approved_at::text,'')
    then
      raise exception 'Only the Owner may change an outlet''s status or approval fields directly.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_outlet_approval_lock on outlets;
create trigger trg_outlet_approval_lock
  before update on outlets
  for each row execute function public.enforce_outlet_approval_lock();

-- =====================================================================
-- ROW LEVEL SECURITY — replace Stage 2's states/outlets policies.
-- Existing tables from 0001/0002 are not touched again here.
-- =====================================================================

-- ---------------------- STATES ----------------------
drop policy if exists states_select on states;
create policy states_select on states
  for select using (
    company_id = public.current_company()
    and (status = 'active' or public.is_owner() or public.is_general_manager())
  );

drop policy if exists states_write_owner on states;

drop policy if exists states_insert on states;
create policy states_insert on states
  for insert with check (
    company_id = public.current_company()
    and (public.is_owner() or public.is_general_manager())
  );

drop policy if exists states_update on states;
create policy states_update on states
  for update using (
    company_id = public.current_company()
    and (public.is_owner() or public.is_general_manager())
  )
  with check (
    company_id = public.current_company()
    and (public.is_owner() or public.is_general_manager())
  );

-- No delete policy — states are never hard-deleted, only deactivated.

-- ---------------------- OUTLETS ----------------------
drop policy if exists outlets_select on outlets;
create policy outlets_select on outlets
  for select using (
    company_id = public.current_company()
    and (
      status = 'active'
      or public.is_owner()
      or public.is_general_manager()
      or (public.is_branch_supervisor() and id = public.current_outlet())
    )
  );

drop policy if exists outlets_write_owner on outlets;

drop policy if exists outlets_insert on outlets;
create policy outlets_insert on outlets
  for insert with check (
    company_id = public.current_company()
    and (public.is_owner() or public.is_general_manager())
  );

drop policy if exists outlets_update on outlets;
create policy outlets_update on outlets
  for update using (
    company_id = public.current_company()
    and (public.is_owner() or public.is_general_manager())
  )
  with check (
    company_id = public.current_company()
    and (public.is_owner() or public.is_general_manager())
  );

-- No delete policy — outlets are never hard-deleted, only deactivated.

-- =====================================================================
-- RPCs — the sanctioned write path. SECURITY INVOKER (the default), so
-- the caller's own RLS + the lock triggers above still apply; these
-- functions add the business logic (auto-approve for Owner, pending
-- for GM) on top, they don't bypass security.
-- =====================================================================

-- ---------------------- STATES ----------------------
create or replace function public.request_create_state(p_name text)
returns states
language plpgsql as $$
declare
  v_row states%rowtype;
  v_status text;
begin
  if not (public.is_owner() or public.is_general_manager()) then
    raise exception 'Only the Owner or a General Manager may request a new state.';
  end if;

  v_status := case when public.is_owner() then 'active' else 'pending_approval' end;

  insert into states (company_id, name, status, pending_action, requested_by, requested_at,
                       approved_by, approved_at)
  values (
    public.current_company(),
    p_name,
    v_status,
    case when public.is_owner() then null else 'create' end,
    auth.uid(),
    now(),
    case when public.is_owner() then auth.uid() else null end,
    case when public.is_owner() then now() else null end
  )
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.set_state_status(p_id uuid, p_new_status text)
returns states
language plpgsql as $$
declare
  v_row states%rowtype;
begin
  if p_new_status not in ('active','inactive') then
    raise exception 'p_new_status must be active or inactive.';
  end if;

  if public.is_owner() then
    update states
    set status = p_new_status,
        pending_action = null,
        approved_by = auth.uid(),
        approved_at = now()
    where id = p_id and company_id = public.current_company()
    returning * into v_row;

  elsif public.is_general_manager() then
    update states
    set pending_action = case when p_new_status = 'active' then 'activate' else 'deactivate' end,
        requested_by = auth.uid(),
        requested_at = now()
    where id = p_id and company_id = public.current_company() and status <> 'pending_approval'
    returning * into v_row;

  else
    raise exception 'Only the Owner or a General Manager may activate or deactivate a state.';
  end if;

  if v_row.id is null then
    raise exception 'State not found, or not eligible for this action.';
  end if;

  return v_row;
end;
$$;

create or replace function public.approve_state(p_id uuid)
returns states
language plpgsql as $$
declare
  v_row states%rowtype;
  v_target_status text;
begin
  if not public.is_owner() then
    raise exception 'Only the Owner may approve a state.';
  end if;

  select * into v_row from states where id = p_id and company_id = public.current_company();
  if v_row.id is null or v_row.pending_action is null then
    raise exception 'No pending request found for that state.';
  end if;

  v_target_status := case v_row.pending_action
    when 'create' then 'active'
    when 'activate' then 'active'
    when 'deactivate' then 'inactive'
  end;

  update states
  set status = v_target_status,
      pending_action = null,
      approved_by = auth.uid(),
      approved_at = now()
  where id = p_id
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.reject_state(p_id uuid)
returns states
language plpgsql as $$
declare
  v_row states%rowtype;
  v_result_status text;
begin
  if not public.is_owner() then
    raise exception 'Only the Owner may reject a state request.';
  end if;

  select * into v_row from states where id = p_id and company_id = public.current_company();
  if v_row.id is null or v_row.pending_action is null then
    raise exception 'No pending request found for that state.';
  end if;

  -- A rejected CREATE never became a real state; a rejected
  -- activate/deactivate simply leaves the current status untouched.
  v_result_status := case when v_row.pending_action = 'create' then 'rejected' else v_row.status end;

  update states
  set status = v_result_status,
      pending_action = null,
      approved_by = auth.uid(),
      approved_at = now()
  where id = p_id
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------- OUTLETS ----------------------
create or replace function public.request_create_outlet(p_state_id uuid, p_name text)
returns outlets
language plpgsql as $$
declare
  v_row outlets%rowtype;
  v_state states%rowtype;
  v_status text;
begin
  if not (public.is_owner() or public.is_general_manager()) then
    raise exception 'Only the Owner or a General Manager may request a new outlet.';
  end if;

  select * into v_state from states where id = p_state_id and company_id = public.current_company();
  if v_state.id is null or v_state.status <> 'active' then
    raise exception 'Target state must exist and be active before adding an outlet.';
  end if;

  v_status := case when public.is_owner() then 'active' else 'pending_approval' end;

  insert into outlets (company_id, state_id, name, status, pending_action, requested_by,
                        requested_at, approved_by, approved_at)
  values (
    public.current_company(),
    p_state_id,
    p_name,
    v_status,
    case when public.is_owner() then null else 'create' end,
    auth.uid(),
    now(),
    case when public.is_owner() then auth.uid() else null end,
    case when public.is_owner() then now() else null end
  )
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.set_outlet_status(p_id uuid, p_new_status text)
returns outlets
language plpgsql as $$
declare
  v_row outlets%rowtype;
begin
  if p_new_status not in ('active','inactive') then
    raise exception 'p_new_status must be active or inactive.';
  end if;

  if public.is_owner() then
    update outlets
    set status = p_new_status,
        pending_action = null,
        approved_by = auth.uid(),
        approved_at = now()
    where id = p_id and company_id = public.current_company()
    returning * into v_row;

  elsif public.is_general_manager() then
    update outlets
    set pending_action = case when p_new_status = 'active' then 'activate' else 'deactivate' end,
        requested_by = auth.uid(),
        requested_at = now()
    where id = p_id and company_id = public.current_company() and status <> 'pending_approval'
    returning * into v_row;

  else
    raise exception 'Only the Owner or a General Manager may activate or deactivate an outlet.';
  end if;

  if v_row.id is null then
    raise exception 'Outlet not found, or not eligible for this action.';
  end if;

  return v_row;
end;
$$;

create or replace function public.approve_outlet(p_id uuid)
returns outlets
language plpgsql as $$
declare
  v_row outlets%rowtype;
  v_target_status text;
begin
  if not public.is_owner() then
    raise exception 'Only the Owner may approve an outlet.';
  end if;

  select * into v_row from outlets where id = p_id and company_id = public.current_company();
  if v_row.id is null or v_row.pending_action is null then
    raise exception 'No pending request found for that outlet.';
  end if;

  v_target_status := case v_row.pending_action
    when 'create' then 'active'
    when 'activate' then 'active'
    when 'deactivate' then 'inactive'
  end;

  update outlets
  set status = v_target_status,
      pending_action = null,
      approved_by = auth.uid(),
      approved_at = now()
  where id = p_id
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.reject_outlet(p_id uuid)
returns outlets
language plpgsql as $$
declare
  v_row outlets%rowtype;
  v_result_status text;
begin
  if not public.is_owner() then
    raise exception 'Only the Owner may reject an outlet request.';
  end if;

  select * into v_row from outlets where id = p_id and company_id = public.current_company();
  if v_row.id is null or v_row.pending_action is null then
    raise exception 'No pending request found for that outlet.';
  end if;

  v_result_status := case when v_row.pending_action = 'create' then 'rejected' else v_row.status end;

  update outlets
  set status = v_result_status,
      pending_action = null,
      approved_by = auth.uid(),
      approved_at = now()
  where id = p_id
  returning * into v_row;

  return v_row;
end;
$$;

-- Lock down execution to authenticated users only (each function still
-- enforces its own role check internally on top of this).
revoke execute on function public.request_create_state(text) from public;
revoke execute on function public.set_state_status(uuid, text) from public;
revoke execute on function public.approve_state(uuid) from public;
revoke execute on function public.reject_state(uuid) from public;
revoke execute on function public.request_create_outlet(uuid, text) from public;
revoke execute on function public.set_outlet_status(uuid, text) from public;
revoke execute on function public.approve_outlet(uuid) from public;
revoke execute on function public.reject_outlet(uuid) from public;

grant execute on function public.request_create_state(text) to authenticated;
grant execute on function public.set_state_status(uuid, text) to authenticated;
grant execute on function public.approve_state(uuid) to authenticated;
grant execute on function public.reject_state(uuid) to authenticated;
grant execute on function public.request_create_outlet(uuid, text) to authenticated;
grant execute on function public.set_outlet_status(uuid, text) to authenticated;
grant execute on function public.approve_outlet(uuid) to authenticated;
grant execute on function public.reject_outlet(uuid) to authenticated;

-- =====================================================================
-- Done. Verification queries:
--
--   -- constraint changes took effect
--   select conname from pg_constraint where conrelid = 'profiles'::regclass;
--
--   -- existing seed rows are still 'active' and untouched
--   select name, status, pending_action from states;
--   select name, status, pending_action from outlets;
--
-- Note: assigning a Branch Supervisor to an outlet does not need a new
-- RPC — the Owner already has full UPDATE rights on `profiles` via the
-- profiles_update_owner policy from 0001_init.sql. Set both
-- role='branch_supervisor' and outlet_id in that same update.
-- =====================================================================