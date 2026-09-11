/* Local Growth Engine — operating console client.
 * Dependency-free SPA: router + six views (Overview / Leads / Discovery /
 * Exceptions / Settings / Integrations) over the authenticated APIs.
 * Every number and row comes from a real endpoint; absent data renders as
 * null/"—", never a guess. 401 anywhere → back to the login page.
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'lge_owner_access_token';
  var BASE = '/console';
  var LOGIN_URL = '/dashboard/auth/login';

  var OVERVIEW_URL = '/api/dashboard/overview';
  var BUSINESSES_URL = '/api/businesses';
  var JOBS_URL = '/api/discovery/jobs';
  var SETTINGS_URL = '/api/settings';
  var INTEGRATIONS_URL = '/api/integrations/status';
  var ME_URL = '/auth/me';

  var US_STATES = [
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
    'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
    'VA','WA','WV','WI','WY','DC'
  ];

  var LEAD_STATES = [
    'DISCOVERED','ENRICHING','ENRICHED','ANALYZING','ANALYZED','QUALIFIED',
    'DEMO_GENERATING','DEMO_READY','OUTREACH_PENDING','CONTACTED','FOLLOWUP_1',
    'FOLLOWUP_2','RESPONDED','NURTURE','INTERESTED','HOT','SALES_HANDOFF','WON',
    'CUSTOMER','LOST','REJECTED','DO_NOT_CONTACT'
  ];

  var REJECTION_REASONS = [
    'INACTIVE_BUSINESS','NO_CONTACT_ROUTE','OUTSIDE_ICP','EXCELLENT_WEBSITE',
    'LOW_OPPORTUNITY','OPT_OUT','DO_NOT_CONTACT_REQUEST','BAD_DATA','DUPLICATE','OTHER'
  ];

  /* ---- helpers ---------------------------------------------------------- */
  function token() { return localStorage.getItem(TOKEN_KEY); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function fmtNum(n) {
    if (n === null || n === undefined || n === '') return '—';
    var v = Number(n);
    return Number.isFinite(v) ? v.toLocaleString() : String(n);
  }

  function href(path) { return BASE + path; }

  function stateBadge(state) {
    var b = el('span', 'badge ' + (state === 'HOT' ? 'hot' : (state === 'INTERESTED' ? 'interested' : 'ok')), state);
    return b;
  }

  function statusBadge(status) {
    var okStates = { COMPLETED: 1, RUNNING: 1, PARTIAL: 1, PENDING: 1 };
    var cls = okStates[status] ? 'ok' : 'off';
    var b = el('span', 'badge ' + cls, status || '—');
    return b;
  }

  /* ---- shared API access -------------------------------------------------- */
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers, { authorization: 'Bearer ' + token() });
    if (opts.body !== undefined && !opts.headers['content-type']) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(path, opts).then(function (res) {
      if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        window.location.href = LOGIN_URL;
        throw new Error('session expired');
      }
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, ok: res.ok, data: data };
      });
    });
  }

  function apiErr(res) {
    if (res && res.data && res.data.error && res.data.error.message) return res.data.error.message;
    return 'HTTP ' + (res ? res.status : 'error');
  }

  function showError(msg) {
    var view = document.getElementById('view');
    var box = el('div', 'error-box', msg);
    view.insertBefore(box, view.firstChild);
  }

  function navTo(path) {
    history.pushState({}, '', href(path));
    render();
  }

  /* ---- router ------------------------------------------------------------- */
  function currentPath() {
    var p = location.pathname;
    return p.indexOf(BASE) === 0 ? p.slice(BASE.length) : p;
  }

  function render() {
    var path = currentPath() || '/';
    var view = document.getElementById('view');
    var m;
    view.innerHTML = '';
    window.scrollTo(0, 0);

    var seg = (path.split('?')[0] || '/').replace(/\/+$/, '') || '/';

    // Sidebar active state.
    var activeView = '/';
    if (seg.indexOf('/leads') === 0 && seg.length > 6) activeView = '/leads';
    else if (seg.indexOf('/leads') === 0) activeView = '/leads';
    else if (seg.indexOf('/discovery') === 0) activeView = '/discovery';
    else if (seg.indexOf('/exceptions') === 0) activeView = '/exceptions';
    else if (seg.indexOf('/settings') === 0) activeView = '/settings';
    else if (seg.indexOf('/integrations') === 0) activeView = '/integrations';
    (document.querySelectorAll('.nav a') || []).forEach(function (a) {
      var on = (a.getAttribute('data-view') === 'overview' && activeView === '/') ||
               (a.getAttribute('data-view') !== 'overview' && activeView.indexOf(a.getAttribute('href')) === 0);
      a.classList.toggle('active', on);
    });

    if (seg === '/' || seg === '/overview') { bootView(view, renderOverview); return; }
    m = seg.match(/^\/leads\/([0-9a-f-]{36})$/i);
    if (m) { bootView(view, function () { return renderLeadDetail(view, m[1]); }); return; }
    if (seg.indexOf('/leads') === 0) { bootView(view, renderLeads); return; }
    if (seg === '/discovery') { bootView(view, renderDiscovery); return; }
    if (seg === '/exceptions') { bootView(view, renderExceptions); return; }
    if (seg === '/settings') { bootView(view, renderSettings); return; }
    if (seg === '/integrations') { bootView(view, renderIntegrations); return; }

    view.appendChild(el('h1', '', 'Not found'));
    view.appendChild(el('p', 'muted', 'Nothing is wired at this path yet.'));
  }

  /** Render a "loading" placeholder, then run the view (which may be async). */
  function bootView(view, fn) {
    view.appendChild(el('p', 'muted', 'Loading…'));
    Promise.resolve().then(function () { return fn(); }).catch(function (e) {
      showError('Could not load this view: ' + e.message);
    });
  }

  /* ---- overview ------------------------------------------------------------ */
  function renderOverview(view) {
    return api(OVERVIEW_URL).then(function (res) {
      if (!res.ok) throw new Error(apiErr(res));
      var o = res.data;

      var head = el('div', 'page-head');
      var left = el('div');
      left.appendChild(el('h1', '', 'Overview'));
      left.appendChild(el('p', 'muted', 'Business state in 30 seconds — as of ' + fmtTime(o.generatedAt)));
      head.appendChild(left);
      head.appendChild(el('span', 'muted', 'revenue / MRR / demo views stay 0 until their data sources are wired'));
      view.appendChild(head);

      // Stat cards — every card nested-navigates to a pre-filtered Leads view.
      var stats = el('section', 'grid cards');
      var cards = [
        ['LEADS FOUND', o.counts.leadsFound, leadsUrl({}), null],
        ['LEADS QUALIFIED', o.counts.leadsQualified, leadsUrl({ lifecycle_state: QUALIFIED_PLUS.join(',') }), null],
        ['DEMOS CREATED', o.counts.demosCreated, leadsUrl({}), null],
        ['EMAILS SENT', o.counts.emailsSent, leadsUrl({}), null],
        ['REPLIES', o.counts.replies, leadsUrl({}), null],
        ['INTERESTED', o.counts.interested, leadsUrl({ lifecycle_state: 'INTERESTED,HOT' }), null],
        ['SALES', o.counts.sales, leadsUrl({ lifecycle_state: 'WON,CUSTOMER' }), null],
        ['REVENUE', o.counts.revenue, leadsUrl({}), o.countsMeta.revenue],
        ['MRR', o.counts.mrr, leadsUrl({}), o.countsMeta.mrr],
        ['DEMO VIEWS', o.counts.demoViews, leadsUrl({}), o.countsMeta.demoViews],
        ['EMAIL BOUNCES', o.counts.emailBounces, leadsUrl({}), null],
        ['UNSUBSCRIBES', o.counts.unsubscribes, leadsUrl({}), null],
        ['SYSTEM ERRORS', o.counts.systemErrors, href('/exceptions'), null],
      ];
      cards.forEach(function (c) {
        var a = el('a', 'stat');
        a.href = c[2];
        a.appendChild(el('div', 'num', fmtNum(c[1])));
        a.appendChild(el('div', 'label', c[0]));
        if (c[3] && c[3].wired === false) {
          a.appendChild(el('div', 'note', 'source not wired'));
          a.title = 'No data source yet — shown honestly as 0. ' + (c[3].source || '');
        }
        stats.appendChild(a);
      });
      view.appendChild(stats);

      // Hot leads — each row navigates to the lead detail.
      var hot = el('section', 'panel');
      hot.appendChild(el('h2', '', 'Hot leads'));
      hot.appendChild(el('p', 'muted', 'The few leads that need you now — click a lead for the full view.'));
      var wrap = el('div', 'hotleads');
      if (!o.hotLeads || o.hotLeads.length === 0) {
        wrap.appendChild(el('div', 'none', 'No hot leads right now.'));
      } else {
        o.hotLeads.forEach(function (l) {
          var a = el('a', 'lead');
          a.href = href('/leads/' + encodeURIComponent(l.businessId));
          var head2 = el('div', 'name', esc(l.businessName));
          head2.appendChild(stateBadge(l.lifecycleState));
          a.appendChild(head2);
          a.appendChild(el('div', 'meta', [l.city, l.state].filter(Boolean).join(', ') +
            (l.websiteUrl ? ' · ' + esc(l.websiteUrl) : '')));
          var attrs = el('div', 'attrs');
          attrs.appendChild(attr('Lead priority', l.leadPriorityScore == null ? '—' : Number(l.leadPriorityScore).toFixed(0)));
          attrs.appendChild(attr('Website quality', l.websiteQualityScore == null ? '—' : String(l.websiteQualityScore)));
          attrs.appendChild(attr('Intent', l.intent || '—'));
          attrs.appendChild(attr('Confidence', l.confidence == null ? '—' : (Number(l.confidence) * 100).toFixed(0) + '%'));
          a.appendChild(attrs);
          if (l.latestReplySnippet) a.appendChild(el('div', 'reply', '“' + esc(l.latestReplySnippet) + '”'));
          a.appendChild(el('div', 'action', esc(l.suggestedAction)));
          wrap.appendChild(a);
        });
      }
      hot.appendChild(wrap);
      view.appendChild(hot);

      // Today's activity.
      var act = el('section', 'panel');
      act.appendChild(el('h2', '', 'Today’s activity'));
      var ul = el('ul', 'activity');
      if (!o.todayActivity || o.todayActivity.length === 0) {
        ul.appendChild(el('li', 'none', 'No activity recorded today.'));
      } else {
        o.todayActivity.forEach(function (a) {
          var li = el('li');
          li.appendChild(el('span', 'when', fmtTime(a.time)));
          li.appendChild(el('span', 'what', esc(a.type + ' — ' + a.entityType + (a.entity ? ' ' + a.entity : ''))));
          ul.appendChild(li);
        });
      }
      act.appendChild(ul);
      view.appendChild(act);

      // Exceptions strip.
      var exc = el('section', 'panel');
      var excHead = el('div', 'page-head');
      excHead.appendChild(el('h2', '', 'Exceptions'));
      var allLink = el('a', 'muted', 'all open exceptions →');
      allLink.href = href('/exceptions');
      excHead.appendChild(allLink);
      exc.appendChild(excHead);
      var excWrap = el('div', 'exceptions');
      if (!o.exceptions || o.exceptions.length === 0) {
        excWrap.appendChild(el('div', 'none', 'No open exceptions.'));
      } else {
        o.exceptions.slice(0, 8).forEach(function (x) { excWrap.appendChild(exceptionRow(x)); });
      }
      exc.appendChild(excWrap);
      view.appendChild(exc);

      // Health strip.
      var hlt = el('section', 'panel');
      hlt.appendChild(el('h2', '', 'System health'));
      hlt.appendChild(renderHealth(o.health));
      view.appendChild(hlt);
      view.appendChild(el('footer', 'foot', 'Local Growth Engine · operating console · revenue/MRR/demoViews are not wired yet and are shown as 0'));
    });
  }

  function exceptionRow(x) {
    var row = el('div', 'exc ' + String(x.priority || 'low').toLowerCase());
    row.appendChild(el('span', 'pri', x.priority));
    row.appendChild(el('span', 'cat', esc(x.category)));
    row.appendChild(el('span', 'msg', esc(x.message)));
    var entity = el('span', 'entity');
    if (x.entityId && String(x.entityType).toLowerCase() === 'business') {
      var a = el('a', '', esc(x.entityType + ' ' + x.entityId.slice(0, 8) + '…'));
      a.href = href('/leads/' + encodeURIComponent(x.entityId));
      entity.appendChild(a);
    } else {
      entity.textContent = (x.entityType || '—') + (x.entityId ? ' ' + x.entityId : '');
    }
    row.appendChild(entity);
    row.appendChild(el('span', 'when', fmtTime(x.createdAt)));
    return row;
  }

  function renderHealth(h) {
    var row = el('div', 'health-row');
    var server = el('span', 'pill ' + (h.serverUp ? 'ok' : 'bad'), 'server ' + (h.serverUp ? 'up' : 'down'));
    var dbp = el('span', 'pill ' + (h.dbReachable ? 'ok' : 'bad'), 'db ' + (h.dbReachable ? 'reachable' : 'unreachable'));
    row.appendChild(server);
    row.appendChild(dbp);
    var tasksTxt = Object.keys(h.tasksByStatus || {}).map(function (k) { return k + ':' + h.tasksByStatus[k]; }).join(' · ');
    if (tasksTxt) row.appendChild(el('span', 'tasks', 'tasks ' + tasksTxt));
    if (h.lastAuditAt) row.appendChild(el('span', 'tasks', 'last audit ' + fmtTime(h.lastAuditAt)));
    if (h.taskIssues && h.taskIssues.length) row.appendChild(el('span', 'issues', h.taskIssues.join('; ')));
    return row;
  }

  function attr(label, value) {
    var d = el('div', 'attr');
    d.appendChild(el('b', '', label));
    d.appendChild(el('span', '', value));
    return d;
  }

  /** States counted by the overview "qualified or beyond" metric. */
  var QUALIFIED_PLUS = [
    'QUALIFIED','DEMO_GENERATING','DEMO_READY','OUTREACH_PENDING','CONTACTED',
    'FOLLOWUP_1','FOLLOWUP_2','RESPONDED','NURTURE','INTERESTED','HOT',
    'SALES_HANDOFF','WON','CUSTOMER'
  ];

  function leadsUrl(params) {
    var sp = new URLSearchParams(params || {});
    var s = sp.toString();
    return href('/leads' + (s ? '?' + s : ''));
  }

  /* ---- leads list ---------------------------------------------------------- */
  function leadsParams() {
    var sp = new URLSearchParams(location.search);
    var p = {};
    ['page', 'per_page', 'search', 'phone', 'industry', 'city', 'state', 'lifecycle_state', 'sort', 'order'].forEach(function (k) {
      var v = sp.get(k);
      if (v) p[k] = v;
    });
    return p;
  }

  function renderLeads(view) {
    var p = leadsParams();

    var head = el('div', 'page-head');
    head.appendChild(el('h1', '', 'Leads'));
    head.appendChild(el('span', 'muted', 'list from GET /api/businesses — click a row for the full lead view'));
    view.appendChild(head);

    // Filters.
    var filters = el('div', 'filters');
    var search = field('text', 'search', 'Search name', p.search || '');
    var lifecycle = fieldSelect('lifecycle_state', 'Lifecycle', [''].concat(LEAD_STATES), p.lifecycle_state || '');
    var industry = field('text', 'industry', 'Industry', p.industry || '');
    var city = field('text', 'city', 'City', p.city || '');
    var stateSel = fieldSelect('state', 'State', [''].concat(US_STATES), (p.state || '').toUpperCase());
    var sort = fieldSelect('sort', 'Sort', ['created_at', 'business_name', 'rating', 'review_count'], p.sort || 'created_at');
    var order = fieldSelect('order', 'Order', ['desc', 'asc'], p.order || 'desc');
    var go = el('button', 'btn primary', 'Apply');
    go.type = 'button';
    go.addEventListener('click', function () { applyFilters(); });
    [search, lifecycle, industry, city, stateSel, sort, order, go].forEach(function (f) { filters.appendChild(f); });
    view.appendChild(filters);

    function applyFilters() {
      var next = {};
      ['search', 'industry', 'city', 'state'].forEach(function (k) {
        var v = fieldVal(k).trim();
        if (v) next[k] = v;
      });
      var lc = fieldVal('lifecycle_state');
      if (lc) next.lifecycle_state = lc;
      var so = fieldVal('sort') || 'created_at';
      var od = fieldVal('order') || 'desc';
      if (so !== 'created_at') next.sort = so;
      if (od !== 'desc') next.order = od;
      next.per_page = '25';
      navTo('/leads' + ('?' + new URLSearchParams(next).toString()));
    }

    // Apply "enter" in text inputs.
    [search, industry, city].forEach(function (f) {
      var input = f.querySelector('input');
      if (input) input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') applyFilters(); });
    });

    // Fetch.
    var qs = new URLSearchParams(p).toString();
    return api(BUSINESSES_URL + (qs ? '?' + qs : '')).then(function (res) {
      if (!res.ok) {
        showError(apiErr(res));
        return;
      }
      var data = res.data;
      var totalRow = el('p', 'muted', data.total + ' lead' + (data.total === 1 ? '' : 's') +
        (data.totalPages > 1 ? ' · page ' + data.page + ' of ' + data.totalPages : ''));
      view.appendChild(totalRow);

      var table = el('table', 'grid-tbl');
      var thead = el('thead');
      var trh = el('tr');
      ['Business', 'Industry', 'City, State', 'Phone', 'Website', 'Rating', 'Lifecycle', 'Source', 'Created'].forEach(function (c) {
        trh.appendChild(el('th', '', c));
      });
      thead.appendChild(trh);
      table.appendChild(thead);
      var tbody = el('tbody');
      if (!data.businesses || data.businesses.length === 0) {
        tbody.appendChild(el('tr')).appendChild(el('td', 'none', 'No leads match these filters.'));
      } else {
        data.businesses.forEach(function (b) {
          var tr = el('tr', 'clickable');
          tr.addEventListener('click', function () { navTo('/leads/' + encodeURIComponent(b.id)); });
          tr.appendChild(el('td', '', esc(b.businessName)));
          tr.appendChild(el('td', '', esc(b.industry)));
          tr.appendChild(el('td', '', esc([b.city, b.state].filter(Boolean).join(', '))));
          tr.appendChild(el('td', '', esc(b.phone || '')));
          var wd = el('td');
          if (b.websiteUrl) {
            var a = el('a', '', esc(b.websiteUrl));
            a.href = b.websiteUrl; a.target = '_blank'; a.rel = 'noopener';
            wd.appendChild(a);
          }
          tr.appendChild(wd);
          tr.appendChild(el('td', 'num', (b.rating == null ? '—' : fmtNum(b.rating)) +
            (b.reviewCount != null ? ' (' + fmtNum(b.reviewCount) + ')' : '')));
          var td = el('td');
          td.appendChild(stateBadge(b.lifecycleState));
          tr.appendChild(td);
          tr.appendChild(el('td', '', esc(b.source)));
          tr.appendChild(el('td', '', fmtTime(b.createdAt)));
          tbody.appendChild(tr);
        });
      }
      table.appendChild(tbody);
      view.appendChild(table);

      // Pagination.
      if (data.totalPages > 1) {
        var nav = el('div', 'filters');
        var prev = el('button', 'btn', '← Previous');
        prev.disabled = data.page <= 1;
        prev.type = 'button';
        prev.addEventListener('click', function () {
          var next = Object.assign({}, p, { page: String(Math.max(1, data.page - 1)) });
          navTo('/leads?' + new URLSearchParams(next).toString());
        });
        nav.appendChild(prev);
        nav.appendChild(el('span', 'muted', 'Page ' + data.page + ' of ' + data.totalPages));
        var nextB = el('button', 'btn', 'Next →');
        nextB.disabled = data.page >= data.totalPages;
        nextB.type = 'button';
        nextB.addEventListener('click', function () {
          var next = Object.assign({}, p, { page: String(Math.min(data.totalPages, data.page + 1)) });
          navTo('/leads?' + new URLSearchParams(next).toString());
        });
        nav.appendChild(nextB);
        view.appendChild(nav);
      }
    });
  }

  function field(name, type, label, value) {
    var f = el('div', 'field');
    f.appendChild(el('label', '', label));
    var input = el('input', '');
    input.type = type || 'text';
    input.name = name;
    input.id = 'f-' + name;
    input.value = value || '';
    f.appendChild(input);
    return f;
  }

  function fieldVal(name) {
    var n = document.getElementById('f-' + name);
    return n ? n.value : '';
  }

  function fieldSelect(name, label, values, value) {
    var f = el('div', 'field');
    f.appendChild(el('label', '', label));
    var sel = el('select', '');
    sel.id = 'f-' + name;
    sel.name = name;
    values.forEach(function (v) {
      var o = el('option', '', v === '' ? (label === 'Lifecycle' ? 'Any state' : 'Any') : v);
      o.value = v;
      if (v === value) o.selected = true;
      sel.appendChild(o);
    });
    f.appendChild(sel);
    return f;
  }

  /* ---- lead detail ---------------------------------------------------------- */
  function renderLeadDetail(view, id) {
    var back = el('a', 'back', '← Back to leads');
    back.href = href('/leads');
    view.appendChild(back);
    view.appendChild(el('p', 'muted', 'Loading lead…'));

    var detailUrl = BUSINESSES_URL + '/' + encodeURIComponent(id);
    return api(detailUrl).then(function (res) {
      if (!res.ok) { showError(apiErr(res)); return; }
      var b = res.data.business;
      view.innerHTML = '';
      view.appendChild(el('a', 'back', '← Back to leads')).href = href('/leads');

      var head = el('div', 'page-head');
      var left = el('div');
      left.appendChild(el('h1', '', esc(b.businessName)));
      left.appendChild(el('p', 'muted', 'industry · ' + esc(b.industry) + ' · source ' + esc(b.source) +
        (b.sourceUrl ? ' · ' + esc(b.sourceUrl) : '') + ' · created ' + fmtTime(b.createdAt)));
      head.appendChild(left);
      head.appendChild(stateBadge(b.lifecycleState));
      view.appendChild(head);

      // NAP + source.
      var nap = el('section', 'panel');
      nap.appendChild(el('h3', '', 'Business'));
      var kv = el('div', 'kv');
      kvPair(kv, 'NAP', esc([b.address, b.city, b.state, b.zip].filter(Boolean).join(', ')) || '—');
      kvPair(kv, 'Phone', esc(b.phone || '—'));
      kvPair(kv, 'Email', esc(b.email || '—'));
      if (b.websiteUrl) kvPair(kv, 'Website', link(b.websiteUrl, b.websiteUrl));
      else kvPair(kv, 'Website', '— (no website)');
      kvPair(kv, 'Rating', b.rating == null ? '—' : fmtNum(b.rating) + (b.reviewCount != null ? ' from ' + fmtNum(b.reviewCount) + ' reviews' : ''));
      kvPair(kv, 'Business status', esc(b.businessStatus || '—'));
      kvPair(kv, 'Decision maker', esc([b.decisionMakerName, b.decisionMakerRole].filter(Boolean).join(', ')) || '—');
      kvPair(kv, 'Contactability', b.contactabilityScore == null ? '—' : fmtNum(b.contactabilityScore));
      kvPair(kv, 'Updated', fmtTime(b.updatedAt));
      nap.appendChild(kv);
      view.appendChild(nap);

      // Lifecycle + actions.
      var life = el('section', 'panel');
      life.appendChild(el('h3', '', 'Lifecycle'));
      kvPair(life, 'Current state', b.lifecycleState);
      var trans = el('div', 'transitions');
      if (!b.legalTransitions || b.legalTransitions.length === 0) {
        trans.appendChild(el('span', 'muted', 'Terminal state — no further transitions are legal from here.'));
      } else {
        trans.appendChild(el('span', 'muted', 'Legal next states:'));
        b.legalTransitions.forEach(function (target) {
          var btn = el('button', 'btn' + (target === 'REJECTED' || target === 'DO_NOT_CONTACT' ? ' danger' : ''), target);
          btn.type = 'button';
          btn.addEventListener('click', function () { transitionTo(id, target, b, refreshDetail); });
          trans.appendChild(btn);
        });
      }
      life.appendChild(trans);
      var msgZone = el('div', 'msg');
      life.appendChild(msgZone);
      view.appendChild(life);

      // Latest score.
      var score = el('section', 'panel');
      score.appendChild(el('h3', '', 'Latest scores'));
      if (b.latestScore && b.latestScore.leadPriorityScore != null) {
        var grid = el('div', 'score-grid');
        scoreCard(grid, 'Lead priority', b.latestScore.leadPriorityScore);
        scoreCard(grid, 'Website quality', b.latestScore.websiteQualityScore);
        scoreCard(grid, 'Opportunity', b.latestScore.businessOpportunityScore);
        scoreCard(grid, 'Market fit', b.latestScore.marketFitScore);
        score.appendChild(grid);
        score.appendChild(el('p', 'muted', 'Classification: ' + esc(b.latestScore.classification || '—') +
          ' · scored ' + fmtTime(b.latestScore.createdAt)));
      } else {
        score.appendChild(el('div', 'none', 'No score recorded yet.'));
      }
      view.appendChild(score);

      // Website analysis.
      var analysis = el('section', 'panel');
      var anHead = el('div', 'page-head');
      anHead.appendChild(el('h3', '', 'Website analysis'));
      var analyzeBtn = el('button', 'btn primary', b.websiteAnalyses && b.websiteAnalyses.length ? 'Re-analyze website' : 'Analyze website');
      analyzeBtn.type = 'button';
      analyzeBtn.addEventListener('click', function () {
        analyzeBtn.disabled = true;
        analyzeBtn.textContent = 'Analyzing…';
        api(BUSINESSES_URL + '/' + encodeURIComponent(id) + '/analyze-website', { method: 'POST' }).then(function (r) {
          var box = el('div');
          if (r.ok && r.data && r.data.result && !r.data.result.failure) {
            var res2 = r.data.result;
            box.className = 'ok-box';
            box.textContent = 'Analysis complete: website quality ' +
              (res2.websiteQualityScore == null ? '—' : res2.websiteQualityScore) +
              (res2.classification ? ' (' + res2.classification + ')' : '') +
              (res2.fresh ? ' — fresh fetch' : '');
          } else {
            var fail = r.data && r.data.result && r.data.result.failure ? r.data.result.failure : null;
            box.className = 'error-box';
            box.textContent = (fail ? (fail.reason + ': ' + fail.message) : apiErr(r) || 'Analysis failed');
          }
          analysis.appendChild(box);
          refreshDetail();
        }).catch(function (e) {
          analyzeBtn.disabled = false;
          analyzeBtn.textContent = 'Analyze website';
          showError('Analysis request failed: ' + e.message);
        });
      });
      anHead.appendChild(analyzeBtn);
      analysis.appendChild(anHead);
      if (!b.websiteAnalyses || b.websiteAnalyses.length === 0) {
        analysis.appendChild(el('div', 'none', 'Not analyzed yet.'));
      } else {
        var tbl = el('table', 'grid-tbl');
        var trh = el('tr');
        ['URL', 'Status', 'Score', 'Classification', 'Analyzed at'].forEach(function (c) { trh.appendChild(el('th', '', c)); });
        tbl.appendChild(trh);
        var tbo = el('tbody');
        b.websiteAnalyses.forEach(function (a) {
          var tr = el('tr');
          tr.appendChild(el('td', '', esc(a.url)));
          tr.appendChild(el('td', '', esc(a.status || '—')));
          tr.appendChild(el('td', 'num', a.score == null ? '—' : String(a.score)));
          tr.appendChild(el('td', '', esc(a.classification || '—')));
          tr.appendChild(el('td', '', fmtTime(a.analyzedAt)));
          tbo.appendChild(tr);
        });
        tbl.appendChild(tbo);
        analysis.appendChild(tbl);
      }
      view.appendChild(analysis);

      // Demos.
      var demos = el('section', 'panel');
      demos.appendChild(el('h3', '', 'Demos'));
      if (!b.demos || b.demos.length === 0) {
        demos.appendChild(el('div', 'none', 'No demos yet.'));
      } else {
        var dl = el('dl', 'detail-list');
        b.demos.forEach(function (d) {
          var dt = el('dt', '', d.status + (d.version != null ? ' v' + d.version : '') + ' · ' + fmtTime(d.createdAt));
          var dd = el('dd', '', '');
          if (d.demoUrl) {
            var a = el('a', '', 'view demo ↗');
            a.href = d.demoUrl; a.target = '_blank'; a.rel = 'noopener';
            dd.appendChild(a);
          } else dd.textContent = 'no URL yet';
          dl.appendChild(dt);
          dl.appendChild(dd);
        });
        demos.appendChild(dl);
      }
      view.appendChild(demos);

      // Rejections (if any), history, recent audit.
      if (b.rejections && b.rejections.length) {
        var rej = el('section', 'panel');
        rej.appendChild(el('h3', '', 'Rejections'));
        b.rejections.forEach(function (r) {
          var row = el('div', 'err-row');
          row.appendChild(el('span', 'cat', esc(r.reason)));
          row.appendChild(el('span', 'msg', esc(r.detail ? JSON.stringify(r.detail) : '—')));
          row.appendChild(el('span', 'flag', fmtTime(r.createdAt)));
          rej.appendChild(row);
        });
        view.appendChild(rej);
      }

      var hist = el('section', 'panel');
      hist.appendChild(el('h3', '', 'Lifecycle history'));
      if (!b.history || b.history.length === 0) {
        hist.appendChild(el('div', 'none', 'No state changes recorded.'));
      } else {
        var ul2 = el('ul', 'activity');
        b.history.forEach(function (h) {
          var li = el('li');
          li.appendChild(el('span', 'when', fmtTime(h.createdAt)));
          li.appendChild(el('span', 'what', esc((h.fromState || '—') + ' → ' + h.toState + (h.note ? ' · ' + h.note : ''))));
          ul2.appendChild(li);
        });
        hist.appendChild(ul2);
      }
      view.appendChild(hist);

      var audit = el('section', 'panel');
      audit.appendChild(el('h3', '', 'Recent audit'));
      if (!b.recentAudit || b.recentAudit.length === 0) {
        audit.appendChild(el('div', 'none', 'No audit entries.'));
      } else {
        var ul3 = el('ul', 'activity');
        b.recentAudit.forEach(function (a) {
          var li = el('li');
          li.appendChild(el('span', 'when', fmtTime(a.createdAt)));
          li.appendChild(el('span', 'what', esc(a.action + ' · ' + a.actorType)));
          ul3.appendChild(li);
        });
        audit.appendChild(ul3);
      }
      view.appendChild(audit);

      function refreshDetail() {
        renderLeadDetail(view, id);
      }
    });
  }

  function transitionTo(id, target, business, done) {
    var msgZone = document.querySelector('.panel .msg');
    // Remove any previous reason box first.
    var old = document.getElementById('reason-box');
    if (old) old.remove();

    var needsReason = target === 'REJECTED' || target === 'DO_NOT_CONTACT';
    function submit(reason, reasons) {
      var body = { to_state: target };
      if (reason) body.reason = reason;
      if (reasons) body.rejection_reasons = reasons;
      api(BUSINESSES_URL + '/' + encodeURIComponent(id) + '/lifecycle', { method: 'POST', body: body }).then(function (r) {
        if (r.ok) {
          if (msgZone) { msgZone.className = 'msg ok'; msgZone.textContent = target + ' — done.'; }
          done();
        } else {
          if (msgZone) { msgZone.className = 'msg err'; msgZone.textContent = apiErr(r); }
        }
      }).catch(function (e) {
        if (msgZone) { msgZone.className = 'msg err'; msgZone.textContent = 'Transition failed: ' + e.message; }
      });
    }

    if (!needsReason) {
      if (msgZone) { msgZone.className = 'msg'; msgZone.textContent = 'moving to ' + target + '…'; }
      submit(null, null);
      return;
    }

    // Build the rejection/do-not-contact reason box (a human reason is required).
    var box = el('div', 'reason-box');
    box.id = 'reason-box';
    box.appendChild(el('div', '', target === 'DO_NOT_CONTACT' ?
      'Moving to DO_NOT_CONTACT — a reason is required (an opt-out must never be silent).' :
      'Rejecting this lead — a reason is required for the audit trail.'));
    box.appendChild(el('label', '', 'Reason (required)'));
    var ta = el('textarea', '');
    ta.placeholder = 'e.g. owner asked us to stop, duplicate of another listing…';
    box.appendChild(ta);
    box.appendChild(el('label', '', 'Rejection reasons (defaults to OTHER)'));
    var reasonsWrap = el('div', 'reasons');
    REJECTION_REASONS.forEach(function (r) {
      var label = el('label', '');
      var cb = el('input', '');
      cb.type = 'checkbox';
      cb.value = r;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(r));
      reasonsWrap.appendChild(label);
    });
    box.appendChild(reasonsWrap);
    var row = el('div', 'transitions');
    var cancel = el('button', 'btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', function () { box.remove(); });
    var confirm = el('button', 'btn danger', target);
    confirm.type = 'button';
    confirm.addEventListener('click', function () {
      var reason = ta.value.trim();
      var chosen = [];
      reasonsWrap.querySelectorAll('input:checked').forEach(function (cb) { chosen.push(cb.value); });
      if (!reason) { ta.focus(); return; }
      box.remove();
      if (msgZone) { msgZone.className = 'msg'; msgZone.textContent = 'moving to ' + target + '…'; }
      submit(reason, chosen.length ? chosen : ['OTHER']);
    });
    row.appendChild(cancel);
    row.appendChild(confirm);
    box.appendChild(row);
    var panel = msgZone ? msgZone.parentElement : document.getElementById('view');
    panel.appendChild(box);
    ta.focus();
  }

  function kvPair(container, label, value) {
    container.appendChild(el('b', '', label));
    var span = el('span', '', value);
    container.appendChild(span);
  }

  function link(href2, text) {
    var a = el('a', '', esc(text));
    a.href = href2; a.target = '_blank'; a.rel = 'noopener';
    return a;
  }

  function scoreCard(grid, label, value) {
    var c = el('div', 'score');
    c.appendChild(el('span', '', label));
    c.appendChild(el('b', '', value == null ? '—' : String(Number.isFinite(Number(value)) ? Number(value).toFixed(1) : value)));
    var bar = el('div', 'hbar');
    var i = el('i', '');
    var v = Math.max(0, Math.min(100, Number(value) || 0));
    i.style.width = v + '%';
    bar.appendChild(i);
    c.appendChild(bar);
    grid.appendChild(c);
  }

  /* ---- discovery ------------------------------------------------------------- */
  function renderDiscovery(view) {
    var head = el('div', 'page-head');
    head.appendChild(el('h1', '', 'Discovery'));
    head.appendChild(el('span', 'muted', 'jobs admin — creates real discovery jobs & shows their real progress'));
    view.appendChild(head);

    // Start form.
    var form = el('div', 'panel');
    form.appendChild(el('h3', '', 'Start a discovery job'));
    var filters = el('div', 'filters');
    var ind = field('d-industry', 'text', 'Industry', 'plumbing');
    var state = fieldSelect('d-state', 'State', US_STATES, 'TX');
    var city = field('d-city', 'text', 'City (optional)', '');
    var startBtn = el('button', 'btn primary', 'Start job');
    startBtn.type = 'button';
    filters.appendChild(ind);
    filters.appendChild(state);
    filters.appendChild(city);
    filters.appendChild(startBtn);
    form.appendChild(filters);
    var startMsg = el('div', 'msg');
    form.appendChild(startMsg);
    view.appendChild(form);

    startBtn.addEventListener('click', function () {
      var body = {
        industry: document.getElementById('f-d-industry').value.trim() || 'plumbing',
        state: document.getElementById('f-d-state').value,
      };
      var c = document.getElementById('f-d-city').value.trim();
      if (c) body.city = c;
      startBtn.disabled = true;
      api(JOBS_URL, { method: 'POST', body: body }).then(function (r) {
        if (r.ok) {
          startMsg.className = 'msg ok';
          startMsg.textContent = 'Job accepted — running in the background.';
          loadJobs();
        } else {
          startMsg.className = 'msg err';
          startMsg.textContent = apiErr(r);
        }
      }).catch(function (e) {
        startMsg.className = 'msg err';
        startMsg.textContent = 'Could not start job: ' + e.message;
      }).then(function () { startBtn.disabled = false; });
    });

    // Job list.
    var listWrap = el('section', 'panel');
    listWrap.appendChild(el('h3', '', 'Jobs'));
    var listMsg = el('div', 'msg');
    listWrap.appendChild(listMsg);
    var tbody = el('tbody');
    var table = el('table', 'grid-tbl');
    var trh = el('tr');
    ['Status', 'Target', 'Provider', 'Attempts', 'Progress', 'Error', 'Created', 'Actions'].forEach(function (c) {
      trh.appendChild(el('th', '', c));
    });
    table.appendChild(trh);
    table.appendChild(tbody);
    listWrap.appendChild(table);
    var detail = el('div', 'panel');
    detail.id = 'discovery-detail';
    listWrap.appendChild(detail);
    view.appendChild(listWrap);

    var FINAL = { COMPLETED: 1, PARTIAL: 1, FAILED: 1, CANCELED: 1 };

    function target(job) {
      return job.industry + ' · ' + job.state + (job.city ? ' · ' + job.city : '');
    }

    function loadJobs() {
      api(JOBS_URL + '?limit=50').then(function (res) {
        if (!res.ok) { listMsg.className = 'msg err'; listMsg.textContent = apiErr(res); return; }
        tbody.innerHTML = '';
        var jobs = res.data.jobs || [];
        if (jobs.length === 0) {
          var tr = el('tr');
          tr.appendChild(el('td', 'none', 'No discovery jobs yet — start one above.'));
          tbody.appendChild(tr);
          return;
        }
        jobs.forEach(function (job) {
          var tr = el('tr', 'job-row');
          var td0 = el('td');
          td0.appendChild(statusBadge(job.status));
          tr.appendChild(td0);
          tr.appendChild(el('td', '', esc(target(job))));
          tr.appendChild(el('td', '', esc(job.provider)));
          tr.appendChild(el('td', '', String(job.attempts)));
          var p = job.progress || {};
          tr.appendChild(el('td', 'progress-note',
            'fetched ' + (p.records_fetched || 0) + ' · ingested ' + (p.ingested || 0) +
            ' · dups ' + (p.duplicates_skipped || 0) + ' · invalid ' + (p.invalid_skipped || 0) +
            ' · errors ' + (p.errors || 0)));
          tr.appendChild(el('td', '', job.error ? esc(job.error) : ''));
          tr.appendChild(el('td', '', fmtTime(job.created_at)));
          var acts = el('td');
          var buttons = el('div', 'transitions');
          buttons.style.marginTop = '0';
          if (!FINAL[job.status]) {
            var cancel = el('button', 'btn danger', 'Cancel');
            cancel.type = 'button';
            cancel.addEventListener('click', function () { act(JOBS_URL + '/' + job.id + '/cancel', cancel); });
            buttons.appendChild(cancel);
          }
          var viewJob = el('button', 'btn', 'Detail');
          viewJob.type = 'button';
          viewJob.addEventListener('click', function () { loadDetail(job.id); });
          buttons.appendChild(viewJob);
          if (job.status === 'COMPLETED') {
            var leads = el('a', 'btn', 'View leads');
            leads.href = leadsUrl({ industry: job.industry, state: job.state, city: job.city || '' });
            buttons.appendChild(leads);
          }
          acts.appendChild(buttons);
          tr.appendChild(acts);
          tbody.appendChild(tr);
        });
      }).catch(function (e) {
        listMsg.className = 'msg err';
        listMsg.textContent = 'Could not load jobs: ' + e.message;
      });
    }

    function act(url, btn) {
      btn.disabled = true;
      api(url, { method: 'POST' }).then(function (r) {
        listMsg.className = r.ok ? 'msg ok' : 'msg err';
        listMsg.textContent = r.ok ? ((r.data && r.data.message) || 'Done.') : apiErr(r);
        loadJobs();
      }).catch(function () { listMsg.className = 'msg err'; listMsg.textContent = 'Action failed.'; });
    }

    function loadDetail(jobId) {
      api(JOBS_URL + '/' + jobId).then(function (res) {
        if (!res.ok) { listMsg.className = 'msg err'; listMsg.textContent = apiErr(res); return; }
        var data = res.data;
        var job = data.job;
        detail.hidden = false;
        detail.innerHTML = '';
        detail.appendChild(el('h3', '', 'Job detail (' + jobId.slice(0, 8) + '…)'));
        var sum = el('div', 'detail-grid');
        function kv(label, value) {
          sum.appendChild(el('div', '', label + ': ' + esc(value)));
        }
        kv('Status', job.status);
        kv('Provider', job.provider);
        kv('Target', target(job));
        kv('Attempts', String(job.attempts));
        var p = job.progress || {};
        kv('Progress', 'fetched ' + (p.records_fetched || 0) + ' · ingested ' + (p.ingested || 0) +
          ' · dups ' + (p.duplicates_skipped || 0) + ' · invalid ' + (p.invalid_skipped || 0) + ' · errors ' + (p.errors || 0));
        if (job.error) kv('Error', job.error);
        if (job.started_at) kv('Started', fmtTime(job.started_at));
        if (job.finished_at) kv('Finished', fmtTime(job.finished_at));
        detail.appendChild(sum);
        var errs = el('div');
        errs.appendChild(el('h3', '', 'Record errors'));
        if (!data.errors || data.errors.length === 0) {
          errs.appendChild(el('div', 'none', 'No record errors' + (data.errors_total ? '.' : '.') + '.'));
        } else {
          data.errors.forEach(function (e) {
            var row = el('div', 'err-row ' + (e.retryable ? '' : ''));
            row.appendChild(el('span', 'cat', esc((e.category || '—') + (e.business_name ? ' · ' + e.business_name : ''))));
            row.appendChild(el('span', 'msg', esc(e.message)));
            row.appendChild(el('span', 'flag', e.retryable ? 'RETRYABLE' : 'FATAL'));
            errs.appendChild(row);
          });
          if (data.errors_total > data.errors.length) {
            errs.appendChild(el('div', 'muted', 'Showing ' + data.errors.length + ' of ' + data.errors_total + ' error rows.'));
          }
        }
        detail.appendChild(errs);
        var biz = data.businesses || {};
        var bw = el('div');
        bw.appendChild(el('h3', '', 'Ingested estimate'));
        bw.appendChild(el('div', '', 'Estimated businesses ingested: ' + (biz.total != null ? biz.total : '—')));
        if (biz.note) bw.appendChild(el('div', 'note', esc(biz.note)));
        if (biz.by_source && biz.by_source.length) {
          var ul = el('ul');
          biz.by_source.forEach(function (s) { ul.appendChild(el('li', '', s.source + ': ' + s.count)); });
          bw.appendChild(ul);
        }
        if (biz.window) {
          bw.appendChild(el('div', 'muted', 'window: ' + fmtTime(biz.window.from) + ' → ' + fmtTime(biz.window.to)));
        }
        detail.appendChild(bw);
        var viewLeads = el('a', 'btn primary', 'View leads from this job →');
        viewLeads.href = leadsUrl({ industry: job.industry, state: job.state, city: job.city || '' });
        detail.appendChild(viewLeads);
        if (!FINAL[job.status]) {
          var actBtn = el('button', 'btn danger', 'Cancel job');
          actBtn.type = 'button';
          actBtn.addEventListener('click', function () { act(JOBS_URL + '/' + jobId + '/cancel', actBtn); loadDetail(jobId); });
          detail.appendChild(actBtn);
        }
      }).catch(function (e) {
        listMsg.className = 'msg err';
        listMsg.textContent = 'Could not load job: ' + e.message;
      });
    }

    loadJobs();
  }

  /* ---- exceptions ------------------------------------------------------------- */
  function renderExceptions(view) {
    var head = el('div', 'page-head');
    head.appendChild(el('h1', '', 'Exceptions'));
    head.appendChild(el('span', 'muted', 'open CRITICAL / HIGH items, most urgent first'));
    view.appendChild(head);

    return api(OVERVIEW_URL).then(function (res) {
      if (!res.ok) throw new Error(apiErr(res));
      var all = res.data.exceptions || [];
      var serious = all.filter(function (x) { return x.priority === 'CRITICAL' || x.priority === 'HIGH'; });
      var wrap = el('div', 'exceptions');
      if (serious.length === 0) {
        wrap.appendChild(el('div', 'none', 'No open CRITICAL or HIGH exceptions.'));
      } else {
        serious.forEach(function (x) { wrap.appendChild(exceptionRow(x)); });
      }
      view.appendChild(wrap);
      if (all.length > serious.length) {
        view.appendChild(el('p', 'muted', (all.length - serious.length) + ' lower-priority item' +
          (all.length - serious.length === 1 ? '' : 's') + ' shown on Overview.'));
      }
      view.appendChild(el('footer', 'foot', 'Exceptions mirror /api/dashboard/overview — the same source the Overview page reads.'));
    });
  }

  /* ---- settings ---------------------------------------------------------------- */
  function renderSettings(view) {
    var head = el('div', 'page-head');
    head.appendChild(el('h1', '', 'Settings'));
    head.appendChild(el('span', 'muted', 'business rules from /api/settings — every value validates server-side on save'));
    view.appendChild(head);

    return api(SETTINGS_URL).then(function (res) {
      if (!res.ok) throw new Error(apiErr(res));
      var rows = res.data.settings || [];
      if (rows.length === 0) {
        view.appendChild(el('p', 'muted', 'No settings returned.'));
        return;
      }
      // Group by top-level namespace (notifications.*, discovery.*, …).
      var groups = {};
      var order = [];
      rows.forEach(function (s) {
        var g = s.key.indexOf('.') >= 0 ? s.key.split('.')[0] : 'general';
        if (!groups[g]) { groups[g] = []; order.push(g); }
        groups[g].push(s);
      });
      order.forEach(function (g) {
        var group = el('section', 'panel settings-group');
        group.appendChild(el('h3', '', g));
        groups[g].forEach(function (s) { group.appendChild(settingRow(s)); });
        view.appendChild(group);
      });
      view.appendChild(el('footer', 'foot', 'Settings edits write through PUT /api/settings/:key — no values are fabricated.'));
    });
  }

  function settingRow(s) {
    var row = el('div', 'setting-row');
    var left = el('div');
    left.appendChild(el('div', 'key', esc(s.key)));
    left.appendChild(el('div', 'desc', esc(s.description || '')));
    left.appendChild(el('div', 'val', 'type ' + s.type + (s.is_feature_flag ? ' · feature flag' : '') +
      (s.updated_at ? ' · updated ' + fmtTime(s.updated_at) : '')));
    row.appendChild(left);

    var editor = el('div');
    var input;
    var type = s.type || 'string';
    if (type === 'boolean') {
      input = el('input', '');
      input.type = 'checkbox';
      input.checked = !!s.value;
      var lbl = el('label', 'chk');
      lbl.appendChild(input);
      lbl.appendChild(document.createTextNode('enabled'));
      editor.appendChild(lbl);
    } else if (type === 'number') {
      input = el('input', '');
      input.type = 'number';
      input.step = 'any';
      input.value = s.value == null ? '' : String(s.value);
      editor.appendChild(input);
    } else if (type === 'array' || type === 'json') {
      input = el('textarea', '');
      input.value = s.value == null ? '' : JSON.stringify(s.value, null, 2);
      editor.appendChild(input);
    } else {
      input = el('input', '');
      input.type = 'text';
      input.value = s.value == null ? '' : String(s.value);
      editor.appendChild(input);
    }
    row.appendChild(editor);

    var saveCell = el('div');
    var saveBtn = el('button', 'btn primary', 'Save');
    saveBtn.type = 'button';
    var note = el('div', 'save-note');
    saveCell.appendChild(saveBtn);
    saveCell.appendChild(note);
    row.appendChild(saveCell);

    saveBtn.addEventListener('click', function () {
      var value;
      try {
        if (type === 'boolean') value = input.checked;
        else if (type === 'number') {
          value = input.value.trim() === '' ? null : Number(input.value);
          if (value !== null && !Number.isFinite(value)) throw new Error('must be a number');
        } else if (type === 'array' || type === 'json') {
          value = input.value.trim() === '' ? null : JSON.parse(input.value);
        } else value = input.value;
      } catch (e) {
        note.className = 'save-note';
        note.style.color = 'var(--err)';
        note.textContent = 'Invalid value: ' + e.message;
        return;
      }
      saveBtn.disabled = true;
      note.textContent = 'Saving…';
      note.style.color = '';
      api(SETTINGS_URL + '/' + encodeURIComponent(s.key), { method: 'PUT', body: { value: value } }).then(function (r) {
        if (r.ok) {
          note.style.color = 'var(--ok)';
          note.textContent = 'Saved' + (r.data && r.data.setting && r.data.setting.updated_at ? ' · ' + fmtTime(r.data.setting.updated_at) : '') + ' (server-confirmed)';
        } else {
          note.style.color = 'var(--err)';
          note.textContent = apiErr(r);
        }
      }).catch(function (e) {
        note.style.color = 'var(--err)';
        note.textContent = 'Save failed: ' + e.message;
      }).then(function () { saveBtn.disabled = false; });
    });

    return row;
  }

  /* ---- integrations ------------------------------------------------------------- */
  function renderIntegrations(view) {
    var head = el('div', 'page-head');
    head.appendChild(el('h1', '', 'Integrations'));
    head.appendChild(el('span', 'muted', 'honest status — a module is “configured” only when a real provider has credentials'));
    view.appendChild(head);

    return api(INTEGRATIONS_URL).then(function (res) {
      if (!res.ok) throw new Error(apiErr(res));
      var modules = res.data.modules || [];
      if (modules.length === 0) {
        view.appendChild(el('div', 'none', 'No integration modules registered.'));
        return;
      }
      modules.forEach(function (m) {
        var card = el('div', 'int-module');
        card.appendChild(el('div', 'mod', esc(m.module)));
        card.appendChild(el('span', 'badge ' + (m.configured ? 'ok' : 'off'),
          m.configured ? 'configured' : 'requires configuration'));
        var prov = el('div', 'prov', 'provider: ' + esc(m.provider));
        card.appendChild(prov);
        if (m.requiresConfiguration && m.missingEnvVars && m.missingEnvVars.length) {
          card.appendChild(el('div', 'envs', 'env needed: ' + m.missingEnvVars.join(', ')));
        }
        if (!m.configured) {
          card.appendChild(el('div', 'envs', 'not connected — the interface exists but no credentials are wired.'));
        }
        view.appendChild(card);
      });
      view.appendChild(el('footer', 'foot', 'Status from /api/integrations/status as of ' +
        (res.data.generatedAt ? fmtTime(res.data.generatedAt) : 'now') + ' · no fake integrations.'));
    });
  }

  /* ---- boot --------------------------------------------------------------------- */
  function loadMe() {
    return api(ME_URL).then(function (res) {
      var me = document.getElementById('me');
      if (!me) return;
      if (res.ok && res.data) {
        if (res.data.type === 'user') me.textContent = res.data.user.email;
        else me.textContent = 'API key: ' + (res.data.api_key ? res.data.api_key.name : 'unknown');
      }
    }).catch(function () { /* 401 redirects already handled in api() */ });
  }

  function boot() {
    if (!token()) {
      window.location.href = LOGIN_URL;
      return;
    }
    var logout = document.getElementById('logout');
    if (logout) {
      logout.addEventListener('click', function () {
        localStorage.removeItem(TOKEN_KEY);
        window.location.href = LOGIN_URL;
      });
    }
    // Intercept sidebar clicks for SPA navigation (real links for fallback).
    (document.querySelectorAll('.nav a') || []).forEach(function (a) {
      a.addEventListener('click', function (ev) {
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
        ev.preventDefault();
        history.pushState({}, '', a.getAttribute('href'));
        render();
      });
    });
    window.addEventListener('popstate', render);
    loadMe();
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();