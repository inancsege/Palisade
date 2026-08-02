import type { ServerResponse, IncomingMessage } from 'node:http';
import type { EventLogger } from '../logging/events.js';
import type { EventQueryFilters, EventType } from '../types/events.js';
import type { VerdictAction } from '../types/verdict.js';

/**
 * Minimal read-only admin API served by the proxy under the reserved `/_palisade/*`
 * prefix (T5-03). Serves JSON for stats / events / skill trust plus a
 * self-contained HTML page for humans. Enabled via `--dashboard`; these paths
 * are intercepted before anything is proxied upstream.
 */
export class DashboardHandler {
  constructor(private readonly eventLogger: EventLogger) {}

  matches(url: string): boolean {
    return url.startsWith('/_palisade');
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/';
    const path = url.split('?')[0];
    let parsed: URL;
    try {
      parsed = new URL(url, 'http://palisade.local');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'bad_request', message: 'Malformed URL' } }));
      return;
    }

    if (path === '/_palisade' || path === '/_palisade/') {
      this.sendHtml(res, parsed);
      return;
    }

    if (path === '/_palisade/stats') {
      const since = parseSince(parsed.searchParams.get('since'));
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify(this.eventLogger.getStats(since), null, 2));
      return;
    }

    if (path === '/_palisade/events') {
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify(this.eventLogger.queryEvents(parseEventFilters(parsed)), null, 2));
      return;
    }

    if (path === '/_palisade/skills') {
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify(this.eventLogger.skills(), null, 2));
      return;
    }

    res.writeHead(404, JSON_HEADERS);
    res.end(JSON.stringify({ error: { type: 'not_found', message: 'Unknown dashboard route' } }));
  }

  private sendHtml(res: ServerResponse, parsed: URL): void {
    const sinceSeconds = Number(parsed.searchParams.get('since') ?? 3600);
    const seconds = Number.isFinite(sinceSeconds)
      ? Math.min(3600 * 24 * 30, Math.max(60, Math.floor(sinceSeconds)))
      : 3600;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(buildDashboardPage(seconds));
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function parseSince(raw: string | null): Date {
  const seconds = Number(raw ?? 3600);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return new Date(Date.now() - 3600 * 1000);
  }
  return new Date(Date.now() - seconds * 1000);
}

function parseEventFilters(parsed: URL): EventQueryFilters {
  const filters: EventQueryFilters = {};
  const limit = Number(parsed.searchParams.get('limit') ?? 100);
  if (Number.isFinite(limit) && limit >= 0) filters.limit = Math.min(Math.floor(limit), 500);

  const offset = Number(parsed.searchParams.get('offset') ?? 0);
  if (Number.isFinite(offset) && offset >= 0) filters.offset = Math.floor(offset);

  const since = parsed.searchParams.get('since');
  if (since) {
    const parsedSince = new Date(since);
    if (!Number.isNaN(parsedSince.getTime())) filters.since = parsedSince;
  }

  const eventType = parsed.searchParams.get('eventType') as EventType | null;
  if (eventType) filters.eventType = eventType;

  const action = parsed.searchParams.get('action') as VerdictAction | null;
  if (action === 'allow' || action === 'warn' || action === 'block') {
    filters.action = action;
  }
  return filters;
}

function buildDashboardPage(sinceSeconds: number): string {
  return DASHBOARD_HTML.replace('__SINCE_SECONDS__', String(sinceSeconds));
}

