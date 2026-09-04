/* Owner dashboard shell client — thin, dependency-free renderer.
 * Fetches /api/dashboard/overview with the owner's JWT and renders the
 * 30-second view. No framework; intentionally small.
 */
(function () {
  'use strict';

  var OVERVIEW_URL = '/api/dashboard/overview';
  var TOKEN_KEY = 'lge_owner_access_token';

  function token() { return localStorage.getItem(TOKEN_KEY); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---- stat cards ------------------------------------------------------ */
  function renderStats(counts, meta) {
    var wrap = document.getElementById('stats');
    wrap.innerHTML = '';
    var cards = [
      ['LEADS FOUND', counts.leadsFound],
      ['LEADS QUALIFIED', counts.leadsQualified],
      ['DEMOS CREATED', counts.demosCreated],
      ['EMAILS SENT', counts.emailsSent],
      ['REPLIES', counts.replies],
      ['INTERESTED', counts.interested],
      ['SALES', counts.sales],
      ['REVENUE', counts.revenue, meta.revenue],
      ['MRR', counts.mrr, meta.mrr],
      ['DEMO VIEWS', counts.demoViews, meta.demoViews],
      ['EMAIL BOUNCES', counts.emailBounces],
      ['UNSUBSCRIBES', counts.unsubscribes],
      ['SYSTEM ERRORS', counts.systemErrors],
    ];
    cards.forEach(function (c) {
      var card = el('div', 'stat');
      var num = el('div', 'num', c[1]);
      card.appendChild(num);
      card.appendChild(el('div', 'label', c[0]));
      if (c[2] && c[2].wired === false) {
        card.appendChild(el('div', 'note', 'source not wired'));
        card.setAttribute('title', 'No data source yet — shown honestly as 0. ' + (c[2].source || ''));
      }
      wrap.appendChild(card);
    });
  }

  /* ---- hot leads -------------------------------------------------------- */
  function renderHotLeads(leads) {
    var wrap = document.getElementById('hotleads');
    wrap.innerHTML = '';
    if (!leads || leads.length === 0) {
      wrap.appendChild(el('div', 'none', 'No hot leads right now.'));
      return;
    }
    leads.forEach(function (l) {
      var card = el('div', 'lead');
      var head = el('div', 'name', esc(l.businessName));
      var badge = el('span', 'badge ' + (l.lifecycleState === 'HOT' ? 'hot' : 'interested'), l.lifecycleState);
      head.appendChild(badge);
      card.appendChild(head);
      card.appendChild(el('div', 'meta',
        [l.city, l.state].filter(Boolean).join(', ') + (l.websiteUrl ? ' · ' + esc(l.websiteUrl) : '')));

      var attrs = el('div', 'attrs');
      attrs.appendChild(attr('Lead priority', l.leadPriorityScore == null ? '—' : Number(l.leadPriorityScore).toFixed(0)));
      attrs.appendChild(attr('Website quality', l.websiteQualityScore == null ? '—' : String(l.websiteQualityScore)));
      attrs.appendChild(attr('Intent', l.intent || '—'));
      attrs.appendChild(attr('Confidence', l.confidence == null ? '—' : (Number(l.confidence) * 100).toFixed(0) + '%'));
      card.appendChild(attrs);

      if (l.latestReplySnippet) {
        var reply = el('div', 'reply', '“' + esc(l.latestReplySnippet) + '”');
        card.appendChild(reply);
      }
      card.appendChild(el('div', 'action', esc(l.suggestedAction)));
      if (l.demoUrl) {
        var a = el('a', 'action', 'View demo ↗');
        a.href = l.demoUrl; a.target = '_blank'; a.rel = 'noopener';
        card.appendChild(a);
      }
      wrap.appendChild(card);
    });
  }

  function attr(label, value) {
    var d = el('div', 'attr');
    d.appendChild(el('b', '', label));
    d.appendChild(el('span', '', esc(value)));
    return d;
  }

  /* ---- today's activity -------------------------------------------------- */
  function renderActivity(items) {
    var ul = document.getElementById('activity');
    ul.innerHTML = '';
    if (!items || items.length === 0) {
      ul.appendChild(el('li', 'none', 'No activity recorded today.'));
      return;
    }
    items.forEach(function (a) {
      var li = el('li');
      li.appendChild(el('span', 'when', fmtTime(a.time)));
      var desc = a.type + ' — ' + a.entityType + (a.entity ? ' ' + a.entity : '');
      li.appendChild(el('span', 'what', esc(desc)));
      ul.appendChild(li);
    });
  }

  /* ---- exceptions --------------------------------------------------------- */
  function renderExceptions(excs) {
    var wrap = document.getElementById('exceptions');
    wrap.innerHTML = '';
    if (!excs || excs.length === 0) {
      wrap.appendChild(el('div', 'none', 'No open exceptions.'));
      return;
    }
    excs.forEach(function (x) {
      var row = el('div', 'exc ' + String(x.priority || 'low').toLowerCase());
      row.appendChild(el('span', 'pri', x.priority));
      row.appendChild(el('span', 'cat', esc(x.category)));
      row.appendChild(el('span', 'msg', esc(x.message)));
      row.appendChild(el('span', 'when', fmtTime(x.createdAt)));
      wrap.appendChild(row);
    });
  }

  /* ---- health -------------------------------------------------------------- */
  function renderHealth(h) {
    var row = document.getElementById('health');
    row.innerHTML = '';
    if (!h) return;
    var server = el('span', 'pill ' + (h.serverUp ? 'ok' : 'bad'), 'server ' + (h.serverUp ? 'up' : 'down'));
    var db = el('span', 'pill ' + (h.dbReachable ? 'ok' : 'bad'), 'db ' + (h.dbReachable ? 'reachable' : 'unreachable'));
    row.appendChild(server);
    row.appendChild(db);
    var tasksTxt = Object.keys(h.tasksByStatus || {}).map(function (k) { return k + ':' + h.tasksByStatus[k]; }).join(' · ');
    if (tasksTxt) row.appendChild(el('span', 'tasks', 'tasks ' + tasksTxt));
    if (h.lastAuditAt) row.appendChild(el('span', 'tasks', 'last audit ' + fmtTime(h.lastAuditAt)));
    if (h.taskIssues && h.taskIssues.length) {
      row.appendChild(el('span', 'issues', h.taskIssues.join('; ')));
    }
  }

  /* ---- boot ---------------------------------------------------------------- */
  function showError(msg) {
    var main = document.querySelector('main');
    var p = el('p', 'muted', msg);
    p.style.color = '#b42318';
    main.insertBefore(p, main.firstChild);
  }

  async function load() {
    var t = token();
    if (!t) {
      window.location.href = '/dashboard/auth/login';
      return;
    }
    try {
      var res = await fetch(OVERVIEW_URL, { headers: { authorization: 'Bearer ' + t } });
      if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        window.location.href = '/dashboard/auth/login';
        return;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      var asof = document.getElementById('asof');
      asof.textContent = 'as of ' + fmtTime(data.generatedAt) + ' — ' + data.health.dbReachable
        ? 'data current' : 'database unreachable';
      renderStats(data.counts, data.countsMeta);
      renderHotLeads(data.hotLeads);
      renderActivity(data.todayActivity);
      renderExceptions(data.exceptions);
      renderHealth(data.health);
    } catch (e) {
      showError('Could not load the dashboard: ' + e.message);
    }
  }

  var logout = document.getElementById('logout');
  if (logout) {
    logout.addEventListener('click', function () {
      localStorage.removeItem(TOKEN_KEY);
      window.location.href = '/dashboard/auth/login';
    });
  }

  load();
})();