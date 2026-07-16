import { supabase } from './supabaseClient.js';

const root = document.getElementById('pos-root');
const CURRENCY = '\u20A6';
const BRAND = 'BAIZEBOSS';
const SLOGAN = 'Where skill meets style...';

// ---------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------
let branches = [];
let workers = [];          // Owner-only: full staff roster (sales_rep + manager)
let stations = [];
let transactions = [];
let remittances = [];
let pendingApprovals = { employees: [], states: [], outlets: [], games: [] }; // Owner-only
let currentUser = null;    // {role: 'owner'|'manager'|'sales_rep', id, name, branchId}
let activeTab = null;
let timerInterval = null;
let authView = 'choice';   // choice | staff-login | staff-register | owner-login
let realtimeChannel = null;

let bodyEl, overlay, overlayContent;

// ---------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------
function fmtMoney(n){ return CURRENCY + Number(n||0).toLocaleString(undefined,{maximumFractionDigits:0}); }
function fmtElapsed(ms){
  const totalSec = Math.floor(ms/1000);
  const h = Math.floor(totalSec/3600);
  const m = Math.floor((totalSec%3600)/60);
  const s = totalSec%60;
  return (h>0? String(h).padStart(2,'0')+':':'') + String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
}
function branchName(id){ const b = branches.find(x=>x.id===id); return b ? b.name : 'Unknown Branch'; }
function initials(name){ return (name||'?').trim().split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase(); }
function closeOverlay(){ overlay.classList.remove('show'); overlayContent.innerHTML=''; }
function openOverlay(html){ overlayContent.innerHTML = html; overlay.classList.add('show'); }
function newReceiptNo(){ return 'RCT-' + Date.now().toString().slice(-8); }
function roleLabel(role){ return role === 'owner' ? 'Owner' : role === 'manager' ? 'Manager' : 'Sales Rep'; }
function isBranchRole(role){ return role === 'manager' || role === 'sales_rep'; }

