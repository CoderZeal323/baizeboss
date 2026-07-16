-- =====================================================================
-- BAIZEBOSS — Stage 4: Employee Pending-Approval Workflow
-- =====================================================================
-- Run once in Supabase SQL Editor, after 0001-0003 have already run.
--
-- IMPORTANT: this migration drops the public self-registration policy.
-- After this runs, the old public signup form will no longer create a
-- working account. That's intentional (see Stage 4 spec) — new staff
-- accounts are created only via the Cloudflare Function delivered as
-- a separate step, not by this SQL file.
-- =====================================================================

-- ---------------------------------------------------------------------
-- PROFILES — rich employee lifecycle status
-- ---------------------------------------------------------------------
alter table profiles add column if not exists status text not null default 'active'
  check (status in ('pending_approval','active','suspended','inactive',
                     'rejected','transferred','resigned','terminated'));
-- Existing rows already default to 'active' via the column default
-- above — they're real staff already working, not subject to
-- retroactive approval.

-- ---------------------------------------------------------------------
-- EMPLOYEE_DETAILS — 1:1 extension of profiles. Kept as its own table
-- rather than added to `profiles` directly, since `profiles` is the
-- auth-critical table every RLS policy in the system depends on;
-- adding 20+ optional HR fields there would make the highest-risk
-- table in the schema noisier without benefit.
-- ---------------------------------------------------------------------
create table if not exists employee_details (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references profiles(id) on delete cascade,

  age int,
  gender text,
  marital_status text,
  date_of_birth date,
  phone_number text,
  residential_address text,
  state_of_origin text,
  state_of_residence text,
  qualification text,
  passport_photo_url text,
  emergency_contact text,

  guarantor_name text,
  guarantor_relationship text,
  guarantor_phone text,
  guarantor_address text,

  employment_date date,
  standard_undertaking_accepted_at timestamptz,
  management_undertaking_accepted_at timestamptz,

  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- EMPLOYEE_STATUS_HISTORY — append-only, same pattern as
-- `transactions`/`remittances` (no UPDATE/DELETE policy for anyone).
-- Populated automatically by a trigger below, not by manual inserts,
-- so it can never be forgotten or bypassed by whichever code path
-- changed the status.
-- ---------------------------------------------------------------------
create table if not exists employee_status_history (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id),
  old_status text,
  new_status text not null,
  changed_by uuid references profiles(id),
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_employee_status_history_profile
  on employee_status_history (profile_id, created_at);

-- ---------------------------------------------------------------------
-- Auto-logging trigger — fires on every profiles.status change,
-- regardless of whether it came from an RPC below or a direct table
-- update, so the history can't be silently skipped.
-- ---------------------------------------------------------------------
create or replace function public.log_employee_status_change()
returns trigger
language plpgsql as $$
declare
  v_reason text;
begin
  if new.status is distinct from old.status then
    begin
      v_reason := nullif(current_setting('baizeboss.status_change_reason', true), '');
    exception when others then
      v_reason := null;
    end;

    insert into employee_status_history (profile_id, old_status, new_status, changed_by, reason)
    values (new.id, old.status, new.status, auth.uid(), v_reason);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_log_employee_status_change on profiles;
create trigger trg_log_employee_status_change
  after update on profiles
  for each row execute function public.log_employee_status_change();

-- =====================================================================
-- REMOVE PUBLIC SELF-REGISTRATION — the literal removal the blueprint
-- requires. From this point forward, the ONLY way a new profiles row
-- gets created is through the Cloudflare Function (service_role,
-- bypasses RLS by design) — not through any client-facing insert path.
-- =====================================================================
drop policy if exists profiles_insert_self_sales_rep on profiles;

-- =====================================================================
-- ROW LEVEL SECURITY — employee_details, employee_status_history
-- =====================================================================
alter table employee_details enable row level security;
alter table employee_status_history enable row level security;

-- No client-facing INSERT/UPDATE/DELETE policy on employee_details at
-- all, on purpose — the only writer is the Cloudflare Function via the
-- service_role connection, which bypasses RLS entirely. This table is
-- select-only from the app's perspective.
drop policy if exists employee_details_select on employee_details;
create policy employee_details_select on employee_details
  for select using (
    public.is_owner()
    or profile_id = auth.uid()
    or (
      public.is_branch_supervisor()
      and exists (
        select 1 from profiles p
        where p.id = employee_details.profile_id
          and p.outlet_id = public.current_outlet()
      )
    )
  );

drop policy if exists employee_status_history_select on employee_status_history;
create policy employee_status_history_select on employee_status_history
  for select using (
    public.is_owner()
    or profile_id = auth.uid()
    or (
      public.is_branch_supervisor()
      and exists (
        select 1 from profiles p
        where p.id = employee_status_history.profile_id
          and p.outlet_id = public.current_outlet()
      )
    )
  );

-- Insert only ever happens via the trigger above, fired by an Owner
-- action (approve/reject/set_employee_status all require is_owner()).
drop policy if exists employee_status_history_insert on employee_status_history;
create policy employee_status_history_insert on employee_status_history
  for insert with check (public.is_owner());

-- No update/delete policy on employee_status_history for anyone —
-- permanent record, matching the append-only ledgers elsewhere.

-- =====================================================================
-- RPCs — Owner-only, matching the blueprint precisely: General Manager
-- and Branch Supervisor cannot approve, reject, or otherwise finalize
-- an employee's status. They can only request creation, via the
-- Cloudflare Function (separate step).
-- =====================================================================
create or replace function public.approve_employee(p_id uuid)
returns profiles
language plpgsql as $$
declare
  v_row profiles%rowtype;
begin
  if not public.is_owner() then
    raise exception 'Only the Owner may approve an employee.';
  end if;

  update profiles
  set status = 'active'
  where id = p_id and company_id = public.current_company() and status = 'pending_approval'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'No pending employee found with that id.';
  end if;

  return v_row;
end;
$$;

create or replace function public.reject_employee(p_id uuid)
returns profiles
language plpgsql as $$
declare
  v_row profiles%rowtype;
begin
  if not public.is_owner() then
    raise exception 'Only the Owner may reject an employee.';
  end if;

  update profiles
  set status = 'rejected'
  where id = p_id and company_id = public.current_company() and status = 'pending_approval'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'No pending employee found with that id.';
  end if;

  return v_row;
end;
$$;

-- General-purpose status change for an already-active employee
-- (suspend, deactivate, mark transferred/resigned/terminated, or
-- reactivate). Distinct from approve/reject, which only apply to a
-- fresh pending_approval record.
create or replace function public.set_employee_status(p_id uuid, p_new_status text, p_reason text default null)
returns profiles
language plpgsql as $$
declare
  v_row profiles%rowtype;
begin
  if not public.is_owner() then
    raise exception 'Only the Owner may change an employee''s status.';
  end if;

  if p_new_status not in ('active','suspended','inactive','transferred','resigned','terminated') then
    raise exception 'Invalid status for this action. Use approve_employee/reject_employee for pending_approval records.';
  end if;

  perform set_config('baizeboss.status_change_reason', coalesce(p_reason, ''), true);

  update profiles
  set status = p_new_status
  where id = p_id and company_id = public.current_company() and status <> 'pending_approval'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Employee not found, or still pending approval — use approve_employee/reject_employee first.';
  end if;

  return v_row;
end;
$$;

revoke execute on function public.approve_employee(uuid) from public;
revoke execute on function public.reject_employee(uuid) from public;
revoke execute on function public.set_employee_status(uuid, text, text) from public;

grant execute on function public.approve_employee(uuid) to authenticated;
grant execute on function public.reject_employee(uuid) to authenticated;
grant execute on function public.set_employee_status(uuid, text, text) to authenticated;

-- =====================================================================
-- Done. Verification queries:
--
--   -- confirm public self-registration is gone
--   select policyname from pg_policies
--   where tablename = 'profiles' and policyname = 'profiles_insert_self_sales_rep';
--   -- should return 0 rows
--
--   -- existing staff untouched
--   select full_name, role, status from profiles;
--
--   select * from employee_details;          -- empty until the
--   select * from employee_status_history;    -- Cloudflare Function ships
-- =====================================================================