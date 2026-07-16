# BaizeBoss
**Where skill meets style.**

Multi-branch game station management system (Games, Lifestyle & Entertainment) for BaizeBoss — Port Harcourt, Abuja, and Kaduna. Built on:

- **Supabase** — Postgres database, Auth, real-time sync, and Row Level Security (RLS) as the security layer
- **Cloudflare Pages** — static hosting for the frontend (no build step, no server to maintain)

This repo is **Phase 1** of the full BaizeBoss build: branches, 3-tier roles (Owner / Manager / Sales Rep), session recording & receipts, and an append-only revenue-vs-remittance reconciliation ledger. See "Roadmap" at the bottom for what comes next.

---

## 1. How the security model works

This system does **not** use PIN codes or client-side password checks — those can be read out of the page source and bypassed. Instead:

- **Real accounts.** Every person signs in through Supabase Auth (email + password), which Supabase hashes and manages. This app never sees or stores a raw password.
- **Row Level Security (RLS).** Every table (`branches`, `profiles`, `stations`, `transactions`, `remittances`) has RLS turned on in Postgres itself. A Sales Rep's database session is *physically incapable* of reading another branch's data — it's not just hidden in the UI, the database refuses the query. See `supabase/migrations/0001_init.sql` for every policy, with comments explaining the reasoning.
- **Append-only ledgers.** `transactions` (system revenue) and `remittances` (cash handed over) have no UPDATE or DELETE policy for *any* role, including the Owner. Once a session is billed or cash is remitted, that row cannot be edited or deleted by anyone through the app. This is what makes the reconciliation numbers trustworthy.
- **Column-level pricing lock.** Row-level security can't stop a Sales Rep from editing one column of a row they're allowed to touch, so a Postgres trigger (`enforce_station_pricing_lock`) blocks anyone but the Owner from changing a station's name, type, rate, or branch — even though staff can update that same row to start/end a session.
- **No public path to power.** The public registration form can only ever create a `sales_rep` account. There's no button anywhere that creates a `manager` or `owner` account — managers are promoted by the Owner from inside the app, and the first Owner account is created directly in Supabase by whoever administers it (steps below). This prevents privilege escalation through the signup form.
- **The public API key is safe to expose.** Supabase's "anon" key is meant to sit in every browser that loads the site — it's not a secret. What actually protects your data is RLS. This is explained again inline in `public/js/config.js`.
- **Transport security.** Cloudflare Pages serves everything over HTTPS automatically. `public/_headers` adds a strict Content-Security-Policy, HSTS, clickjacking protection (`X-Frame-Options: DENY`), and MIME-sniffing protection.

---

## 2. Set up Supabase