async function fatalIfError(error, context){
  if(error){
    console.error(context, error);
    alert((context ? context+': ' : '') + error.message);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------
// DATA LAYER (Supabase). RLS enforces branch/role scoping server-side;
// the explicit .eq() filters here just avoid over-fetching.
// ---------------------------------------------------------------------
async function loadBranches(){
  const { data, error } = await supabase.from('branches').select('*').order('name');
  if(await fatalIfError(error, 'Loading branches')) return;
  branches = data || [];
}
async function loadStations(){
  let q = supabase.from('stations').select('*').order('name');
  if(currentUser.role !== 'owner') q = q.eq('branch_id', currentUser.branchId);
  const { data, error } = await q;
  if(await fatalIfError(error, 'Loading stations')) return;
  stations = data || [];
}
async function loadTransactions(){
  let q = supabase.from('transactions').select('*').order('created_at', {ascending:false}).limit(2000);
  if(currentUser.role !== 'owner') q = q.eq('branch_id', currentUser.branchId);
  const { data, error } = await q;
  if(await fatalIfError(error, 'Loading transactions')) return;
  transactions = data || [];
}
async function loadRemittances(){
  let q = supabase.from('remittances').select('*').order('created_at', {ascending:false}).limit(2000);
  if(currentUser.role === 'sales_rep') q = q.eq('worker_id', currentUser.id);
  else if(currentUser.role === 'manager') q = q.eq('branch_id', currentUser.branchId);
  const { data, error } = await q;
  if(await fatalIfError(error, 'Loading remittances')) return;
  remittances = data || [];
}
async function loadWorkers(){
  const { data, error } = await supabase.from('profiles').select('*').in('role',['sales_rep','manager']).order('full_name');
  if(await fatalIfError(error, 'Loading staff')) return;
  workers = data || [];
}
async function loadPendingApprovals(){
  // Owner-only, per the approval workflow established across Stages 3-5:
  // a record is "pending" either because it's brand new (status =
  // pending_approval) or because a General Manager/Branch Supervisor
  // requested an activate/deactivate/transfer on an existing one
  // (pending_action is set, status stays whatever it currently is).
  const [empRes, stateRes, outletRes, gameRes] = await Promise.all([
    supabase.from('profiles').select('*').eq('status', 'pending_approval'),
    supabase.from('states').select('*').or('status.eq.pending_approval,pending_action.not.is.null'),
    supabase.from('outlets').select('*').or('status.eq.pending_approval,pending_action.not.is.null'),
    supabase.from('games').select('*').or('status.eq.pending_approval,pending_action.not.is.null'),
  ]);
  pendingApprovals = {
    employees: empRes.data || [],
    states: stateRes.data || [],
    outlets: outletRes.data || [],
    games: gameRes.data || [],
  };
}
function pendingApprovalsCount(){
  const p = pendingApprovals;
  return p.employees.length + p.states.length + p.outlets.length + p.games.length;
}
async function loadBranchData(){
  const tasks = [loadStations(), loadTransactions(), loadRemittances()];
  if(currentUser.role === 'owner') tasks.push(loadWorkers(), loadPendingApprovals());
  await Promise.all(tasks);
}

function subscribeRealtime(){
  if(realtimeChannel) supabase.removeChannel(realtimeChannel);
  const branchFilter = currentUser.role === 'owner' ? undefined : `branch_id=eq.${currentUser.branchId}`;
  const ch = supabase.channel('baizeboss-live');
  ['stations','transactions','remittances'].forEach(table=>{
    const cfg = { event: '*', schema: 'public', table };
    if(branchFilter) cfg.filter = branchFilter;
    ch.on('postgres_changes', cfg, async ()=>{
      await loadBranchData();
      renderRoot();
    });
  });
  if(currentUser.role === 'owner'){
    // No branch filter here — Owner needs to see requests from every
    // outlet, and the tab badge should update the instant a General
    // Manager or Branch Supervisor submits something, not just when
    // the Owner happens to click into the Approvals tab.
    ['profiles','states','outlets','games'].forEach(table=>{
      ch.on('postgres_changes', { event: '*', schema: 'public', table }, async ()=>{
        await loadPendingApprovals();
        if(activeTab === 'approvals') renderApprovalsList();
        else renderRoot(); // re-render shell so the tab badge count refreshes
      });
    });
  }
  ch.subscribe();
  realtimeChannel = ch;
}

// ---------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------
async function fetchProfile(userId){
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
  if(error){ console.error(error); return null; }
  return data;
}

async function resolveProfile(userId){
  // Looks up the profile, and self-heals it if the signup trigger ever
  // failed to create one — safe here because this is only ever called
  // with an authenticated session, which satisfies the RLS insert
  // policy (id = auth.uid(), role = 'sales_rep', branch_id not null).
  let profile = await fetchProfile(userId);
  if(!profile){
    const { data: userData } = await supabase.auth.getUser();
    const meta = (userData && userData.user && userData.user.user_metadata) || {};
    if(meta.branch_id){
      const { error: healErr } = await supabase.from('profiles').insert({
        id: userId,
        full_name: meta.full_name || 'New Staff',
        role: 'sales_rep',
        branch_id: meta.branch_id,
      });
      if(!healErr){
        profile = await fetchProfile(userId);
      } else {
        console.error('Profile self-heal failed', healErr);
      }
    }
  }
  return profile;
}

async function initAuth(){
  const { data: { session } } = await supabase.auth.getSession();
  if(session){
    await handleSignedIn(session.user.id);
  } else {
    renderRoot();
  }
  supabase.auth.onAuthStateChange((event, session)=>{
    if(event === 'SIGNED_OUT'){
      currentUser = null;
      if(realtimeChannel) supabase.removeChannel(realtimeChannel);
      authView = 'choice';
      renderRoot();
    } else if(event === 'SIGNED_IN' && session && !currentUser){
      handleSignedIn(session.user.id);
    }
  });
}

async function handleSignedIn(userId){
  let profile;
  try {
    profile = await resolveProfile(userId);
  } catch(e){
    console.error(e);
  }

  if(!profile){
    // Still nothing — genuinely mid-registration or missing branch info.
    renderRoot();
    return;
  }

  currentUser = {
    role: profile.role,
    id: profile.id,
    name: profile.full_name,
    branchId: profile.branch_id,
  };
  await loadBranches();
  await loadBranchData();
  subscribeRealtime();
  activeTab = currentUser.role === 'owner' ? 'dashboard' : 'sessions';
  renderRoot();
}

async function logout(){
  await supabase.auth.signOut();
  // onAuthStateChange handles the re-render.
}

// ---------------------------------------------------------------------
// ROOT RENDER
// ---------------------------------------------------------------------
function renderRoot(){
  if(timerInterval){ clearInterval(timerInterval); timerInterval=null; }
  if(!currentUser){ renderAuth(); return; }
  if(currentUser.role === 'owner') renderOwnerShell();
  else renderBranchShell();
}

// ================= AUTH SCREENS =================
function renderAuth(){
  let inner = '';
  if(authView === 'choice'){
    inner = `
      <div class="auth-card">
        <div class="auth-logo"><img src="assets/logo-full.jpg" alt="${BRAND}"></div>
        <div class="auth-choice">
          <button class="auth-choice-btn" id="pick-staff">
            <div class="auth-choice-icon">&#127918;</div>
            <div><div class="ac-title">I'm Branch Staff</div><div class="ac-sub">Sales Rep or Manager &mdash; log sessions for your branch</div></div>
          </button>
          <button class="auth-choice-btn" id="pick-owner">
            <div class="auth-choice-icon">&#128081;</div>
            <div><div class="ac-title">I'm the Owner</div><div class="ac-sub">Global dashboard &amp; reconciliation</div></div>
          </button>
        </div>
      </div>`;
  } else if(authView === 'staff-login'){
    inner = `
      <div class="auth-card">
        <button class="auth-back" id="auth-back">&larr; Back</button>
        <div class="auth-panel">
          <h3>Staff Login</h3>
          <p class="sub">Sign in with the email and password you registered with</p>
          <div class="auth-error" id="auth-error"></div>
          <div class="field"><label>Email</label><input id="wl-email" type="email" placeholder="you@branch.com"></div>
          <div class="field"><label>Password</label><input id="wl-pass" type="password" placeholder="••••••••"></div>
          <button class="btn" id="wl-submit" style="width:100%;">Log In</button>
          <div class="auth-footer">New here? <button class="link-btn" id="goto-register">Register as a Sales Rep</button></div>
        </div>
      </div>`;
  } else if(authView === 'staff-register'){
    const bOpts = (branches.length ? branches : [{id:'ph',name:'Port Harcourt'},{id:'abj',name:'Abuja'},{id:'kad',name:'Kaduna'}])
      .map(b=>`<option value="${b.id}">${b.name}</option>`).join('');
    inner = `
      <div class="auth-card">
        <button class="auth-back" id="auth-back">&larr; Back</button>
        <div class="auth-panel">
          <h3>Sales Rep Registration</h3>
          <p class="sub">Every account must be assigned to one branch. Managers are promoted later by the Owner.</p>
          <div class="auth-error" id="auth-error"></div>
          <div class="auth-info" id="auth-info"></div>
          <div class="field"><label>Full name</label><input id="wr-name" placeholder="e.g. Tunde Okafor"></div>
          <div class="field"><label>Assigned branch</label><select id="wr-branch">${bOpts}</select></div>
          <div class="field"><label>Work email</label><input id="wr-email" type="email" placeholder="you@branch.com"></div>
          <div class="field"><label>Password</label><input id="wr-pass" type="password" placeholder="At least 8 characters"></div>
          <button class="btn" id="wr-submit" style="width:100%;">Create Account</button>
        </div>
      </div>`;
  } else if(authView === 'owner-login'){
    inner = `
      <div class="auth-card">
        <button class="auth-back" id="auth-back">&larr; Back</button>
        <div class="auth-panel">
          <h3>Owner Login</h3>
          <p class="sub">Global access across all branches</p>
          <div class="auth-error" id="auth-error"></div>
          <div class="field"><label>Email</label><input id="cl-email" type="email" placeholder="owner@baizeboss.com"></div>
          <div class="field"><label>Password</label><input id="cl-pass" type="password" placeholder="••••••••"></div>
          <button class="btn" id="cl-submit" style="width:100%;">Log In</button>
          <div class="auth-footer">Owner accounts are provisioned directly in Supabase — see README.</div>
        </div>
      </div>`;
  }
  root.innerHTML = `<div class="auth-wrap">${inner}</div>`;

  if(authView === 'choice'){
    document.getElementById('pick-staff').onclick = async ()=>{ if(!branches.length) await loadBranches(); authView='staff-login'; renderAuth(); };
    document.getElementById('pick-owner').onclick = ()=>{ authView='owner-login'; renderAuth(); };
    return;
  }
  document.getElementById('auth-back').onclick = ()=>{ authView='choice'; renderAuth(); };

  function showErr(msg){
    const el=document.getElementById('auth-error');
    if(el){ el.textContent=msg; el.style.display='block'; }
    else { alert(msg); }
  }

  if(authView === 'staff-login'){
    document.getElementById('goto-register').onclick = async ()=>{
      if(!branches.length) await loadBranches();
      authView='staff-register'; renderAuth();
    };
    document.getElementById('wl-submit').onclick = async ()=>{
      const email = document.getElementById('wl-email').value.trim();
      const password = document.getElementById('wl-pass').value;
      const btn = document.getElementById('wl-submit');
      btn.disabled = true; btn.textContent = 'Logging in...';
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if(error){ btn.disabled=false; btn.textContent='Log In'; showErr(error.message); return; }
      const profile = await resolveProfile(data.user.id);
      if(!profile || profile.role === 'owner'){
        await supabase.auth.signOut();
        showErr(!profile
          ? 'We could not find a staff profile for this account. Please contact the Owner.'
          : 'This is an Owner account — use the Owner login instead.');
        return;
      }
      await handleSignedIn(data.user.id);
    };
  }

  if(authView === 'staff-register'){
    document.getElementById('wr-submit').onclick = async ()=>{
      const name = document.getElementById('wr-name').value.trim();
      const branchId = document.getElementById('wr-branch').value;
      const email = document.getElementById('wr-email').value.trim();
      const password = document.getElementById('wr-pass').value;
      if(!name || !branchId || !email || password.length < 8){
        showErr('Fill in your name, branch, email, and an 8+ character password.');
        return;
      }
      const btn = document.getElementById('wr-submit');
      btn.disabled = true; btn.textContent = 'Creating account...';
      const { data, error } = await supabase.auth.signUp({
        email, password,
        options: { data: { full_name: name, branch_id: branchId } },
      });
      if(error){ btn.disabled=false; btn.textContent='Create Account'; showErr(error.message); return; }
      if(!data.user){
        btn.disabled=false; btn.textContent='Create Account';
        showErr('Registration failed — please try again.');
        return;
      }
      // The profile row is created by a database trigger on auth.users,
      // with a client-side self-heal fallback in resolveProfile() if
      // that trigger ever fails to fire.
      if(data.session){
        await handleSignedIn(data.user.id);
      } else {
        const info = document.getElementById('auth-info');
        info.textContent = 'Account created. Check your email to confirm it, then log in.';
        info.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Create Account';
      }
    };
  }

  if(authView === 'owner-login'){
    document.getElementById('cl-submit').onclick = async ()=>{
      const email = document.getElementById('cl-email').value.trim();
      const password = document.getElementById('cl-pass').value;
      const btn = document.getElementById('cl-submit');
      btn.disabled = true; btn.textContent = 'Logging in...';
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if(error){ btn.disabled=false; btn.textContent='Log In'; showErr(error.message); return; }
      const profile = await resolveProfile(data.user.id);
      if(!profile || profile.role !== 'owner'){
        await supabase.auth.signOut();
        showErr('This account is not an Owner account.');
        return;
      }
      await handleSignedIn(data.user.id);
    };
  }
}

// ================= SHELLS =================
function shellHeader(tabs){
  const tabHtml = tabs.map(t=>`<button class="tab-btn ${activeTab===t.id?'active':''}" data-tab="${t.id}">${t.label}</button>`).join('');
  const branchLabel = currentUser.role==='owner' ? 'All Branches' : branchName(currentUser.branchId);
  return `
    <div class="top">
      <div class="brand">
        <div class="brand-mark"><img src="assets/logo-mark.png" alt="${BRAND}"></div>
        <div>
          <h1>${BRAND}</h1>
          <span>${SLOGAN}</span>
        </div>
      </div>
      <div class="tabs" id="tabs">${tabHtml}</div>
      <div class="top-right">
        <div class="user-chip">
          <div class="user-avatar">${initials(currentUser.name)}</div>
          <div class="user-meta">
            <div class="u-name">${currentUser.name} <span style="color:var(--text-dim); font-weight:400;">&middot; ${roleLabel(currentUser.role)}</span></div>
            <div class="u-branch">${branchLabel}</div>
          </div>
        </div>
        <button class="logout-btn" id="logout-btn">Log out</button>
      </div>
    </div>
    <div class="body" id="body"></div>
    <div class="overlay" id="overlay"><div id="overlay-content"></div></div>
  `;
}

function bindShellChrome(){
  bodyEl = document.getElementById('body');
  overlay = document.getElementById('overlay');
  overlayContent = document.getElementById('overlay-content');
  overlay.addEventListener('click', (e)=>{ if(e.target === overlay) closeOverlay(); });
  document.getElementById('logout-btn').onclick = logout;
  document.getElementById('tabs').addEventListener('click', (e)=>{
    const btn = e.target.closest('.tab-btn');
    if(btn){ activeTab = btn.dataset.tab; renderRoot(); }
  });
}

const BRANCH_TABS_BASE = [
  {id:'sessions', label:'Sessions'},
  {id:'customers', label:'Customers'},
  {id:'analytics', label:'Analytics'},
  {id:'remittance', label:'Remittance'},
];
const MANAGER_EXTRA_TAB = {id:'branch-recon', label:'Branch Reconciliation'};

function renderBranchShell(){
  const tabs = currentUser.role === 'manager' ? [...BRANCH_TABS_BASE, MANAGER_EXTRA_TAB] : BRANCH_TABS_BASE;
  if(!activeTab || !tabs.find(t=>t.id===activeTab)) activeTab = 'sessions';
  root.innerHTML = shellHeader(tabs);
  bindShellChrome();
  if(activeTab==='sessions') renderSessions();
  else if(activeTab==='customers') renderCustomers();
  else if(activeTab==='analytics') renderAnalytics();
  else if(activeTab==='remittance') renderRemittance();
  else renderBranchReconciliation();
}

const OWNER_TABS_BASE = [
  {id:'dashboard', label:'Reconciliation'},
  {id:'approvals', label:'Approvals'},
  {id:'transactions', label:'Transactions'},
  {id:'branches', label:'Branches'},
  {id:'workers', label:'Staff'},
  {id:'stations', label:'Stations'},
];
function ownerTabs(){
  const count = pendingApprovalsCount();
  return OWNER_TABS_BASE.map(t=>{
    if(t.id !== 'approvals' || count === 0) return t;
    return { ...t, label: `${t.label}<span class="tab-badge">${count}</span>` };
  });
}
function renderOwnerShell(){
  const tabs = ownerTabs();
  if(!activeTab || !tabs.find(t=>t.id===activeTab)) activeTab = 'dashboard';
  root.innerHTML = shellHeader(tabs);
  bindShellChrome();
  if(activeTab==='dashboard') renderReconciliation(branches);
  else if(activeTab==='approvals') renderApprovals();
  else if(activeTab==='transactions') renderAllTransactions();
  else if(activeTab==='branches') renderBranchesOverview();
  else if(activeTab==='workers') renderWorkersManage();
  else renderOwnerStations();
}

// ================= SESSIONS TAB (branch staff) =================
function renderSessions(){
  const st = stations; // already scoped to branch via loadStations()
  let html = `<div class="section-title"><div><h2>Stations &mdash; ${branchName(currentUser.branchId)}</h2><p>Tap a station to start or end a session</p></div></div><div class="grid">`;
  if(st.length===0){
    html += `</div><div class="empty-state">No stations set up for your branch yet. Ask the Owner to add one.</div>`;
    bodyEl.innerHTML = html;
    return;
  }
  st.forEach(s=>{
    const occ = !!s.active;
    html += `
      <div class="station-card ${occ?'occupied':'available'}" data-id="${s.id}">
        <div class="st-type">${s.type}</div>
        <div class="st-name">${s.name}</div>
        <div class="st-status"><span class="dot ${occ?'occupied':'available'}"></span>${occ?'Occupied':'Available'}</div>
        ${occ ? `<div class="st-timer mono" data-timer="${s.id}">00:00</div><div class="st-customer">${s.active.customer_name || 'Guest'}</div>`
              : `<div class="st-rate">${fmtMoney(s.rate)} / hr</div>`}
      </div>`;
  });
  html += `</div>`;
  bodyEl.innerHTML = html;

  bodyEl.querySelectorAll('.station-card').forEach(card=>{
    card.addEventListener('click', ()=>{
      const s = stations.find(x=>x.id===card.dataset.id);
      if(s.active) openEndSessionModal(s);
      else openStartSessionModal(s);
    });
  });

  timerInterval = setInterval(()=>{
    st.forEach(s=>{
      if(s.active){
        const el = bodyEl.querySelector(`[data-timer="${s.id}"]`);
        if(el) el.textContent = fmtElapsed(Date.now() - new Date(s.active.start_time).getTime());
      }
    });
  }, 1000);
}

function openStartSessionModal(s){
  openOverlay(`
    <div class="modal">
      <h3>Start Session &mdash; ${s.name}</h3>
      <div class="field"><label>Customer full name</label><input id="cust-name" placeholder="e.g. Tunde Okafor"></div>
      <div class="field"><label>Telephone number</label><input id="cust-phone" placeholder="080..."></div>
      <div class="field"><label>Rate (${CURRENCY}/hr)</label><input id="cust-rate" type="number" value="${s.rate}" disabled></div>
      <div class="field hint" style="margin-top:-10px;">Rate is fixed by the Owner for this station.</div>
      <div class="modal-actions">
        <button class="btn secondary" id="cancel-start">Cancel</button>
        <button class="btn" id="confirm-start">Start</button>
      </div>
    </div>`);
  document.getElementById('cancel-start').onclick = closeOverlay;
  document.getElementById('confirm-start').onclick = async ()=>{
    const name = document.getElementById('cust-name').value.trim() || 'Guest';
    const phone = document.getElementById('cust-phone').value.trim();
    const btn = document.getElementById('confirm-start');
    btn.disabled = true; btn.textContent = 'Starting...';
    const { error } = await supabase.from('stations').update({
      active: { customer_name: name, phone, start_time: new Date().toISOString(), rate: s.rate }
    }).eq('id', s.id);
    if(await fatalIfError(error, 'Starting session')){ btn.disabled=false; btn.textContent='Start'; return; }
    await loadStations();
    closeOverlay();
    renderRoot();
  };
}

function openEndSessionModal(s){
  const elapsedMs = Date.now() - new Date(s.active.start_time).getTime();
  const minutes = Math.max(1, Math.ceil(elapsedMs/60000));
  openOverlay(`
    <div class="modal">
      <h3>End Session &mdash; ${s.name}</h3>
      <p style="font-size:13px;color:var(--text-dim);margin-top:-8px;">
        ${s.active.customer_name} &middot; ${fmtElapsed(elapsedMs)} played
      </p>
      <div class="field"><label>Minutes to bill</label><input id="bill-minutes" type="number" value="${minutes}"></div>
      <div class="field"><label>Rate (${CURRENCY}/hr)</label><input id="bill-rate" type="number" value="${s.active.rate}" disabled></div>
      <div class="modal-actions">
        <button class="btn secondary" id="cancel-end">Cancel</button>
        <button class="btn danger" id="confirm-end">End &amp; Bill</button>
      </div>
    </div>`);
  document.getElementById('cancel-end').onclick = closeOverlay;
  document.getElementById('confirm-end').onclick = async ()=>{
    const mins = parseFloat(document.getElementById('bill-minutes').value) || minutes;
    const rate = s.active.rate;
    const btn = document.getElementById('confirm-end');
    btn.disabled = true; btn.textContent = 'Billing...';
    const { data, error } = await supabase.rpc('end_session', {
      p_station_id: s.id, p_minutes: mins, p_rate: rate, p_receipt_no: newReceiptNo(),
    });
    if(await fatalIfError(error, 'Ending session')){ btn.disabled=false; btn.textContent='End & Bill'; return; }
    await loadBranchData();
    showReceipt(data);
  };
}

function showReceipt(tx){
  const d = new Date(tx.created_at);
  openOverlay(`
    <div class="ticket-wrap">
      <div class="ticket">
        <div class="ticket-head">
          <div class="display">${BRAND}</div>
          <div class="mono">${branchName(tx.branch_id).toUpperCase()} BRANCH</div>
        </div>
        <div class="ticket-row label"><span>Receipt</span><span>${tx.receipt_no}</span></div>
        <div class="ticket-row label"><span>Date</span><span>${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span></div>
        <div class="ticket-row label"><span>Customer</span><span>${tx.customer_name}</span></div>
        <div class="ticket-row label"><span>Phone</span><span>${tx.phone || '—'}</span></div>
        <div class="ticket-row label"><span>Served by</span><span>${tx.clerk_name}</span></div>
        <div class="ticket-row" style="margin-top:10px;"><span>${tx.station_name}</span><span>${tx.minutes} min</span></div>
        <div class="ticket-row label"><span>Rate</span><span>${fmtMoney(tx.rate)}/hr</span></div>
        <div class="ticket-total"><span>TOTAL</span><span>${fmtMoney(tx.total)}</span></div>
        <div class="ticket-foot">${SLOGAN.toUpperCase()}</div>
      </div>
    </div>
    <div style="text-align:center;margin-top:6px;">
      <button class="btn secondary" id="close-receipt">Close</button>
    </div>
  `);
  document.getElementById('close-receipt').onclick = ()=>{ closeOverlay(); renderRoot(); };
}

// ================= CUSTOMERS TAB =================
function buildCustomerList(txList){
  const map = {};
  txList.forEach(t=>{
    const key = (t.phone && t.phone.trim()) ? t.phone.trim() : ('name:'+t.customer_name.toLowerCase());
    if(!map[key]) map[key] = {name:t.customer_name, phone:t.phone||'', visits:0, totalSpent:0, lastVisit:0, favoriteStation:{}};
    const c = map[key];
    const ts = new Date(t.created_at).getTime();
    c.visits += 1;
    c.totalSpent += Number(t.total);
    c.lastVisit = Math.max(c.lastVisit, ts);
    c.favoriteStation[t.station_name] = (c.favoriteStation[t.station_name]||0)+1;
    if(ts >= c.lastVisit){ c.name = t.customer_name; c.phone = t.phone||c.phone; }
  });
  return Object.values(map).sort((a,b)=>b.lastVisit-a.lastVisit);
}

function renderCustomers(){
  const customers = buildCustomerList(transactions);
  bodyEl.innerHTML = `
    <div class="section-title">
      <div><h2>Customers</h2><p>Everyone who has visited ${branchName(currentUser.branchId)}</p></div>
      <button class="btn" id="export-excel">Export to Excel</button>
    </div>
    <div class="search-row"><input id="cust-search" placeholder="Search by name or phone..."></div>
    <div id="cust-table-wrap"></div>
  `;

  function draw(filterText){
    const wrap = document.getElementById('cust-table-wrap');
    const filtered = customers.filter(c=>{
      if(!filterText) return true;
      const f = filterText.toLowerCase();
      return c.name.toLowerCase().includes(f) || (c.phone||'').includes(f);
    });
    if(filtered.length===0){
      wrap.innerHTML = `<div class="empty-state">${customers.length===0 ? 'No customers yet — end a session to log your first one.' : 'No matches.'}</div>`;
      return;
    }
    const rows = filtered.map(c=>{
      const fav = Object.entries(c.favoriteStation).sort((a,b)=>b[1]-a[1])[0];
      const d = new Date(c.lastVisit);
      return `
        <tr>
          <td class="cust-name">${c.name}</td>
          <td class="cust-phone">${c.phone || '—'}</td>
          <td><span class="cust-badge">${c.visits} visit${c.visits>1?'s':''}</span></td>
          <td>${fmtMoney(c.totalSpent)}</td>
          <td>${fav ? fav[0] : '—'}</td>
          <td>${d.toLocaleDateString()}</td>
        </tr>`;
    }).join('');
    wrap.innerHTML = `
      <div class="table-scroll"><table class="cust-table">
        <thead><tr><th>Name</th><th>Phone</th><th>Visits</th><th>Total spent</th><th>Favorite station</th><th>Last visit</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }
  draw('');
  document.getElementById('cust-search').addEventListener('input', (e)=>draw(e.target.value));
  document.getElementById('export-excel').addEventListener('click', ()=>exportToExcel(customers, transactions, branchName(currentUser.branchId)));
}

function exportToExcel(customers, txList, label){
  if(typeof XLSX === 'undefined'){
    alert('Excel export library did not load — check your connection and try again.');
    return;
  }
  const custRows = customers.map(c=>{
    const fav = Object.entries(c.favoriteStation).sort((a,b)=>b[1]-a[1])[0];
    return {
      'Name': c.name, 'Phone': c.phone || '', 'Visits': c.visits, 'Total Spent': c.totalSpent,
      'Favorite Station': fav ? fav[0] : '', 'Last Visit': new Date(c.lastVisit).toLocaleString()
    };
  });
  const txRows = txList.slice().sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).map(t=>({
    'Receipt': t.receipt_no, 'Date': new Date(t.created_at).toLocaleString(), 'Branch': branchName(t.branch_id),
    'Clerk': t.clerk_name||'', 'Customer': t.customer_name, 'Phone': t.phone || '', 'Station': t.station_name,
    'Station Type': t.station_type, 'Minutes': t.minutes, 'Rate/hr': t.rate, 'Total': t.total
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(custRows), 'Customers');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(txRows), 'Transactions');
  XLSX.writeFile(wb, 'baizeboss-' + label.replace(/\s+/g,'-').toLowerCase() + '-' + new Date().toISOString().slice(0,10) + '.xlsx');
}

// ================= ANALYTICS TAB =================
function periodBoundaries(){
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
  const startOfWeek = startOfDay - (now.getDay())*86400000;
  const startOfMonth = new Date(now.getFullYear(),now.getMonth(),1).getTime();
  return {startOfDay, startOfWeek, startOfMonth};
}

function renderAnalytics(){
  const {startOfDay, startOfWeek, startOfMonth} = periodBoundaries();
  const withTs = transactions.map(t=>({...t, _ts: new Date(t.created_at).getTime()}));
  const today = withTs.filter(t=>t._ts>=startOfDay);
  const week = withTs.filter(t=>t._ts>=startOfWeek);
  const month = withTs.filter(t=>t._ts>=startOfMonth);
  const sum = arr => arr.reduce((a,t)=>a+Number(t.total),0);

  let html = `
    <div class="section-title"><div><h2>Analytics</h2><p>${branchName(currentUser.branchId)} &mdash; customer counts and revenue</p></div></div>
    <div class="stat-grid">
      <div class="stat-card"><div class="num">${today.length}</div><div class="lbl">Customers today</div></div>
      <div class="stat-card"><div class="num">${week.length}</div><div class="lbl">This week</div></div>
      <div class="stat-card"><div class="num">${month.length}</div><div class="lbl">This month</div></div>
      <div class="stat-card"><div class="num">${fmtMoney(sum(today))}</div><div class="lbl">Revenue today</div></div>
      <div class="stat-card"><div class="num">${fmtMoney(sum(week))}</div><div class="lbl">Revenue this week</div></div>
      <div class="stat-card"><div class="num">${fmtMoney(sum(month))}</div><div class="lbl">Revenue this month</div></div>
    </div>
  `;

  if(transactions.length===0){
    html += `<div class="empty-state">No sessions logged yet &mdash; end a session to see stats appear here.</div>`;
  } else {
    const byStation = {};
    transactions.forEach(t=>{ byStation[t.station_name] = (byStation[t.station_name]||0) + 1; });
    const maxCount = Math.max(...Object.values(byStation));
    html += `<div class="section-title" style="margin-top:8px;"><div><h2 style="font-size:18px;">Popular games</h2></div></div>`;
    Object.entries(byStation).sort((a,b)=>b[1]-a[1]).forEach(([name,count])=>{
      html += `
        <div class="bar-row">
          <div class="name">${name}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${(count/maxCount*100)}%"></div></div>
          <div class="bar-val">${count} sess.</div>
        </div>`;
    });
  }
  bodyEl.innerHTML = html;
}

// ================= REMITTANCE TAB (branch staff) =================
function renderRemittance(){
  const myRem = remittances
    .filter(r=> currentUser.role === 'manager' ? true : r.worker_id === currentUser.id)
    .sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  const today = new Date().toISOString().slice(0,10);
  const heading = currentUser.role === 'manager' ? 'Branch remittance history' : 'Your remittance history';
  bodyEl.innerHTML = `
    <div class="section-title"><div><h2>Shift Remittance</h2><p>Log the physical cash you are handing over for reconciliation</p></div></div>
    <div class="auth-panel" style="max-width:420px;">
      <div class="field"><label>Date</label><input id="rem-date" type="date" value="${today}"></div>
      <div class="field"><label>Cash amount remitted (${CURRENCY})</label><input id="rem-amount" type="number" placeholder="0"></div>
      <div class="field"><label>Note (optional)</label><input id="rem-note" placeholder="e.g. Morning shift"></div>
      <button class="btn" id="rem-submit" style="width:100%;">Submit Remittance</button>
    </div>
    <div class="section-title" style="margin-top:26px;"><div><h2 style="font-size:18px;">${heading}</h2></div></div>
    <div id="rem-history"></div>
  `;

  function drawHistory(){
    const wrap = document.getElementById('rem-history');
    if(myRem.length===0){ wrap.innerHTML = `<div class="empty-state">No remittances logged yet.</div>`; return; }
    const showWho = currentUser.role === 'manager';
    const rows = myRem.map(r=>`
      <tr>
        <td>${r.remit_date}</td>
        ${showWho ? `<td>${r.worker_name}</td>` : ''}
        <td>${fmtMoney(r.amount)}</td>
        <td>${r.note||'—'}</td>
        <td>${new Date(r.created_at).toLocaleString()}</td>
      </tr>`).join('');
    wrap.innerHTML = `
      <div class="table-scroll"><table class="cust-table">
        <thead><tr><th>Date</th>${showWho ? '<th>Staff</th>' : ''}<th>Amount</th><th>Note</th><th>Logged at</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }
  drawHistory();

  document.getElementById('rem-submit').onclick = async ()=>{
    const date = document.getElementById('rem-date').value || today;
    const amount = parseFloat(document.getElementById('rem-amount').value);
    const note = document.getElementById('rem-note').value.trim();
    if(!amount || amount<=0){ alert('Enter a valid cash amount.'); return; }
    const btn = document.getElementById('rem-submit');
    btn.disabled = true; btn.textContent = 'Submitting...';
    const { error } = await supabase.from('remittances').insert({
      branch_id: currentUser.branchId, worker_id: currentUser.id, worker_name: currentUser.name,
      remit_date: date, amount, note,
    });
    if(await fatalIfError(error, 'Submitting remittance')){ btn.disabled=false; btn.textContent='Submit Remittance'; return; }
    await loadRemittances();
    renderRemittance();
  };
}

// ================= MANAGER: BRANCH RECONCILIATION (read-only) =================
function renderBranchReconciliation(){
  renderReconciliation(branches.filter(b=>b.id===currentUser.branchId), true);
}

// ================= STATIONS MANAGE (Owner only) =================
async function renderStationsManageInto(container, branchId){
  const { data, error } = await supabase.from('stations').select('*').eq('branch_id', branchId).order('name');
  if(await fatalIfError(error, 'Loading stations')) return;
  const list = data || [];
  container.innerHTML = `
    <div class="section-title"><div><h2>Manage Stations</h2><p>${branchName(branchId)} &mdash; edit names/rates or add new games</p></div>
    <button class="btn" id="add-station">+ Add station</button></div>
    <div id="manage-list"></div>
  `;
  const listEl = container.querySelector('#manage-list');
  list.forEach(s=>{
    const row = document.createElement('div');
    row.className='manage-row';
    row.innerHTML = `
      <input class="name-input" value="${s.name}" data-field="name" data-id="${s.id}">
      <input class="name-input" style="flex:0.6;" value="${s.type}" data-field="type" data-id="${s.id}">
      <input class="rate-input" type="number" value="${s.rate}" data-field="rate" data-id="${s.id}">
      <button class="remove-btn" data-remove="${s.id}" ${s.active? 'disabled title="Session active"':''}>&times;</button>
    `;
    listEl.appendChild(row);
  });
  if(list.length===0){ listEl.innerHTML = `<div class="empty-state">No stations for this branch yet.</div>`; }

  listEl.querySelectorAll('input').forEach(inp=>{
    inp.addEventListener('change', async ()=>{
      const field = inp.dataset.field;
      const value = field==='rate' ? (parseFloat(inp.value)||0) : inp.value;
      const { error } = await supabase.from('stations').update({ [field]: value }).eq('id', inp.dataset.id);
      await fatalIfError(error, 'Updating station');
    });
  });
  listEl.querySelectorAll('[data-remove]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const { error } = await supabase.from('stations').delete().eq('id', btn.dataset.remove);
      if(await fatalIfError(error, 'Removing station')) return;
      renderStationsManageInto(container, branchId);
    });
  });
  container.querySelector('#add-station').onclick = async ()=>{
    const { error } = await supabase.from('stations').insert({ branch_id: branchId, name:'New Station', type:'PS5', rate:500 });
    if(await fatalIfError(error, 'Adding station')) return;
    renderStationsManageInto(container, branchId);
  };
}

