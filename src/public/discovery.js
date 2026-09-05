/* Discovery admin client — thin, dependency-free renderer.
 * Talks to /api/discovery/* with the owner's JWT (localStorage, same as the
 * dashboard shell). Renders the real runner state; never fabricates progress.
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'lge_owner_access_token';
  var JOBS_URL = '/api/discovery/jobs';
  var SETTINGS_URL = '/api/settings';

  var US_STATES = [
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
    'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
    'VA','WA','WV','WI','WY','DC'
  ];
  var FINAL = { COMPLETED: 1, PARTIAL: 1, FAILED: 1, CANCELED: 1 };

  function token() { return localStorage.getItem(TOKEN_KEY); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function fmtTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  }

  function target(job) {
    return job.industry + ' · ' + job.state + (job.city ? ' · ' + job.city : '');
  }

  /* ---- state select + industry prefill from settings ------------------- */
  function initStateSelect() {
    var sel = document.getElementById('f-state');
    US_STATES.forEach(function (s) {
      var o = el('option', '', s);
      o.value = s;
      sel.appendChild(o);
    });
    sel.value = 'TX';
  }

  async function prefillFromSettings() {
    var t = token();
    if (!t) return;
    try {
      var res = await fetch(SETTINGS_URL, { headers: { authorization: 'Bearer ' + t } });
      if (!res.ok) return;
      var data = await res.json();
      var rows = data.settings || [];
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (row.key === 'target.industries' && Array.isArray(row.value) && row.value.length) {
          document.getElementById('f-industry').value = row.value[0];
        } else if (row.key === 'target.states' && Array.isArray(row.value) && row.value.length) {
          var sel = document.getElementById('f-state');
          if (US_STATES.indexOf(row.value[0]) >= 0) sel.value = row.value[0];
        }
      }
    } catch (e) { /* prefill is best-effort only */ }
  }

  /* ---- start form ------------------------------------------------------- */
  function wireStartForm(refresh) {
    var form = document.getElementById('start-form');
    var msg = document.getElementById('start-msg');
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      msg.textContent = '';
      msg.className = 'msg';
      var body = {
        industry: document.getElementById('f-industry').value.trim(),
        state: document.getElementById('f-state').value,
      };
      var city = document.getElementById('f-city').value.trim();
      if (city) body.city = city;
      var btn = form.querySelector('button');
      btn.disabled = true;
      try {
        var res = await fetch(JOBS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token() },
          body: JSON.stringify(body),
        });
        var data = await res.json().catch(function () { return {}; });
        if (res.status === 202) {
          msg.textContent = 'Job accepted — running in the background.';
          msg.className = 'msg ok';
          refresh();
        } else if (res.status === 401) {
          localStorage.removeItem(TOKEN_KEY);
          window.location.href = '/dashboard/auth/login';
        } else {
          msg.textContent = (data.error && data.error.message) || ('HTTP ' + res.status);
          msg.className = 'msg err';
        }
      } catch (e) {
        msg.textContent = 'Request failed: ' + e.message;
        msg.className = 'msg err';
      } finally {
        btn.disabled = false;
      }
    });
  }

  /* ---- job table --------------------------------------------------------- */
  function renderJobs(jobs, refresh) {
    var tbody = document.querySelector('#jobs-table tbody');
    tbody.innerHTML = '';
    if (!jobs || jobs.length === 0) {
      var tr0 = el('tr');
      var td0 = el('td', 'none', 'No discovery jobs yet — start one above.');
      td0.colSpan = 14;
      tr0.appendChild(td0);
      tbody.appendChild(tr0);
      return;
    }
    jobs.forEach(function (job) {
      var tr = el('tr');
      tr.appendChild(el('td')).appendChild(el('span', 'badge ' + job.status, job.status));
      tr.appendChild(el('td', '', job.provider));
      tr.appendChild(el('td', '', target(job)));
      tr.appendChild(el('td', 'num', String(job.attempts)));
      var p = job.progress || {};
      tr.appendChild(el('td', 'num', String(p.records_fetched || 0)));
      tr.appendChild(el('td', 'num', String(p.ingested || 0)));
      tr.appendChild(el('td', 'num', String(p.duplicates_skipped || 0)));
      tr.appendChild(el('td', 'num', String(p.invalid_skipped || 0)));
      tr.appendChild(el('td', 'num', String(p.errors || 0)));
      tr.appendChild(el('td', '', fmtTime(job.created_at)));
      tr.appendChild(el('td', '', fmtTime(job.started_at)));
      tr.appendChild(el('td', '', fmtTime(job.finished_at)));
      var errTd = el('td');
      if (job.error) {
        errTd.title = job.error;
        errTd.appendChild(el('span', 'err-text', job.error));
      } else {
        errTd.appendChild(el('span', 'muted', '—'));
      }
      tr.appendChild(errTd);

      var actTd = el('td', 'actions');
      if (FINAL[job.status]) {
        var retry = el('button', 'retry', 'Retry');
        retry.type = 'button';
        retry.addEventListener('click', function () { act(JOBS_URL + '/' + job.id + '/retry', retry, refresh); });
        actTd.appendChild(retry);
      }
      if (!FINAL[job.status]) {
        var cancel = el('button', 'cancel', 'Cancel');
        cancel.type = 'button';
        cancel.addEventListener('click', function () { act(JOBS_URL + '/' + job.id + '/cancel', cancel, refresh); });
        actTd.appendChild(cancel);
      }
      var view = el('button', '', 'Detail');
      view.type = 'button';
      view.addEventListener('click', function () { loadDetail(job.id); });
      actTd.appendChild(view);
      tr.appendChild(actTd);
      tbody.appendChild(tr);
    });
  }

  async function act(url, btn, refresh) {
    btn.disabled = true;
    try {
      var res = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + token() } });
      if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        window.location.href = '/dashboard/auth/login';
        return;
      }
      var data = await res.json().catch(function () { return {}; });
      var listMsg = document.getElementById('list-msg');
      if (res.ok) {
        listMsg.textContent = (data && data.message) || 'Done.';
        listMsg.className = 'msg ok';
      } else {
        listMsg.textContent = (data.error && data.error.message) || ('HTTP ' + res.status);
        listMsg.className = 'msg err';
      }
      refresh();
    } finally {
      btn.disabled = false;
    }
  }

  /* ---- detail ------------------------------------------------------------ */
  async function loadDetail(jobId) {
    var res = await fetch(JOBS_URL + '/' + jobId, { headers: { authorization: 'Bearer ' + token() } });
    if (res.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      window.location.href = '/dashboard/auth/login';
      return;
    }
    if (!res.ok) return;
    var data = await res.json();
    var job = data.job;
    var section = document.getElementById('detail');
    section.hidden = false;
    document.getElementById('detail-id').textContent = '(' + jobId.slice(0, 8) + '…)';

    var sum = document.getElementById('detail-summary');
    sum.innerHTML = '';
    function kv(label, value) {
      var d = el('div');
      d.appendChild(el('b', '', label));
      d.appendChild(el('span', '', value));
      sum.appendChild(d);
    }
    kv('Status', job.status);
    kv('Provider', job.provider);
    kv('Target', target(job));
    kv('Attempts', String(job.attempts));
    var p = job.progress || {};
    kv('Progress', 'fetched ' + (p.records_fetched || 0) + ' · ingested ' + (p.ingested || 0) +
      ' · dups ' + (p.duplicates_skipped || 0) + ' · invalid ' + (p.invalid_skipped || 0) +
      ' · errors ' + (p.errors || 0));
    if (job.error) kv('Error', job.error);

    var errs = document.getElementById('detail-errors');
    errs.innerHTML = '';
    if (!data.errors || data.errors.length === 0) {
      errs.appendChild(el('div', 'none', 'No record errors' + (data.errors_total ? '' : '.') + '.'));
    } else {
      data.errors.forEach(function (e) {
        var row = el('div', 'err-row ' + (e.retryable ? 'retryable' : 'fatal'));
        row.appendChild(el('span', 'cat', (e.category || '—') + (e.business_name ? ' · ' + e.business_name : '')));
        row.appendChild(el('span', 'msg', e.message));
        row.appendChild(el('span', 'flag', e.retryable ? 'RETRYABLE' : 'FATAL'));
        errs.appendChild(row);
      });
      if (data.errors_total > data.errors.length) {
        errs.appendChild(el('div', 'muted', 'Showing ' + data.errors.length + ' of ' + data.errors_total + ' error rows.'));
      }
    }

    var biz = data.businesses || {};
    var wrap = document.getElementById('detail-businesses');
    wrap.innerHTML = '';
    wrap.appendChild(el('div', '', 'Estimated businesses ingested: ' + (biz.total != null ? biz.total : '—')));
    if (biz.note) wrap.appendChild(el('div', 'note', biz.note));
    if (biz.by_source && biz.by_source.length) {
      var ul = el('ul');
      biz.by_source.forEach(function (s) {
        ul.appendChild(el('li', '', s.source + ': ' + s.count));
      });
      wrap.appendChild(ul);
    }
    if (biz.window) {
      wrap.appendChild(el('div', 'note', 'window: ' + fmtTime(biz.window.from) + ' → ' + fmtTime(biz.window.to)));
    }
    section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ---- boot ---------------------------------------------------------------- */
  async function load() {
    var t = token();
    if (!t) {
      window.location.href = '/dashboard/auth/login';
      return;
    }
    var listMsg = document.getElementById('list-msg');
    try {
      var res = await fetch(JOBS_URL, { headers: { authorization: 'Bearer ' + t } });
      if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        window.location.href = '/dashboard/auth/login';
        return;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      renderJobs(data.jobs, load);
      listMsg.textContent = '';
    } catch (e) {
      listMsg.textContent = 'Could not load jobs: ' + e.message;
      listMsg.className = 'msg err';
    }
  }

  var logout = document.getElementById('logout');
  if (logout) {
    logout.addEventListener('click', function () {
      localStorage.removeItem(TOKEN_KEY);
      window.location.href = '/dashboard/auth/login';
    });
  }

  initStateSelect();
  prefillFromSettings();
  wireStartForm(load);
  load();
})();