const DASHBOARD_HTML = `
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Palisade — Security Dashboard</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 0; padding: 24px 40px; max-width: 1100px; margin-inline: auto; }
  h1 { font-size: 1.5rem; } h1 span { color: #6b7280; font-weight: 400; font-size: 1rem; }
  h2 { font-size: 1.05rem; margin: 24px 0 8px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
  .card { border: 1px solid #d1d5db; border-radius: 10px; padding: 12px 16px; }
  .card .num { font-size: 1.6rem; font-weight: 700; }
  .card .label { color: #6b7280; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
  .block { border-top: 3px solid #dc2626; } .warn { border-top: 3px solid #d97706; }
  .allow { border-top: 3px solid #16a34a; } .total { border-top: 3px solid #2563eb; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e7eb; white-space: nowrap; }
  td.wrap { white-space: normal; max-width: 420px; }
  .tag { padding: 2px 8px; border-radius: 999px; font-size: .75rem; font-weight: 600; }
  .tag.block { background:#fee2e2; color:#991b1b; } .tag.warn { background:#fef3c7; color:#92400e; }
  .tag.allow { background:#dcfce7; color:#166534; }
  .pill { padding:2px 8px; border-radius:999px; font-size:.72rem; display:inline-block; }
  a { color:#2563eb; }
</style>
</head>
<body>
<h1>Palisade <span>Security Dashboard</span></h1>
<section class="cards">
  <div class="card total"><div class="num" id="totalRequests">–</div><div class="label">Requests</div></div>
  <div class="card block"><div class="num" id="blockedCount">–</div><div class="label">Blocked</div></div>
  <div class="card warn"><div class="num" id="warnedCount">–</div><div class="label">Warned</div></div>
  <div class="card allow"><div class="num" id="allowedCount">–</div><div class="label">Allowed</div></div>
</section>
<h2>Top Patterns <a href="/_palisade/stats" style="font-size:.8rem">(raw stats)</a></h2>
<table id="patterns"><thead><tr><th>Pattern</th><th>Hits</th></tr></thead><tbody></tbody></table>
<h2>Skill Trust <a href="/_palisade/skills" style="font-size:.8rem">(raw)</a></h2>
<table id="skills"><thead><tr><th>Skill</th><th>Trust</th><th>Requests</th><th>Blocked</th><th>Warned</th></tr></thead><tbody></tbody></table>
<h2>Recent Events <a href="/_palisade/events?limit=50" style="font-size:.8rem">(raw)</a></h2>
<table id="events"><thead><tr><th>Time</th><th>Action</th><th>Score</th><th>Type</th><th>Skill</th><th>Path</th></tr></thead><tbody></tbody></table>
<script>
const S = __SINCE_SECONDS__;
function esc(v){ return String(v ?? '').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
async function loadStats(){
  const s = await (await fetch('/_palisade/stats?since=' + S)).json();
  document.getElementById('totalRequests').textContent = s.totalRequests;
  document.getElementById('blockedCount').textContent = s.blockedCount;
  document.getElementById('warnedCount').textContent = s.warnedCount;
  document.getElementById('allowedCount').textContent = s.allowedCount;
  document.querySelector('#patterns tbody').innerHTML =
    (s.topPatterns||[]).map(p => '<tr><td>'+esc(p.patternId)+'</td><td>'+p.count+'</td></tr>').join('');
}
async function loadSkills(){
  const list = await (await fetch('/_palisade/skills')).json();
  document.querySelector('#skills tbody').innerHTML = list.map(k =>
    '<tr><td>'+esc(k.skillId)+'</td>' +
    '<td><span class="pill" style="background:'+trustColor(k.trustScore)+'">'+k.trustScore.toFixed(2)+'</span></td>' +
    '<td>'+k.totalRequests+'</td><td>'+k.blockedCount+'</td><td>'+k.warnedCount+'</td></tr>').join('') ||
    '<tr><td colspan="5">No skills tracked yet.</td></tr>';
}
function trustColor(t){ if(t < .4) return '#fecaca'; if(t < .8) return '#fef3c7'; return '#dcfce7'; }
async function loadEvents(){
  const list = await (await fetch('/_palisade/events?limit=50')).json();
  document.querySelector('#events tbody').innerHTML = list.map(e =>
    '<tr>' +
    '<td>'+esc((e.timestamp||'').slice(0,19).replace('T',' '))+'</td>' +
    '<td><span class="tag '+esc(e.action_taken)+'">'+esc(e.action_taken)+'</span></td>' +
    '<td>'+Number(e.threat_score||0).toFixed(2)+'</td>' +
    '<td>'+esc(e.event_type)+'</td>' +
    '<td>'+esc(e.skill_id || '–')+'</td>' +
    '<td class="wrap">'+esc(e.request_path || '')+'</td></tr>').join('') ||
    '<tr><td colspan="6">No events yet.</td></tr>';
}
async function refresh(){ await Promise.all([loadStats(), loadSkills(), loadEvents()]); }
refresh(); setInterval(refresh, 3000);
</script>
</body>
</html>
`;