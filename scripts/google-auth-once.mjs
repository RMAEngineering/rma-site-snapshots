// rma-site-snapshots — scripts/google-auth-once.mjs
// One time, on your laptop: mint the Google OAuth refresh token the weekly traffic report uses in CI for GA4 (Data API)
// and Search Console. Service-account keys are blocked by the Google org policy, so this is the desktop OAuth flow with a
// refresh token — the same mechanism, and the same client JSON, as `npm run gsc-inspect` in RMA-Engineering-Website.
//
//   node scripts/google-auth-once.mjs
//
// 1. Reads the desktop OAuth client JSON from GSC_OAUTH_CLIENT_FILE (default C:\Users\User\Documents\secrets\gsc-oauth-client.json,
//    as gsc-inspect; the file never enters a repo).
// 2. Opens Google sign-in in your browser with scopes analytics.readonly + webmasters.readonly, access_type=offline and
//    prompt=consent (so Google issues a refresh token even if you consented before), catches the redirect on a loopback
//    port, swaps the code for tokens.
// 3. Prints GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN and the `gh secret set`
//    commands, then lists the Search Console properties and the GA4 properties the token can read (copy the numeric GA4
//    property id into GA4_PROPERTY_ID — it is not the G-… measurement id). Nothing is written to disk.
//
// Needs, in the OAuth client's GCP project: Google Analytics Data API (for the report), Google Analytics Admin API (only
// for the property listing here), Search Console API (already on for gsc-inspect). While the OAuth consent screen is in
// "Testing", Google expires refresh tokens after 7 days — publish the app to Production, or rerun this whenever
// traffic.md says "refresh token expired".

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const cfg = JSON.parse(readFileSync(new URL('../traffic.config.json', import.meta.url), 'utf8'));
const CLIENT_FILE = process.env.GSC_OAUTH_CLIENT_FILE ?? 'C:\\Users\\User\\Documents\\secrets\\gsc-oauth-client.json';
const SCOPES = cfg.google?.scopes || ['https://www.googleapis.com/auth/analytics.readonly', 'https://www.googleapis.com/auth/webmasters.readonly'];
const TOKEN_ENDPOINT = cfg.google?.tokenEndpoint || 'https://oauth2.googleapis.com/token';
const REPO = 'RMAEngineering/rma-site-snapshots';
const TIMEOUT_MS = 5 * 60 * 1000;

let raw;
try { raw = JSON.parse(readFileSync(CLIENT_FILE, 'utf8')); }
catch (e) { console.error(`Cannot read the OAuth client JSON at ${CLIENT_FILE} (${e.message}). Set GSC_OAUTH_CLIENT_FILE to the desktop client file gsc-inspect uses.`); process.exitCode = 1; }
const client = raw?.installed ?? raw?.web;
if (raw && !(client?.client_id && client?.client_secret)) { console.error('The client JSON has no installed.client_id / client_secret — download the "Desktop app" OAuth client from GCP → APIs & Services → Credentials.'); process.exitCode = 1; }

if (client?.client_id && client?.client_secret) {
  const state = randomBytes(16).toString('hex');
  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const redirectUri = `http://127.0.0.1:${server.address().port}/`;
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });

  const codePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no sign-in within 5 minutes')), TIMEOUT_MS);
    server.on('request', (req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== '/') { res.writeHead(404).end(); return; }
      const err = u.searchParams.get('error');
      const ok = !err && u.searchParams.get('state') === state && u.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(ok ? '<p style="font:16px system-ui">Signed in. You can close this tab and go back to the terminal.</p>' : `<p style="font:16px system-ui">Sign-in failed: ${err || 'state mismatch'}. Go back to the terminal.</p>`);
      clearTimeout(timer);
      ok ? resolve(u.searchParams.get('code')) : reject(new Error(err || 'state mismatch'));
    });
  });

  console.log('Opening Google sign-in in your browser (read-only Analytics + Search Console). If it does not open, paste this URL:\n');
  console.log(authUrl + '\n');
  try {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', authUrl.replace(/&/g, '^&')]] : process.platform === 'darwin' ? ['open', [authUrl]] : ['xdg-open', [authUrl]];
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* URL is printed above */ }

  try {
    const code = await codePromise;
    const r = await fetch(TOKEN_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: client.client_id, client_secret: client.client_secret, redirect_uri: redirectUri, grant_type: 'authorization_code' }) });
    const tok = await r.json().catch(() => ({}));
    if (!r.ok || !tok.access_token) throw new Error(`token exchange failed: ${tok.error || `HTTP ${r.status}`}${tok.error_description ? ` — ${tok.error_description}` : ''}`);
    if (!tok.refresh_token) throw new Error('Google returned no refresh token. Remove this app at https://myaccount.google.com/permissions and run again.');

    console.log('\n==================== repo secrets for RMAEngineering/rma-site-snapshots ====================\n');
    console.log(`GOOGLE_OAUTH_CLIENT_ID=${client.client_id}`);
    console.log(`GOOGLE_OAUTH_CLIENT_SECRET=${client.client_secret}`);
    console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${tok.refresh_token}`);
    console.log('\nAdd them (each command prompts for the value; paste the line\'s right-hand side):');
    for (const name of ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN', 'GA4_PROPERTY_ID']) console.log(`  gh secret set ${name} -R ${REPO}`);
    console.log(`\nScopes granted: ${tok.scope || SCOPES.join(' ')}`);

    const auth = { headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/json' } };
    console.log('\n---- Search Console properties this token can read ----');
    try {
      const sites = await (await fetch('https://www.googleapis.com/webmasters/v3/sites', auth)).json();
      const list = sites.siteEntry || [];
      if (!list.length) console.log('  (none — the signed-in account has no Search Console properties)');
      for (const s of list) console.log(`  ${s.siteUrl}  (${s.permissionLevel})${s.siteUrl === cfg.gsc?.siteUrl ? '   <- traffic.config.json gsc.siteUrl' : ''}`);
      if (list.length && !list.some(s => s.siteUrl === cfg.gsc?.siteUrl)) console.log(`  WARNING: traffic.config.json gsc.siteUrl is "${cfg.gsc?.siteUrl}", which is not in this list.`);
    } catch (e) { console.log(`  could not list (${e.message})`); }

    console.log('\n---- GA4 properties this token can read (GA4_PROPERTY_ID = the number after "properties/") ----');
    try {
      const r2 = await fetch('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200', auth);
      const j = await r2.json().catch(() => ({}));
      if (!r2.ok) console.log(`  could not list: HTTP ${r2.status} ${j.error?.message || ''}\n  (enable "Google Analytics Admin API" in the GCP project, or read the id in GA4 → Admin → Property settings)`);
      else {
        const props = (j.accountSummaries || []).flatMap(a => (a.propertySummaries || []).map(p => ({ account: a.displayName, id: String(p.property || '').replace('properties/', ''), name: p.displayName })));
        if (!props.length) console.log('  (none)');
        for (const p of props) console.log(`  GA4_PROPERTY_ID=${p.id}   "${p.name}"  (account: ${p.account})`);
      }
    } catch (e) { console.log(`  could not list (${e.message})`); }
    console.log('\nDone. Nothing was saved to disk. If the OAuth app is still in "Testing", this refresh token expires in 7 days.');
  } catch (e) {
    console.error(`\nFailed: ${e.message}`);
    process.exitCode = 1;
  } finally {
    server.close();
  }
}
