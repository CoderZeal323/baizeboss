// =====================================================================
// functions/create-employee.js
//
// The ONLY path in BAIZEBOSS that creates a new staff login. Called by
// an Owner or Branch Supervisor from the app once the frontend for
// this exists (Stage 7). Runs entirely on Cloudflare's server — never
// shipped to the browser, unlike everything in /public.
//
// This is a plain function, not a Pages Function — this project
// deploys as a Cloudflare Worker (via `wrangler deploy`), which has no
// automatic /functions routing. worker.js at the project root is the
// single entry point for every request and calls handleCreateEmployee()
// directly for the one route that needs it.
//
// SETUP REQUIRED BEFORE THIS WORKS (one-time, in the Cloudflare
// dashboard, not in this file or the repo):
//   1. Cloudflare dashboard -> Workers & Pages -> baizeboss -> Settings
//      -> Environment variables -> Production (and Preview if you use
//      it) -> Add variable.
//   2. Name:  SUPABASE_SERVICE_ROLE_KEY
//      Value: Supabase Dashboard -> Project Settings -> API ->
//             "service_role" key (NOT the anon key already in
//             public/js/config.js — a different, much more powerful
//             key that must never appear in any file under /public).
//   3. Tick "Encrypt" so it's never visible again after saving, even
//      to you, in the dashboard.
//   4. Redeploy (env vars only take effect on the next deployment).
//
// If that variable is missing, every request to this endpoint fails
// safely with a 500 — it will never silently fall back to anything
// less secure.
// =====================================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://rjtsnhxhxslrgsiwwwjk.supabase.co';

// Which roles each caller role is allowed to create. Deliberately
// restrictive: a Branch Supervisor can only bring on ordinary staff
// for their own outlet, never another supervisor, manager, or
// enterprise-level account. Only the Owner can create anything above
// that. General Manager cannot create employees at all, matching the
// blueprint's GM restrictions.
const ROLE_CREATION_PERMISSIONS = {
  owner: ['sales_rep', 'manager', 'branch_supervisor', 'general_manager'],
  branch_supervisor: ['sales_rep'],
};

// Roles that require the additional Corporate Management Undertaking,
// per the blueprint's intake form spec.
const MANAGEMENT_TIER_ROLES = ['manager', 'branch_supervisor', 'general_manager'];

export async function handleCreateEmployee(request, env) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return jsonError('Server is not configured for account creation yet.', 500);
  }

  // The caller's own session token, so we can find out who they
  // actually are — never trust a role/outlet claimed in the request body.
  const authHeader = request.headers.get('Authorization') || '';
  const callerToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!callerToken) {
    return jsonError('Missing Authorization header.', 401);
  }

  const admin = createClient(SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Who is calling?
  const { data: callerAuth, error: callerAuthError } = await admin.auth.getUser(callerToken);
  if (callerAuthError || !callerAuth?.user) {
    return jsonError('Invalid or expired session.', 401);
  }

  const { data: callerProfile, error: callerProfileError } = await admin
    .from('profiles')
    .select('id, role, company_id, outlet_id, status')
    .eq('id', callerAuth.user.id)
    .single();

  if (callerProfileError || !callerProfile) {
    return jsonError('Caller profile not found.', 403);
  }

  if (callerProfile.status !== 'active') {
    return jsonError('Your account is not active.', 403);
  }

  const allowedRoles = ROLE_CREATION_PERMISSIONS[callerProfile.role];
  if (!allowedRoles) {
    return jsonError('You are not permitted to create employee accounts.', 403);
  }

  // 2. Validate the request body.
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body.', 400);
  }

  const {
    full_name, email, password, role, outlet_id,
    age, gender, marital_status, date_of_birth, phone_number,
    residential_address, state_of_origin, state_of_residence,
    qualification, passport_photo_url, emergency_contact,
    guarantor_name, guarantor_relationship, guarantor_phone, guarantor_address,
    employment_date,
    standard_undertaking_accepted, management_undertaking_accepted,
  } = body || {};

  if (!full_name || !email || !password || !role || !outlet_id) {
    return jsonError('full_name, email, password, role, and outlet_id are required.', 400);
  }

  if (!allowedRoles.includes(role)) {
    return jsonError(`You are not permitted to create a "${role}" account.`, 403);
  }

  // A Branch Supervisor may only staff their own outlet.
  if (callerProfile.role === 'branch_supervisor' && outlet_id !== callerProfile.outlet_id) {
    return jsonError('You may only add employees to your own outlet.', 403);
  }

  if (!standard_undertaking_accepted) {
    return jsonError('The Standard Employee Undertaking must be accepted before submission.', 400);
  }
  if (MANAGEMENT_TIER_ROLES.includes(role) && !management_undertaking_accepted) {
    return jsonError('The Corporate Management Undertaking must be accepted for this role.', 400);
  }

  // 3. Confirm the target outlet is real, active, and in the caller's company.
  const { data: outlet, error: outletError } = await admin
    .from('outlets')
    .select('id, company_id, status, branch_id')
    .eq('id', outlet_id)
    .single();

  if (outletError || !outlet || outlet.company_id !== callerProfile.company_id) {
    return jsonError('Target outlet not found.', 400);
  }
  if (outlet.status !== 'active') {
    return jsonError('Target outlet is not active.', 400);
  }

  // 4. Create the auth user.
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // the supervisor is handing credentials over directly in person
  });

  if (createError || !created?.user) {
    return jsonError(createError?.message || 'Could not create the account.', 400);
  }

  const newUserId = created.user.id;

  // 5. Insert profiles + employee_details. If either fails, roll back
  // the auth user so we never leave an orphaned login with no profile.
  //
  // branch_id is included when the outlet has one linked (true for the
  // three original legacy branches) so Phase 1's branch-scoped screens
  // can still see this employee. New outlets with no legacy branch
  // link simply leave it null — outlet_id alone satisfies the
  // database constraint as of the 0005 hotfix.
  try {
    const { error: profileError } = await admin.from('profiles').insert({
      id: newUserId,
      full_name,
      role,
      company_id: callerProfile.company_id,
      outlet_id,
      branch_id: outlet.branch_id || null,
      status: 'pending_approval',
    });
    if (profileError) throw profileError;

    const { error: detailsError } = await admin.from('employee_details').insert({
      profile_id: newUserId,
      age, gender, marital_status, date_of_birth, phone_number,
      residential_address, state_of_origin, state_of_residence,
      qualification, passport_photo_url, emergency_contact,
      guarantor_name, guarantor_relationship, guarantor_phone, guarantor_address,
      employment_date,
      standard_undertaking_accepted_at: new Date().toISOString(),
      management_undertaking_accepted_at: management_undertaking_accepted
        ? new Date().toISOString()
        : null,
    });
    if (detailsError) throw detailsError;
  } catch (err) {
    await admin.auth.admin.deleteUser(newUserId).catch(() => {});
    return jsonError('Could not complete employee record: ' + (err.message || 'unknown error'), 500);
  }

  return new Response(
    JSON.stringify({
      ok: true,
      profile_id: newUserId,
      status: 'pending_approval',
      message: 'Employee created and awaiting Owner approval.',
    }),
    { status: 201, headers: { 'Content-Type': 'application/json' } },
  );
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}