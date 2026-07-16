// =====================================================================
// worker.js — single entry point for the whole project.
//
// This project deploys as a Cloudflare Worker (`wrangler deploy`), not
// classic Cloudflare Pages, so there's no automatic routing from a
// /functions folder — every request, static file or API call, comes
// through this one fetch handler first.
//
// Routing here on purpose stays a plain if/else, not a framework —
// there's exactly one API route today. Add more the same way as the
// project grows (Stage 6+ will likely add a few for sessions/rounds).
// =====================================================================

import { handleCreateEmployee } from './functions/create-employee.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/create-employee' && request.method === 'POST') {
      return handleCreateEmployee(request, env);
    }

    // Everything else: serve the static site exactly as before this
    // file existed. The `assets` binding in wrangler.jsonc is what
    // makes env.ASSETS available here.
    return env.ASSETS.fetch(request);
  },
};
// redeploy trigger