1. Go to [supabase.com](https://supabase.com) → **New project**. Pick a strong database password and save it somewhere safe (a password manager, not this repo).
2. Once the project is ready, open **SQL Editor** → **New query**, paste in the entire contents of `supabase/migrations/0001_init.sql`, and click **Run**. This creates every table, trigger, and security policy, and seeds the three branches.
3. Go to **Authentication → Providers** and confirm **Email** is enabled.
4. Go to **Authentication → Settings**:
   - Turn **Confirm email** ON for production (recommended) — new staff will need to click a confirmation link before they can log in. You can turn this off temporarily while testing.
   - Under **Site URL**, set it to your future Cloudflare Pages URL once you have it (Step 4 below covers getting that URL). You can come back and update this later.
   - Consider enabling **Leaked password protection** if your plan supports it.
5. Go to **Project Settings → API**. You'll need two values from this page in Step 3: the **Project URL** and the **anon public** key. **Never copy the `service_role` key into this project.**

### Create your first Owner account
The public signup form can only create Sales Rep accounts (by design — see the security model above). To create the Owner account:

1. In your app (once deployed, or running locally), use the **staff registration** form to sign up normally with the Owner's real name, email, and password. This creates a `sales_rep` profile — that's expected, you'll fix the role next.
2. In Supabase, go to **SQL Editor** and run:
   ```sql
   update profiles
   set role = 'owner', branch_id = null
   where id = (select id from auth.users where email = 'owner@baizeboss.com');
   ```
   (replace the email with the real one used to sign up)
3. Log out of the app and log back in through the **Owner login** screen.

To promote a Sales Rep to Manager later, the Owner can do this from inside the app: **Staff** tab → change their role dropdown to "Manager". No SQL needed for that one.

---

## 3. Configure the frontend

Open `public/js/config.js` and fill in the two values from Supabase → Project Settings → API:

```js
export const SUPABASE_URL = 'https://your-project-ref.supabase.co';
export const SUPABASE_ANON_KEY = 'your-anon-public-key';
```

Save it. That's the only configuration file in the whole project.

---

## 4. Push to GitHub

```bash
cd session-desk-pos
git init
git add .
git commit -m "BaizeBoss Phase 1: multi-branch POS, RBAC, reconciliation"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/baizeboss.git
git push -u origin main
```

---

## 5. Deploy to Cloudflare Pages

1. Cloudflare dashboard → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**.
2. Pick the repo you just pushed.
3. Build settings:
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Build output directory:** `public`
4. Click **Save and Deploy**. Cloudflare gives you a `*.pages.dev` URL — that's your live site.
5. Go back to Supabase → **Authentication → Settings → Site URL** and set it to that URL (or your custom domain once attached).
6. *(Optional)* Attach a custom domain under the Pages project's **Custom domains** tab.

### Recommended Cloudflare hardening (dashboard settings, no code needed)
- **SSL/TLS → Overview:** set to **Full (strict)**.
- **SSL/TLS → Edge Certificates:** turn on **Always Use HTTPS** and **Automatic HTTPS Rewrites**.
- **Security → Bots:** turn on **Bot Fight Mode** (free tier) to blunt scripted signup/login abuse.
- **Security → WAF:** add a rate-limiting rule on `/index.html` and your auth flows if you're on a paid plan, to slow down password-guessing attempts (Supabase also rate-limits auth server-side by default).

Every time you `git push`, Cloudflare Pages redeploys automatically.

---

## 6. Test it

1. Visit your Pages URL. Register a Sales Rep for one branch, and confirm the account (check email if confirmation is on).
2. Log in as that Sales Rep, start and end a session — you should see a receipt, and the customer should show up under **Customers**.
3. Submit a remittance under the **Remittance** tab.
4. Promote yourself (or a second test account) to Owner using the SQL step above, log in through **Owner login**, and check the **Reconciliation** tab shows the session you just logged.
5. Open the app in two browser tabs as the same branch — start a session in one tab and confirm it shows "Occupied" in the other within a couple seconds (that's the Supabase real-time subscription working).

---

## 7. Project structure

```
baizeboss/
├── README.md
├── .gitignore
├── .env.example
├── supabase/
│   └── migrations/
│       └── 0001_init.sql      ← run this once in Supabase SQL Editor
└── public/                    ← Cloudflare Pages output directory
    ├── index.html
    ├── _headers                ← Cloudflare security headers
    ├── assets/
    │   ├── logo-full.jpg       ← full logo + slogan (auth screen)
    │   ├── logo-mark.png       ← icon-only mark (header)
    │   └── favicon.png
    ├── css/
    │   └── styles.css
    └── js/
        ├── config.js           ← fill in your Supabase URL + anon key
        ├── supabaseClient.js
        └── app.js              ← all application logic
```

---

## 8. Roadmap — what's next

This repo covers Phase 1. Each later phase adds tables and RLS policies the same way `0001_init.sql` does, without needing to change anything already built:

| Phase | Adds |
|---|---|
| 2 | Game Management (equipment/maintenance status) + discounts & multiple payment types on a session |
| 3 | Staff profiles/photos, clock-in/out attendance, shift scheduling, leave management, performance scorecards |
| 4 | Inventory (snacks, drinks, cues, chess pieces) with low-stock alerts; expense tracking and P&L |
| 5 | Customer membership tiers, loyalty points, birthday reminders, VIP flagging |
| 6 | Staff leaderboard, alerts & notifications, expense/discount/refund/leave approval workflows |
| 7 | Full analytics suite, audit log, PDF export, biometric login (WebAuthn), CCTV integration |

Bring this file back when you're ready to start the next phase — the plan is to keep working through it step by step, with a summary after each one.