function renderOwnerStations(){
  bodyEl.innerHTML = `
    <div class="section-title"><div><h2>Stations</h2><p>Select a branch to manage its games/tables and pricing</p></div>
    <select id="owner-branch-pick"></select></div>
    <div id="owner-station-body"></div>
  `;
  const pick = document.getElementById('owner-branch-pick');
  branches.forEach(b=>{ const o=document.createElement('option'); o.value=b.id; o.textContent=b.name; pick.appendChild(o); });
  const container = document.getElementById('owner-station-body');
  renderStationsManageInto(container, branches[0].id);
  pick.addEventListener('change', ()=>renderStationsManageInto(container, pick.value));
}

// ================= RECONCILIATION DASHBOARD (Owner: all branches, Manager: own branch read-only) =================
function sumInRange(list, branchId, field, start, end, dateField='created_at'){
  return list.filter(x=>{
    const ts = new Date(x[dateField]).getTime();
    return x.branch_id===branchId && ts>=start && ts<end;
  }).reduce((a,x)=>a+Number(x[field]||0),0);
}

function renderReconciliation(branchList, readOnlyHeading){
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
  const startOfWeek = startOfDay - (now.getDay())*86400000;
  const startOfMonth = new Date(now.getFullYear(),now.getMonth(),1).getTime();
  const nowMs = Date.now() + 1;

  const periods = [
    {label:'Daily (Today)', start:startOfDay, end:nowMs},
    {label:'Weekly (This week)', start:startOfWeek, end:nowMs},
    {label:'Monthly (This month)', start:startOfMonth, end:nowMs},
  ];

  let flaggedCount = 0;
  let rows = '';
  periods.forEach(p=>{
    branchList.forEach(b=>{
      const expected = sumInRange(transactions, b.id, 'total', p.start, p.end, 'created_at');
      const remitted = sumInRange(remittances, b.id, 'amount', p.start, p.end, 'created_at');
      const variance = expected - remitted;
      const shortage = Math.round(variance) > 0;
      if(shortage) flaggedCount++;
      rows += `
        <tr class="${shortage?'row-flag':''}">
          <td>${p.label}</td>
          <td>${b.name}</td>
          <td>${fmtMoney(expected)}</td>
          <td>${fmtMoney(remitted)}</td>
          <td class="${shortage?'variance-bad':'variance-ok'}">${fmtMoney(variance)}</td>
          <td>${shortage ? '<span class="flag-pill">&#9888; Shortage</span>' : (variance < 0 ? '<span class="cust-badge">Overage</span>' : '<span class="cust-badge">Balanced</span>')}</td>
        </tr>`;
    });
  });

  const totalExpectedToday = branchList.reduce((a,b)=>a+sumInRange(transactions,b.id,'total',startOfDay,nowMs,'created_at'),0);
  const totalRemittedToday = branchList.reduce((a,b)=>a+sumInRange(remittances,b.id,'amount',startOfDay,nowMs,'created_at'),0);
  const title = readOnlyHeading ? 'Branch Reconciliation' : 'Revenue Reconciliation';
  const sub = readOnlyHeading
    ? 'Read-only view of your branch\u2019s expected revenue vs. cash remitted'
    : 'System expected revenue vs. staff cash remittance, across all branches';

  bodyEl.innerHTML = `
    <div class="section-title"><div><h2>${title}</h2><p>${sub}</p></div></div>
    <div class="stat-grid">
      <div class="stat-card"><div class="num">${fmtMoney(totalExpectedToday)}</div><div class="lbl">Expected revenue today</div></div>
      <div class="stat-card"><div class="num">${fmtMoney(totalRemittedToday)}</div><div class="lbl">Cash remitted today</div></div>
      <div class="stat-card ${flaggedCount>0?'warn':''}"><div class="num">${flaggedCount}</div><div class="lbl">Flagged shortages</div></div>
    </div>
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th>Timeframe</th><th>Branch Location</th><th>System Expected Revenue (A)</th><th>Staff Cash Remitted (B)</th><th>Variance (A&minus;B)</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p style="font-size:11.5px;color:var(--text-dim);margin-top:14px;">A positive variance means expected revenue exceeds what was remitted &mdash; a possible cash shortage, flagged in red. A negative variance means more cash was remitted than the system recorded. Both ledgers are append-only at the database level, so neither side of this comparison can be edited after the fact.</p>
  `;
}

