(function () {
  var N = 90, BLOCK = 30, DAY_MS = 86400000, CIRC = 326.73;
  var FOCUS = ['Push', 'Pull', 'Legs', 'Full body', 'Cardio', 'Mobility'];
  var KEY = 'w90:v1';
  /* Server persistence. The host app must serve this URL for the signed-in user:
     GET -> 200 + JSON state (404/204 when nothing is saved yet), PUT -> JSON state, 2xx on success.
     Set to null to rely on browser storage only. */
  var API_URL = '/api/challenge';
  var RETRY_MS = 8000;
  var state = { start: '2026-10-26', days: {} };
  var page = 0, selected = 1;
  var ref = null, dirty = false, saveTimer = null, retryTimer = null, writing = false, again = false, firstSnap = true;

  var $ = function (id) { return document.getElementById(id); };
  var CHECK = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6.4l2.3 2.3 4.7-5"/></svg>';

  function pad(n) { return String(n).padStart(2, '0'); }
  function parse(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function dayDate(i) { return addDays(parse(state.start), i - 1); }
  function fmtShort(d) { return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }
  function fmtLong(d) { return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); }
  function todayIdx() {
    var t = new Date();
    var t0 = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    return Math.round((t0 - parse(state.start)) / DAY_MS) + 1;
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function entry(i) { return state.days[i] || null; }
  function isDone(i) { var e = entry(i); return !!(e && e.done); }

  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    return JSON.stringify(v);
  }
  function normalize(d) {
    var out = { start: /^\d{4}-\d{2}-\d{2}$/.test(d && d.start) ? d.start : '2026-10-26', days: {} };
    var src = (d && d.days) || {};
    Object.keys(src).forEach(function (k) {
      var i = parseInt(k, 10);
      if (!(i >= 1 && i <= N)) return;
      var e = src[k] || {};
      var o = {};
      if (e.done) o.done = true;
      if (typeof e.focus === 'string' && FOCUS.indexOf(e.focus) >= 0) o.focus = e.focus;
      if (typeof e.note === 'string' && e.note) o.note = e.note.slice(0, 2000);
      if (Object.keys(o).length) out.days[i] = o;
    });
    return out;
  }
  function hasData(s) { return Object.keys(s.days).length > 0 || s.start !== '2026-10-26'; }

  function stats() {
    var present = 0, best = 0, run = 0, i;
    for (i = 1; i <= N; i++) {
      if (isDone(i)) { present++; run++; if (run > best) best = run; } else { run = 0; }
    }
    var t = Math.min(todayIdx(), N), streak = 0;
    if (t >= 1) {
      i = isDone(t) ? t : t - 1;
      while (i >= 1 && isDone(i)) { streak++; i--; }
    }
    return { present: present, best: best, streak: streak };
  }

  /* ---------- persistence ---------- */
  var localOK = true, remoteState = 'pending', lastSaved = null;
  function showStatus() {
    var t = lastSaved ? ' at ' + lastSaved.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
    var el = $('sync');
    if (remoteState === 'ok') el.textContent = 'Saved to your account' + t;
    else if (!localOK) el.textContent = 'Not saved. This browser is blocking storage and the server is not reachable.';
    else if (remoteState === 'pending') el.textContent = 'Saved on this device. Connecting to your account…';
    else if (remoteState === 'denied') el.textContent = 'Saved on this device only. The server refused the save. Try signing in again.';
    else if (remoteState === 'error') el.textContent = 'Saved on this device. Server not reachable, will retry.';
    else el.textContent = 'Saved on this device only. Not connected to an account.';
  }
  function saveLocal() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); localOK = true; } catch (e) { localOK = false; }
    return localOK;
  }
  function loadLocal() {
    try { var raw = localStorage.getItem(KEY); if (raw) state = normalize(JSON.parse(raw)); } catch (e) {}
  }
  function touch() {
    dirty = true;
    saveLocal();
    showStatus();
    if (!ref) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 350);
  }
  function flush() {
    saveTimer = null;
    saveLocal();
    if (!ref) { showStatus(); return Promise.resolve(); }
    if (writing) { again = true; return Promise.resolve(); }
    writing = true;
    return ref.set(JSON.parse(JSON.stringify(state))).then(function () {
      remoteState = 'ok'; lastSaved = new Date(); dirty = false;
    }).catch(function (e) {
      if (e && e.retry) { remoteState = 'error'; retryLater(); } else remoteState = 'denied';
    }).then(function () {
      writing = false;
      showStatus();
      if (again) { again = false; flush(); }
    });
  }
  function retryLater() {
    if (retryTimer) return;
    retryTimer = setTimeout(function () { retryTimer = null; if (dirty) flush(); }, RETRY_MS);
  }

  /* ---------- render ---------- */
  function renderHero() {
    var s = stats();
    var pct = Math.round(s.present / N * 100);
    $('ringNum').textContent = s.present;
    $('ringBar').style.strokeDashoffset = String(CIRC * (1 - s.present / N));
    $('ringAria').setAttribute('aria-label', s.present + ' of ' + N + ' days complete');
    $('pct').textContent = pct + '% completed';
    $('sPresent').textContent = s.present;
    $('sLeft').textContent = N - s.present;
    $('sStreak').textContent = s.streak;
    $('sBest').textContent = s.best;

    var t = todayIdx();
    if (t < 1) {
      var n = 1 - t;
      $('status').textContent = n === 1 ? 'Starts tomorrow' : 'Starts in ' + n + ' days';
      $('statusSub').textContent = fmtLong(parse(state.start));
    } else if (t <= N) {
      $('status').textContent = 'Day ' + t + ' of ' + N;
      $('statusSub').textContent = isDone(t) ? 'Today is logged. Nice work.' : 'Today is not logged yet.';
    } else {
      $('status').textContent = 'Challenge ended';
      $('statusSub').textContent = s.present + ' of ' + N + ' days completed.';
    }
    $('endsOn').textContent = 'Ends ' + fmtShort(dayDate(N)) + ' ' + dayDate(N).getFullYear();
  }

  function renderTabs() {
    var html = '';
    for (var b = 0; b < 3; b++) {
      var from = b * BLOCK + 1, to = from + BLOCK - 1, c = 0;
      for (var i = from; i <= to; i++) if (isDone(i)) c++;
      html += '<button class="tab" role="tab" type="button" data-page="' + b + '" aria-selected="' + (b === page) + '">' +
        '<small>Days ' + from + '–' + to + '</small><b>' + c + '/' + BLOCK + '</b>' +
        '<i><em style="width:' + (c / BLOCK * 100) + '%"></em></i></button>';
    }
    $('tabs').innerHTML = html;
    var a = page * BLOCK + 1;
    $('range').textContent = fmtShort(dayDate(a)) + ' to ' + fmtShort(dayDate(a + BLOCK - 1));
  }

  function renderGrid() {
    var t = todayIdx(), html = '';
    var from = page * BLOCK + 1;
    for (var i = from; i < from + BLOCK; i++) {
      var e = entry(i), done = !!(e && e.done);
      var cls = 'day';
      if (done) cls += ' done';
      else if (i < t) cls += ' missed';
      if (i === t) cls += ' today';
      if (i === selected) cls += ' sel';
      if (e && e.note) cls += ' note';
      var sub = (e && e.focus) ? e.focus : (i === t ? 'Today' : fmtShort(dayDate(i)));
      var label = 'Day ' + i + ', ' + fmtShort(dayDate(i)) + (done ? ', present' : (i < t ? ', missed' : ''));
      html += '<button type="button" class="' + cls + '" data-day="' + i + '" aria-pressed="' + done + '" aria-label="' + label + '">' +
        '<span class="mark">' + CHECK + '</span><span class="n">' + i + '</span><span class="d">' + sub + '</span></button>';
    }
    $('grid').innerHTML = html;
  }

  function renderDetail(forceNote) {
    var i = selected, e = entry(i), done = !!(e && e.done), t = todayIdx();
    $('dTitle').textContent = 'Day ' + i;
    $('dDate').textContent = fmtLong(dayDate(i));
    var pill = $('dPill');
    if (done) { pill.className = 'pill done'; pill.textContent = 'Present'; }
    else if (i < t) { pill.className = 'pill missed'; pill.textContent = 'Missed'; }
    else if (i === t) { pill.className = 'pill'; pill.textContent = 'Today'; }
    else { pill.className = 'pill'; pill.textContent = 'Upcoming'; }
    var tg = $('dToggle');
    tg.className = 'toggle' + (done ? ' on' : '');
    tg.textContent = done ? 'Present. Tap to undo' : 'Mark present';
    var chips = '';
    FOCUS.forEach(function (f) {
      chips += '<button type="button" class="chip" data-focus="' + f + '" aria-pressed="' + !!(e && e.focus === f) + '">' + f + '</button>';
    });
    $('chips').innerHTML = chips;
    var note = $('note'), v = (e && e.note) || '';
    if (note.value !== v && (forceNote || document.activeElement !== note)) note.value = v;
  }

  function renderAll(forceNote) { renderHero(); renderTabs(); renderGrid(); renderDetail(forceNote); }

  /* ---------- actions ---------- */
  function patchDay(i, patch) {
    var e = Object.assign({}, state.days[i] || {}, patch);
    if (!e.done) delete e.done;
    if (!e.focus) delete e.focus;
    if (!e.note) delete e.note;
    if (Object.keys(e).length) state.days[i] = e; else delete state.days[i];
    touch();
  }

  $('grid').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-day]');
    if (!b) return;
    var i = parseInt(b.getAttribute('data-day'), 10);
    selected = i;
    patchDay(i, { done: !isDone(i) });
    renderAll(true);
  });
  $('tabs').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-page]');
    if (!b) return;
    page = parseInt(b.getAttribute('data-page'), 10);
    if (Math.floor((selected - 1) / BLOCK) !== page) selected = page * BLOCK + 1;
    renderAll(true);
  });
  $('dToggle').addEventListener('click', function () {
    patchDay(selected, { done: !isDone(selected) });
    renderAll(false);
  });
  $('chips').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-focus]');
    if (!b) return;
    var f = b.getAttribute('data-focus'), e = entry(selected);
    patchDay(selected, { focus: (e && e.focus === f) ? '' : f });
    renderGrid(); renderDetail(false);
  });
  $('note').addEventListener('input', function () {
    patchDay(selected, { note: $('note').value });
    renderGrid();
  });
  $('startDate').addEventListener('change', function () {
    var v = $('startDate').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
    state.start = v;
    touch();
    var t = clamp(todayIdx(), 1, N);
    page = Math.floor((t - 1) / BLOCK);
    selected = t;
    renderAll(true);
  });

  var armTimer = null;
  $('reset').addEventListener('click', function () {
    var b = $('reset');
    if (!b.classList.contains('armed')) {
      b.classList.add('armed');
      b.textContent = 'Tap again to erase all 90 days';
      armTimer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    state = { start: state.start, days: {} };
    touch();
    renderAll(true);
  });
  function disarm() {
    clearTimeout(armTimer);
    $('reset').classList.remove('armed');
    $('reset').textContent = 'Reset challenge';
  }

  /* ---------- boot ---------- */
  loadLocal();
  $('startDate').value = state.start;
  (function () {
    var t = clamp(todayIdx(), 1, N);
    selected = t;
    page = Math.floor((t - 1) / BLOCK);
  })();
  renderAll(true);

  $('saveBtn').addEventListener('click', function () {
    var b = $('saveBtn');
    clearTimeout(saveTimer);
    b.textContent = 'Saving…';
    flush().then(function () {
      b.textContent = remoteState === 'ok' ? 'Saved' : localOK ? 'Saved on device' : 'Could not save';
      setTimeout(function () { b.textContent = 'Save progress'; }, 2200);
    });
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden' && dirty) { clearTimeout(saveTimer); flush(); }
  });

  /* Reconcile with what the server holds. On first contact local edits win, afterwards the server copy wins. */
  function applyRemote(exists, data) {
    var first = firstSnap;
    firstSnap = false;
    if (exists) {
      var remote = normalize(data);
      if (canon(remote) === canon(state)) { remoteState = 'ok'; dirty = false; showStatus(); return; }
      if (first && dirty) { flush(); return; }
      state = remote;
      dirty = false;
      saveLocal();
      $('startDate').value = state.start;
      renderAll(false);
      remoteState = 'ok'; showStatus();
    } else if (hasData(state)) {
      flush();
    } else {
      remoteState = 'ok'; showStatus();
    }
  }

  function httpError(r) {
    var e = new Error('HTTP ' + r.status);
    e.retry = r.status >= 500 || r.status === 408 || r.status === 429;
    return e;
  }
  function netError(e) { e.retry = true; throw e; }

  /* Host-app REST backend. `ref` is only set once the initial load succeeds, so an
     unreachable server can never be overwritten with stale or empty local data. */
  function connectRest() {
    fetch(API_URL, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .catch(netError)
      .then(function (r) {
        if (r.status === 404 || r.status === 204) return null;
        if (!r.ok) throw httpError(r);
        return r.json();
      })
      .then(function (data) {
        ref = {
          set: function (d) {
            var body = JSON.stringify(d);
            return fetch(API_URL, {
              method: 'PUT',
              credentials: 'same-origin',
              keepalive: body.length < 60000,
              headers: { 'Content-Type': 'application/json' },
              body: body
            }).catch(netError).then(function (r) { if (!r.ok) throw httpError(r); });
          }
        };
        applyRemote(!!data, data);
      })
      .catch(function (e) {
        if (e && e.retry) { remoteState = 'error'; setTimeout(connectRest, RETRY_MS); } else remoteState = 'denied';
        showStatus();
      });
  }

  /* Claude artifact backend, used when the page is opened as an artifact. */
  function connectClaude() {
    Promise.all([window.claude.use('db'), window.claude.use('user')]).then(function (r) {
      var db = r[0], user = r[1];
      if (!db || !user) { remoteState = 'off'; showStatus(); return null; }
      return user.id().then(function (id) {
        if (!id) { remoteState = 'off'; showStatus(); return null; }
        ref = db.doc('data/users/' + id + '/challenge');
        ref.onSnapshot(function (snap) {
          if (snap.metadata.hasPendingWrites || saveTimer || writing) return;
          applyRemote(snap.exists, snap.exists ? snap.data() : null);
        }, function () { ref = null; remoteState = 'denied'; showStatus(); });
      });
    }).catch(function () { remoteState = 'off'; showStatus(); });
  }

  function connect() {
    if (window.claude && window.claude.use) connectClaude();
    else if (API_URL && location.protocol !== 'file:' && window.fetch) connectRest();
    else { remoteState = 'off'; showStatus(); }
  }
  window.addEventListener('online', function () { if (dirty && ref) flush(); });
  connect();
})();
