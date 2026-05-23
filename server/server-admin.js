const express = require('express');
const path = require('path');

/**
 * Creates a minimal admin router for the FaceBlurr server.
 * Provides a basic dashboard at /admin showing server health,
 * analytics, and recent logs. Protected by ADMIN_SECRET.
 */
function createAdminRouter({ pool, analytics, logs, dbConfig, getLogFilePath }) {
    const router = express.Router();

    // Simple session-based admin auth (cookie: admin_token)
    function requireAdmin(req, res, next) {
        const token = req.cookies?.admin_token || req.headers['x-admin-secret'];
        if (token === process.env.ADMIN_SECRET) return next();
        res.redirect('/admin/login');
    }

    // ── Login page ──────────────────────────────────────────────
    router.get('/login', (req, res) => {
        res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>FaceBlurr Admin</title>
  <style>
    body { font-family: Arial, sans-serif; background: #f4f6f8; display: grid;
           place-items: center; min-height: 100vh; margin: 0; }
    form { background: #fff; padding: 2rem; border-radius: 10px;
           box-shadow: 0 4px 20px rgba(0,0,0,.1); min-width: 300px; }
    h2 { margin: 0 0 1.5rem; text-align: center; }
    input { width: 100%; padding: .6rem .8rem; margin-bottom: 1rem;
            border: 1px solid #ddd; border-radius: 6px; box-sizing: border-box; }
    button { width: 100%; padding: .7rem; background: #2563eb; color: #fff;
             border: none; border-radius: 6px; cursor: pointer; font-size: 1rem; }
    button:hover { background: #1d4ed8; }
    .err { color: red; font-size: .875rem; margin-bottom: .5rem; }
  </style>
</head>
<body>
  <form method="POST" action="/admin/login">
    <h2>Admin Login</h2>
    ${req.query.error ? '<p class="err">Invalid secret — try again.</p>' : ''}
    <input type="password" name="secret" placeholder="Admin secret" required autofocus>
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`);
    });

    router.post('/login', express.urlencoded({ extended: false }), (req, res) => {
        if (req.body.secret === process.env.ADMIN_SECRET) {
            res.setHeader('Set-Cookie',
                `admin_token=${process.env.ADMIN_SECRET}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=86400`
            );
            return res.redirect('/admin');
        }
        res.redirect('/admin/login?error=1');
    });

    router.get('/logout', (req, res) => {
        res.setHeader('Set-Cookie', 'admin_token=; Path=/admin; HttpOnly; Max-Age=0');
        res.redirect('/admin/login');
    });

    // ── Dashboard ────────────────────────────────────────────────
    router.get('/', requireAdmin, async (req, res) => {
        let dbStatus = 'OK';
        try { await pool.query('SELECT 1'); } catch (e) { dbStatus = 'ERROR: ' + e.message; }

        const uptimeSec = Math.floor(process.uptime());
        const days = Math.floor(uptimeSec / 86400);
        const hrs  = Math.floor((uptimeSec % 86400) / 3600);
        const mins = Math.floor((uptimeSec % 3600) / 60);
        const secs = uptimeSec % 60;
        const uptime = `${days}d ${hrs}h ${mins}m ${secs}s`;

        const recentLogs = [...logs.entries].reverse().slice(0, 100);
        const logHtml = recentLogs.map(l => {
            const color = l.type === 'error' ? '#ef4444' : l.type === 'warn' ? '#f59e0b' : '#374151';
            return `<tr>
              <td style="color:#6b7280;white-space:nowrap">${l.timestamp}</td>
              <td style="color:${color};font-weight:600;text-transform:uppercase">${l.type}</td>
              <td style="word-break:break-all">${String(l.message).replace(/</g, '&lt;')}</td>
            </tr>`;
        }).join('');

        res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>FaceBlurr Admin Dashboard</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; background: #f4f6f8; color: #1f2937; }
    header { background: #1e3a5f; color: #fff; padding: 1rem 2rem;
             display: flex; justify-content: space-between; align-items: center; }
    header h1 { margin: 0; font-size: 1.3rem; }
    a.logout { color: #93c5fd; font-size: .875rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(180px,1fr));
            gap: 1rem; padding: 1.5rem 2rem 0; }
    .card { background: #fff; border-radius: 10px; padding: 1.2rem;
            box-shadow: 0 2px 8px rgba(0,0,0,.06); }
    .card h3 { margin: 0 0 .4rem; font-size: .8rem; color: #6b7280; text-transform: uppercase; }
    .card .val { font-size: 1.6rem; font-weight: 700; }
    .logs { margin: 1.5rem 2rem; background: #fff; border-radius: 10px;
            box-shadow: 0 2px 8px rgba(0,0,0,.06); overflow: hidden; }
    .logs h2 { margin: 0; padding: 1rem 1.5rem; border-bottom: 1px solid #e5e7eb; font-size: 1rem; }
    table { width: 100%; border-collapse: collapse; font-size: .8rem; }
    td { padding: .4rem .8rem; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
    tr:hover td { background: #f9fafb; }
  </style>
</head>
<body>
  <header>
    <h1>FaceBlurr Admin Dashboard</h1>
    <a class="logout" href="/admin/logout">Logout</a>
  </header>
  <div class="grid">
    <div class="card"><h3>DB Status</h3><div class="val" style="font-size:1rem">${dbStatus}</div></div>
    <div class="card"><h3>Uptime</h3><div class="val" style="font-size:1rem">${uptime}</div></div>
    <div class="card"><h3>Unique Visitors</h3><div class="val">${analytics.visitors.size}</div></div>
    <div class="card"><h3>Total Requests</h3><div class="val">${analytics.totalRequests}</div></div>
  </div>
  <div class="logs">
    <h2>Recent Logs (last 100)</h2>
    <table>
      <thead><tr>
        <th style="padding:.4rem .8rem;text-align:left">Time</th>
        <th style="padding:.4rem .8rem;text-align:left">Level</th>
        <th style="padding:.4rem .8rem;text-align:left">Message</th>
      </tr></thead>
      <tbody>${logHtml || '<tr><td colspan="3" style="padding:1rem;color:#6b7280">No logs yet.</td></tr>'}</tbody>
    </table>
  </div>
</body>
</html>`);
    });

    return router;
}

module.exports = createAdminRouter;