// ================= OWNER: ALL TRANSACTIONS =================
function renderAllTransactions(){
  bodyEl.innerHTML = `
    <div class="section-title">
      <div><h2>All Transactions</h2><p>Session-level ledger across every branch</p></div>
      <button class="btn" id="export-all">Export to Excel</button>
    </div>
    <div class="search-row">
      <select id="tx-branch-filter"><option value="">All branches</option>${branches.map(b=>`<option value="${b.id}">${b.name}</option>`).join('')}</select>
      <input id="tx-search" placeholder="Search customer or clerk...">
    </div>
    <div id="tx-table-wrap"></div>
  `;

  function draw(){
    const branchFilter = document.getElementById('tx-branch-filter').value;
    const q = document.getElementById('tx-search').value.toLowerCase();
    const filtered = transactions.filter(t=>{
      if(branchFilter && t.branch_id!==branchFilter) return false;
      if(q && !(t.customer_name.toLowerCase().includes(q) || (t.clerk_name||'').toLowerCase().includes(q))) return false;
      return true;
    }).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
    const wrap = document.getElementById('tx-table-wrap');
    if(filtered.length===0){ wrap.innerHTML = `<div class="empty-state">No transactions match.</div>`; return; }
    const rows = filtered.map(t=>`
      <tr>
        <td>${new Date(t.created_at).toLocaleString()}</td>
        <td><span class="branch-badge">${branchName(t.branch_id)}</span></td>
        <td>${t.clerk_name||'—'}</td>
        <td>${t.customer_name}</td>
        <td>${t.station_name}</td>
        <td>${t.minutes} min</td>
        <td>${fmtMoney(t.total)}</td>
      </tr>`).join('');
    wrap.innerHTML = `
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>Date</th><th>Branch</th><th>Clerk</th><th>Customer</th><th>Station</th><th>Duration</th><th>Total</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }
  draw();
  document.getElementById('tx-branch-filter').addEventListener('change', draw);
  document.getElementById('tx-search').addEventListener('input', draw);
  document.getElementById('export-all').addEventListener('click', ()=>{
    const customers = buildCustomerList(transactions);
    exportToExcel(customers, transactions, 'all-branches');
  });
}

// ================= OWNER: BRANCHES OVERVIEW =================
function renderBranchesOverview(){
  const {startOfDay, startOfMonth} = periodBoundaries();
  let html = `<div class="section-title"><div><h2>Branches</h2><p>Snapshot of each location</p></div></div><div class="stat-grid">`;
  branches.forEach(b=>{
    const txB = transactions.filter(t=>t.branch_id===b.id);
    const todayRev = txB.filter(t=>new Date(t.created_at).getTime()>=startOfDay).reduce((a,t)=>a+Number(t.total),0);
    const monthRev = txB.filter(t=>new Date(t.created_at).getTime()>=startOfMonth).reduce((a,t)=>a+Number(t.total),0);
    const workerCount = workers.filter(w=>w.branch_id===b.id).length;
    const stationCount = stations.filter(s=>s.branch_id===b.id).length;
    html += `
      <div class="stat-card" style="min-width:220px;">
        <div style="font-family:'Playfair Display',serif; font-weight:700; font-size:19px;margin-bottom:8px;">${b.name}</div>
        <div class="lbl">Revenue today</div><div class="num" style="font-size:22px;">${fmtMoney(todayRev)}</div>
        <div class="lbl" style="margin-top:8px;">Revenue this month</div><div class="num" style="font-size:22px;">${fmtMoney(monthRev)}</div>
        <div style="font-size:11.5px;color:var(--text-dim);margin-top:10px;">${workerCount} staff &middot; ${stationCount} station${stationCount!==1?'s':''}</div>
      </div>`;
  });
  html += `</div>`;
  bodyEl.innerHTML = html;
}

// ================= OWNER: STAFF MANAGE =================
function renderWorkersManage(){
  bodyEl.innerHTML = `
    <div class="section-title"><div><h2>Manage Staff</h2><p>Reassign branches, promote to Manager, or rename accounts. To remove access, delete the user from Supabase Authentication.</p></div></div>
    <div id="worker-list"></div>
  `;
  const listEl = document.getElementById('worker-list');
  workers.forEach(w=>{
    const row = document.createElement('div');
    row.className='manage-row';
    const branchOpts = branches.map(b=>`<option value="${b.id}" ${b.id===w.branch_id?'selected':''}>${b.name}</option>`).join('');
    const roleOpts = ['sales_rep','manager'].map(r=>`<option value="${r}" ${r===w.role?'selected':''}>${roleLabel(r)}</option>`).join('');
    row.innerHTML = `
      <input class="name-input" value="${w.full_name}" data-field="full_name" data-id="${w.id}">
      <select data-field="branch_id" data-id="${w.id}">${branchOpts}</select>
      <select data-field="role" data-id="${w.id}">${roleOpts}</select>
    `;
    listEl.appendChild(row);
  });
  if(workers.length===0){ listEl.innerHTML = `<div class="empty-state">No staff registered yet.</div>`; }

  listEl.querySelectorAll('input, select').forEach(inp=>{
    inp.addEventListener('change', async ()=>{
      const { error } = await supabase.from('profiles').update({ [inp.dataset.field]: inp.value }).eq('id', inp.dataset.id);
      if(await fatalIfError(error, 'Updating staff member')) return;
      await loadWorkers();
    });
  });
}

// ================= OWNER: PENDING APPROVALS =================
// Every entity type here (employees, states, outlets, games) follows
// the same shape established across Stages 3-5: `status` is the
// record's true current state, `pending_action` marks an in-flight
// request from a General Manager or Branch Supervisor that only takes
// effect once the Owner approves it here. See the migration comments
// in 0003/0004/0006 for the full design rationale.
function approvalActionLabel(item){
  if(item.status === 'pending_approval') return 'New';
  if(item.pending_action === 'activate') return 'Activate';
  if(item.pending_action === 'deactivate') return 'Deactivate';
  if(item.pending_action === 'transfer') return 'Transfer';
  return 'Change';
}

function approvalCard(kind, item, title, sub){
  return `
    <div class="approval-card" data-kind="${kind}" data-id="${item.id}">
      <div class="approval-info">
        <span class="approval-pill">${approvalActionLabel(item)}</span>
        <div class="approval-title">${title}</div>
        ${sub ? `<div class="approval-sub">${sub}</div>` : ''}
      </div>
      <div class="approval-actions">
        <button class="btn-approve" data-action="approve">Approve</button>
        <button class="btn-reject" data-action="reject">Reject</button>
      </div>
    </div>`;
}

async function renderApprovals(){
  bodyEl.innerHTML = `
    <div class="section-title"><div><h2>Pending Approvals</h2><p>Requests from your General Managers and Branch Supervisors, waiting on your review</p></div></div>
    <div class="empty-state">Loading...</div>`;
  await loadPendingApprovals();
  renderApprovalsList();
}

function renderApprovalsList(){
  const { employees, states, outlets, games } = pendingApprovals;
  const total = pendingApprovalsCount();

  let html = `<div class="section-title"><div><h2>Pending Approvals</h2><p>${total} item${total!==1?'s':''} waiting on your review</p></div></div>`;

  if(total === 0){
    html += `<div class="empty-state">Nothing pending right now &mdash; you're all caught up.</div>`;
    bodyEl.innerHTML = html;
    return;
  }

  if(employees.length){
    html += `<div class="approval-group-title">Employees</div><div class="approval-list">` +
      employees.map(e=>approvalCard('employee', e, e.full_name,
        `${roleLabel(e.role)}${e.requested_at ? ' &middot; requested '+new Date(e.requested_at).toLocaleDateString() : ''}`)).join('') +
      `</div>`;
  }
  if(states.length){
    html += `<div class="approval-group-title">States</div><div class="approval-list">` +
      states.map(s=>approvalCard('state', s, s.name,
        s.requested_at ? `Requested ${new Date(s.requested_at).toLocaleDateString()}` : '')).join('') +
      `</div>`;
  }
  if(outlets.length){
    html += `<div class="approval-group-title">Outlets</div><div class="approval-list">` +
      outlets.map(o=>approvalCard('outlet', o, o.name,
        o.requested_at ? `Requested ${new Date(o.requested_at).toLocaleDateString()}` : '')).join('') +
      `</div>`;
  }
  if(games.length){
    html += `<div class="approval-group-title">Games</div><div class="approval-list">` +
      games.map(g=>approvalCard('game', g, g.name,
        g.pending_action==='transfer' ? 'Transfer to another outlet requested' :
        (g.requested_at ? `Requested ${new Date(g.requested_at).toLocaleDateString()}` : ''))).join('') +
      `</div>`;
  }

  bodyEl.innerHTML = html;

  const RPC_MAP = {
    employee: { approve: 'approve_employee', reject: 'reject_employee' },
    state:    { approve: 'approve_state',    reject: 'reject_state' },
    outlet:   { approve: 'approve_outlet',   reject: 'reject_outlet' },
    game:     { approve: 'approve_game',     reject: 'reject_game' },
  };

  bodyEl.querySelectorAll('.approval-card').forEach(card=>{
    card.querySelectorAll('button[data-action]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const kind = card.dataset.kind;
        const id = card.dataset.id;
        const action = btn.dataset.action;
        card.querySelectorAll('button').forEach(b=>b.disabled = true);
        btn.textContent = action === 'approve' ? 'Approving...' : 'Rejecting...';

        const { error } = await supabase.rpc(RPC_MAP[kind][action], { p_id: id });
        if(await fatalIfError(error, `${action === 'approve' ? 'Approving' : 'Rejecting'} this ${kind}`)){
          card.querySelectorAll('button').forEach(b=>b.disabled = false);
          btn.textContent = action === 'approve' ? 'Approve' : 'Reject';
          return;
        }
        await loadPendingApprovals();
        renderApprovalsList();
      });
    });
  });
}

// ---------------------------------------------------------------------
// BOOT
// ---------------------------------------------------------------------
initAuth();