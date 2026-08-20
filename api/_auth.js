'use strict';
// INTERIM access gate. This is NOT the authentication described in the plan
// (Supabase Auth magic links restricted to @citizengo.net) — it is a single
// shared bearer token, so it gives no per-user identity and no audit trail.
//
// It exists so that a deployed dashboard of internal performance data is not
// wide open to the web while real auth is outstanding. If DASHBOARD_TOKEN is
// unset the API refuses to serve rather than defaulting to open.
module.exports = function checkAuth(req, res) {
  const expected = process.env.DASHBOARD_TOKEN;
  if (!expected) {
    res.status(503).json({ error: 'no_dashboard_token_configured' });
    return false;
  }
  const header = req.headers.authorization || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (supplied !== expected) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
};
