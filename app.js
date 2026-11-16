/* Gießela – Oberfläche */
(function () {
  'use strict';
  const { db, status, toDayString, parseDay, addDays, diffDays, getSettings, saveSettings, effectiveInterval, isWinter } = Core;

  // ---------- Zustand ----------
  const state = {
    plants: [],
    settings: null,
    room: null,          // aktiver Raumfilter
    detailId: null,
    editId: null,
    draftPhoto: undefined, // undefined = unverändert, Blob = neu
  };
  const photoUrls = new Map(); // id -> { blob, url }

  const $ = (sel, el = document) => el.querySelector(sel);
  const listEl = $('#list');

  // ---------- Hilfen ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtLong = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtMid = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'long' });
  const fmtShort =new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtDate = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
  const NUM = ['null', 'Eine', 'Zwei', 'Drei', 'Vier', 'Fünf', 'Sechs', 'Sieben', 'Acht', 'Neun', 'Zehn', 'Elf', 'Zwölf'];
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const today = () => toDayString(new Date());

  function relDay(days) {
    if (days < -1) return `seit ${-days} Tagen fällig`;
    if (days === -1) return 'seit gestern fällig';
    if (days === 0) return 'heute';
    if (days === 1) return 'morgen';
    if (days === 2) return 'übermorgen';
    return `in ${days} Tagen`;
  }
  function agoDay(days) {
    if (days === 0) return 'heute';
    if (days === 1) return 'gestern';
    if (days === 2) return 'vorgestern';
    return `vor ${days} Tagen`;
  }
  function photoUrl(p) {
    if (!(p.photo instanceof Blob)) return null;
    const hit = photoUrls.get(p.id);
    if (hit && hit.blob === p.photo) return hit.url;
    if (hit) URL.revokeObjectURL(hit.url);
    const url = URL.createObjectURL(p.photo);
    photoUrls.set(p.id, { blob: p.photo, url });
    return url;
  }
  const leaf = '<svg><use href="#i-leaf"/></svg>';
  const byId = (id) => state.plants.find((p) => p.id === id);

  // ---------- Toast ----------
  let toastTimer;
  function toast(msg, action) {
    const el = $('#toast');
    el.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button type="button">${esc(action.label)}</button>` : '');
    if (action) $('button', el).onclick = () => { el.classList.remove('show'); try { el.hidePopover(); } catch (e) {} action.run(); };
    // Popover liegt in der Top-Layer-Ebene und damit auch über offenen Dialogen.
    try { if (!el.matches(':popover-open')) el.showPopover(); } catch (e) { /* ältere Browser */ }
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => { try { if (!el.classList.contains('show')) el.hidePopover(); } catch (e) {} }, 260);
    }, action ? 5000 : 2600);
  }

  // ---------- Daten ----------
  async function load() {
    state.settings = await getSettings();
    state.plants = await db.all('plants');
  }
  async function savePlant(p) {
    await db.put('plants', p);
    const i = state.plants.findIndex((x) => x.id === p.id);
    if (i >= 0) state.plants[i] = p; else state.plants.push(p);
    afterChange();
  }
  async function removePlant(id) {
    await db.del('plants', id);
    state.plants = state.plants.filter((p) => p.id !== id);
    const hit = photoUrls.get(id);
    if (hit) { URL.revokeObjectURL(hit.url); photoUrls.delete(id); }
    afterChange();
  }
  function afterChange() {
    render();
    if (state.detailId && $('#detail-sheet').open) renderDetail();
    pingWorker();
  }

  async function water(p, dateStr) {
    const before = structuredClone(p);
    const date = dateStr || today();
    const history = Array.from(new Set([date, ...(p.history || [])])).sort().reverse().slice(0, 120);
    const updated = { ...p, history, lastWatered: history[0], snoozedUntil: null };
    await savePlant(updated);
    toast(`${p.name} gegossen`, { label: 'Rückgängig', run: () => savePlant(before) });
  }
  async function snooze(p) {
    const before = structuredClone(p);
    await savePlant({ ...p, snoozedUntil: toDayString(addDays(new Date(), 1)) });
    toast(`Morgen wieder an ${p.name} erinnern`, { label: 'Rückgängig', run: () => savePlant(before) });
  }

  // ---------- Hauptliste ----------
  function render() {
    const s = state.settings;
    const now = new Date();
    const winterOn = s.winterMode && isWinter(now);
    $('#today-label').textContent = winterOn ? `${fmtMid.format(now)} · Winterruhe` : fmtLong.format(now);

    const rooms = [...new Set(state.plants.map((p) => (p.room || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
    if (state.room && !rooms.includes(state.room)) state.room = null;
    $('#room-filter').innerHTML = rooms.length > 1
      ? [`<button class="chip" data-room="" aria-pressed="${!state.room}">Alle</button>`,
        ...rooms.map((r) => `<button class="chip" data-room="${esc(r)}" aria-pressed="${state.room === r}">${esc(r)}</button>`)].join('')
      : '';
    $('#room-list').innerHTML = rooms.map((r) => `<option value="${esc(r)}">`).join('');

    const items = state.plants
      .filter((p) => !state.room || (p.room || '').trim() === state.room)
      .map((p) => ({ p, st: status(p, s, now) }))
      .sort((a, b) => a.st.daysLeft - b.st.daysLeft || a.p.name.localeCompare(b.p.name, 'de'));

    const due = items.filter((x) => x.st.isDue);
    const later = items.filter((x) => !x.st.isDue);

    // Zusammenfassung
    const allDue = state.plants.filter((p) => status(p, s, now).isDue).length;
    const summary = $('#summary');
    if (!state.plants.length) summary.textContent = '';
    else if (allDue) {
      summary.innerHTML = `<em>${allDue <= 12 ? NUM[allDue] : allDue} ${allDue === 1 ? 'Pflanze braucht' : 'Pflanzen brauchen'}</em> heute Wasser.`;
    } else {
      const next = items[0] || state.plants.map((p) => ({ p, st: status(p, s, now) })).sort((a, b) => a.st.daysLeft - b.st.daysLeft)[0];
      summary.innerHTML = `Heute ist nichts zu tun. Als Nächstes ist <em>${esc(next.p.name)}</em> ${relDay(next.st.daysLeft)} dran.`;
    }

    if (!state.plants.length) {
      listEl.innerHTML = `
        <div class="empty">
          <svg><use href="#i-leaf"/></svg>
          <h2>Noch ganz leer hier</h2>
          <p>Lege deine erste Pflanze an und sag uns, wie oft sie Wasser möchte. Den Rest merken wir uns.</p>
          <button class="btn accent" data-action="add"><svg><use href="#i-plus"/></svg>Erste Pflanze anlegen</button>
        </div>`;
      return;
    }

    const row = ({ p, st }) => {
      const url = photoUrl(p);
      const meta = st.isDue
        ? `<b>${relDay(st.daysLeft)}</b>${p.room ? ` · ${esc(p.room)}` : ''}`
        : `<b>${relDay(st.daysLeft)}</b> · alle ${st.interval} Tage`;
      return `
        <li class="plant${st.isDue ? ' is-due' : ''}" data-id="${esc(p.id)}">
          <button class="plant-open" data-action="open" aria-label="${esc(p.name)} öffnen">
            ${url ? `<img class="thumb" src="${url}" alt="">` : `<span class="thumb">${leaf}</span>`}
            <span class="plant-main">
              <span class="plant-name">${esc(p.name)}</span>
              <span class="plant-meta">${meta}</span>
              <span class="level" aria-hidden="true"><i style="width:${Math.round(st.level * 100)}%"></i></span>
            </span>
          </button>
          <button class="water-btn" data-action="water" aria-label="${esc(p.name)} als gegossen markieren"><svg><use href="#i-drop"/></svg></button>
        </li>`;
    };

    let html = '';
    if (due.length) {
      html += `<h2 class="section-label"><span>Heute gießen</span><span>${due.length}</span></h2><ul class="plants due">${due.map(row).join('')}</ul>`;
    }
    if (later.length) {
      html += `<h2 class="section-label"><span>${due.length ? 'Danach' : 'Als Nächstes'}</span></h2><ul class="plants">${later.map(row).join('')}</ul>`;
    }
    listEl.innerHTML = html;
  }

  listEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'add') return openEdit(null);
    const p = byId(btn.closest('[data-id]')?.dataset.id);
    if (!p) return;
    if (action === 'open') openDetail(p.id);
    if (action === 'water') {
      btn.classList.add('done');
      btn.innerHTML = '<svg><use href="#i-check"/></svg>';
      if (navigator.vibrate) navigator.vibrate(12);
      setTimeout(() => water(p), 420);
    }
  });

  $('#room-filter').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.room = chip.dataset.room || null;
    render();
  });

  // ---------- Sheets ----------
  function openSheet(el) {
    if (!el.open) el.showModal();
    el.scrollTop = 0;
  }
  document.querySelectorAll('dialog.sheet').forEach((d) => {
    d.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) return d.close();
      if (e.target === d) {
        const r = d.getBoundingClientRect();
        const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        if (!inside) d.close();
      }
    });
  });

  // ---------- Detail ----------
  function openDetail(id) {
    state.detailId = id;
    renderDetail();
    openSheet($('#detail-sheet'));
  }

  function insight(p, st) {
    const h = (p.history || []).slice(0, 8).map(parseDay);
    if (h.length < 4) return '';
    const gaps = [];
    for (let i = 0; i < h.length - 1; i++) gaps.push(diffDays(h[i + 1], h[i]));
    const avg = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
    if (Math.abs(avg - st.interval) < 2 || avg < 1) return `<p class="history-insight">Du gießt im Schnitt alle ${avg} Tage – passt zum Plan.</p>`;
    // Im Winter ist st.interval bereits verlängert – Grundintervall entsprechend zurückrechnen.
    const base = Math.max(1, Math.round(avg * Number(p.interval) / st.interval));
    return `<p class="history-insight">Du gießt im Schnitt alle ${avg} Tage, geplant sind ${st.interval}.
      <button class="btn small ghost" data-detail="adopt" data-days="${base}" style="margin-top:8px">Rhythmus übernehmen</button></p>`;
  }

  function renderDetail() {
    const p = byId(state.detailId);
    const el = $('#detail-sheet');
    if (!p) { el.close(); return; }
    const s = state.settings;
    const st = status(p, s);
    const url = photoUrl(p);
    const base = Number(p.interval);
    const winterNote = st.interval !== base ? `<small>sonst ${base}</small>` : '<small>&nbsp;</small>';
    const last = diffDays(parseDay(p.lastWatered), new Date());
    const history = (p.history || []).slice(0, 10);

    el.innerHTML = `
      <div class="sheet-head">
        <span></span>
        <button type="button" class="icon-btn" data-close aria-label="Schließen"><svg><use href="#i-close"/></svg></button>
      </div>
      <div class="detail-photo" ${url ? `style="background-image:url('${url}')"` : ''}>${url ? '' : leaf}</div>
      <div class="detail-head">
        <div>
          <h2 id="detail-name">${esc(p.name)}</h2>
          ${p.room ? `<p>${esc(p.room)}</p>` : ''}
        </div>
      </div>
      <dl class="facts">
        <div><dt>Nächstes Mal</dt><dd>${st.daysLeft < 0 ? 'überfällig' : relDay(st.daysLeft)}<small>${st.daysLeft < -1 ? `seit ${-st.daysLeft} Tagen` : st.daysLeft === -1 ? 'seit gestern' : fmtShort.format(st.due)}</small></dd></div>
        <div><dt>Zuletzt</dt><dd>${agoDay(last)}<small>${fmtShort.format(parseDay(p.lastWatered))}</small></dd></div>
        <div><dt>Rhythmus</dt><dd>${st.interval} Tage${winterNote}</dd></div>
      </dl>
      <div class="detail-actions">
        <button class="btn ${st.isDue ? 'accent' : 'primary'} wide" data-detail="water"><svg><use href="#i-drop"/></svg>Heute gegossen</button>
        <button class="btn" data-detail="other"><svg><use href="#i-calendar"/></svg>Anderer Tag</button>
        <button class="btn" data-detail="snooze" ${st.isDue ? '' : 'disabled'}><svg><use href="#i-clock"/></svg>Morgen erinnern</button>
        <div class="other-date" id="other-date">
          <input type="date" id="other-date-input" max="${today()}" value="${toDayString(addDays(new Date(), -1))}" aria-label="Gießdatum">
          <button class="btn primary" data-detail="water-other">Eintragen</button>
        </div>
      </div>
      ${p.notes ? `<p class="notes">${esc(p.notes)}</p>` : ''}
      <section class="history">
        <h3>Gießprotokoll</h3>
        ${insight(p, st)}
        ${history.length
          ? `<ol>${history.map((d, i) => {
              const gap = history[i + 1] ? diffDays(parseDay(history[i + 1]), parseDay(d)) : null;
              return `<li><span>${fmtDate.format(parseDay(d))}</span><span>${gap ? `nach ${gap} ${gap === 1 ? 'Tag' : 'Tagen'}` : ''}</span></li>`;
            }).join('')}</ol>`
          : '<p class="none">Noch keine Einträge.</p>'}
      </section>
      <div class="detail-foot">
        <button class="btn danger small" data-detail="delete">Löschen</button>
        <div class="btn-row">
          <button class="btn small" data-detail="ics"><svg><use href="#i-calendar"/></svg>In Kalender</button>
          <button class="btn small" data-detail="edit">Bearbeiten</button>
        </div>
      </div>`;
  }

  let confirming = false;
  /** Zeigt auf dem Button ein Häkchen, schließt dann das Blatt und trägt das Gießen ein. */
  async function confirmWatered(btn, commit) {
    if (confirming) return;
    confirming = true;
    btn.classList.add('confirmed');
    btn.innerHTML = '<svg><use href="#i-check"/></svg>Gegossen';
    if (navigator.vibrate) navigator.vibrate(15);
    await new Promise((r) => setTimeout(r, 750));
    $('#detail-sheet').close();
    confirming = false;
    await commit();
  }

  $('#detail-sheet').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-detail]');
    if (!btn) return;
    const p = byId(state.detailId);
    if (!p) return;
    switch (btn.dataset.detail) {
      case 'water': await confirmWatered(btn, () => water(p)); break;
      case 'snooze': await snooze(p); break;
      case 'other': $('#other-date').classList.toggle('open'); break;
      case 'water-other': {
        const v = $('#other-date-input').value;
        if (v && v <= today()) await confirmWatered(btn, () => water(p, v));
        break;
      }
      case 'adopt': await savePlant({ ...p, interval: Number(btn.dataset.days) }); toast('Intervall angepasst'); break;
      case 'edit': $('#detail-sheet').close(); openEdit(p.id); break;
      case 'ics': downloadICS([p]); break;
      case 'delete':
        if (confirm(`${p.name} wirklich löschen? Das Gießprotokoll geht dabei verloren.`)) {
          $('#detail-sheet').close();
          await removePlant(p.id);
          toast(`${p.name} gelöscht`);
        }
        break;
    }
  });

  // ---------- Bearbeiten ----------
  const form = $('#edit-form');
  const intervalInput = $('#f-interval');

  function syncPresets() {
    const v = Number(intervalInput.value);
    document.querySelectorAll('#presets button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.days) === v)));
  }
  function setPhotoPreview(blobOrNull) {
    const prev = $('#photo-preview');
    if (prev.dataset.url) URL.revokeObjectURL(prev.dataset.url);
    if (blobOrNull) {
      const url = URL.createObjectURL(blobOrNull);
      prev.dataset.url = url;
      prev.style.backgroundImage = `url('${url}')`;
      $('#photo-pick').classList.add('has-photo');
      $('#photo-hint-text').textContent = 'Foto ändern';
    } else {
      delete prev.dataset.url;
      prev.style.backgroundImage = '';
      $('#photo-pick').classList.remove('has-photo');
      $('#photo-hint-text').textContent = 'Foto hinzufügen';
    }
  }

  function openEdit(id) {
    const p = id ? byId(id) : null;
    state.editId = id;
    state.draftPhoto = undefined;
    form.reset();
    $('#edit-title').textContent = p ? 'Pflanze bearbeiten' : 'Neue Pflanze';
    $('#f-name').value = p?.name || '';
    $('#f-room').value = p?.room || state.room || '';
    intervalInput.value = p?.interval || 7;
    $('#f-last').value = p?.lastWatered || today();
    $('#f-last').max = today();
    $('#f-winter').checked = p ? p.winterRest !== false : true;
    $('#f-notes').value = p?.notes || '';
    setPhotoPreview(p?.photo instanceof Blob ? p.photo : null);
    syncPresets();
    openSheet($('#edit-sheet'));
  }

  form.addEventListener('click', (e) => {
    const step = e.target.closest('[data-step]');
    if (step) {
      intervalInput.value = Math.min(90, Math.max(1, (Number(intervalInput.value) || 7) + Number(step.dataset.step)));
      syncPresets();
    }
    const preset = e.target.closest('[data-days]');
    if (preset) { intervalInput.value = preset.dataset.days; syncPresets(); }
  });
  intervalInput.addEventListener('input', syncPresets);

  $('#photo-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      state.draftPhoto = await resizeImage(file, 1100);
      setPhotoPreview(state.draftPhoto);
    } catch (err) {
      toast('Das Bild konnte nicht geladen werden');
    }
    e.target.value = '';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#f-name').value.trim();
    if (!name) { $('#f-name').focus(); return; }
    const existing = state.editId ? byId(state.editId) : null;
    const last = $('#f-last').value && $('#f-last').value <= today() ? $('#f-last').value : today();
    const interval = Math.min(90, Math.max(1, Math.round(Number(intervalInput.value) || 7)));
    const history = existing?.history ? [...existing.history] : [];
    if (!history.includes(last)) history.push(last);
    history.sort().reverse();

    const plant = {
      id: existing?.id || uid(),
      createdAt: existing?.createdAt || new Date().toISOString(),
      ...existing,
      name,
      room: $('#f-room').value.trim(),
      interval,
      lastWatered: last >= (history[0] || last) ? last : history[0],
      history: existing ? history : [last],
      winterRest: $('#f-winter').checked,
      notes: $('#f-notes').value.trim(),
      photo: state.draftPhoto !== undefined ? state.draftPhoto : (existing?.photo || null),
    };
    // Wenn das Datum bewusst geändert wurde, gilt es als letzter Gießtag.
    if (existing && $('#f-last').value !== existing.lastWatered) plant.lastWatered = last;
    await savePlant(plant);
    $('#edit-sheet').close();
    toast(existing ? 'Gespeichert' : `${name} ist eingezogen`);
    if (existing) openDetail(plant.id);
  });

  async function resizeImage(file, max) {
    const src = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = src;
      });
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      return await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/jpeg', 0.84));
    } finally {
      URL.revokeObjectURL(src);
    }
  }

  // ---------- Kalender (.ics) ----------
  function icsEscape(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => '\\' + c);
  }
  function icsFold(line) {
    // Zeilen > 75 Oktette falten (vereinfachte Zeichenzählung)
    const out = [];
    while (line.length > 70) { out.push(line.slice(0, 70)); line = ' ' + line.slice(70); }
    out.push(line);
    return out.join('\r\n');
  }
  function downloadICS(plants) {
    if (!plants.length) { toast('Noch keine Pflanzen angelegt'); return; }
    const s = state.settings;
    const [hh, mm] = (s.reminderTime || '08:00').split(':');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Giesskalender//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Gießela'];
    for (const p of plants) {
      const st = status(p, s);
      const start = st.daysLeft < 0 ? new Date() : st.due;
      const d = toDayString(start).replace(/-/g, '');
      const endMin = Number(mm) + 15;
      const end = `${String(Number(hh) + Math.floor(endMin / 60)).padStart(2, '0')}${String(endMin % 60).padStart(2, '0')}`;
      lines.push(
        'BEGIN:VEVENT',
        `UID:${p.id}@giesskalender`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${d}T${hh}${mm}00`,
        `DTEND:${d}T${end}00`,
        `RRULE:FREQ=DAILY;INTERVAL=${st.interval}`,
        icsFold(`SUMMARY:${icsEscape(`${p.name} gießen`)}`),
        icsFold(`DESCRIPTION:${icsEscape(`Alle ${st.interval} Tage${p.room ? ` · ${p.room}` : ''}. Wenn sich der Rhythmus ändert, die Datei einfach neu laden.`)}`),
        'TRANSP:TRANSPARENT',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        icsFold(`DESCRIPTION:${icsEscape(`${p.name} gießen`)}`),
        'TRIGGER:PT0M',
        'END:VALARM',
        'END:VEVENT'
      );
    }
    lines.push('END:VCALENDAR');
    const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/calendar;charset=utf-8' });
    const name = plants.length === 1 ? `${plants[0].name.replace(/[^\p{L}\p{N}]+/gu, '-')}-giessen.ics` : 'giessela.ics';
    saveBlob(blob, name);
  }

  function saveBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  // ---------- Sicherung ----------
  const blobToDataURL = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
  const dataURLToBlob = async (u) => (await fetch(u)).blob();

  async function exportBackup() {
    const plants = await Promise.all(state.plants.map(async (p) => ({ ...p, photo: p.photo instanceof Blob ? await blobToDataURL(p.photo) : null })));
    const data = { app: 'giesskalender', version: 1, exportedAt: new Date().toISOString(), settings: { ...state.settings, lastNotified: null }, plants };
    saveBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), `giessela-${today()}.json`);
  }

  async function importBackup(file) {
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'giesskalender' || !Array.isArray(data.plants)) throw new Error('format');
      if (!confirm(`${data.plants.length} Pflanzen aus der Sicherung übernehmen? Pflanzen mit gleicher Kennung werden überschrieben.`)) return;
      for (const raw of data.plants) {
        const p = { ...raw, photo: typeof raw.photo === 'string' && raw.photo.startsWith('data:') ? await dataURLToBlob(raw.photo) : null };
        if (!p.id || !p.name || !p.lastWatered) continue;
        await db.put('plants', p);
      }
      if (data.settings) { state.settings = { ...state.settings, ...data.settings, lastNotified: state.settings.lastNotified }; await saveSettings(state.settings); }
      await load();
      afterChange();
      fillSettings();
      toast('Sicherung geladen');
    } catch (err) {
      toast('Diese Datei ist keine gültige Sicherung');
    }
  }

  // ---------- Benachrichtigungen ----------
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 && !/Android/.test(navigator.userAgent));
  const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let swReg = null;

  async function setupWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      swReg = await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
      await registerPeriodic();
      pingWorker();
    } catch (e) { /* lokal ohne HTTPS o. ä. */ }
  }
  async function registerPeriodic() {
    try {
      if (!swReg || !('periodicSync' in swReg)) return false;
      const perm = await navigator.permissions.query({ name: 'periodic-background-sync' });
      if (perm.state !== 'granted') return false;
      await swReg.periodicSync.register('giess-check', { minInterval: 4 * 60 * 60 * 1000 });
      return true;
    } catch (e) { return false; }
  }
  function pingWorker(force) {
    // Badge sofort setzen; Benachrichtigung nur, wenn die App gerade nicht sichtbar ist.
    if (!swReg) { Core.checkAndNotify(null); return; }
    if (document.visibilityState === 'visible' && !force) { Core.checkAndNotify(null); return; }
    const sw = swReg.active || navigator.serviceWorker.controller;
    if (sw) sw.postMessage({ type: 'check', force: !!force });
  }

  async function notifState() {
    const el = $('#notif-status');
    const btn = $('#notif-btn');
    $('#install-hint').hidden = !(isIOS && !isStandalone);
    btn.disabled = false;
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      el.textContent = isIOS && !isStandalone ? 'Erst zum Home-Bildschirm hinzufügen' : 'Werden von diesem Browser nicht unterstützt';
      btn.hidden = true;
      return;
    }
    btn.hidden = false;
    const perm = Notification.permission;
    if (perm === 'granted') {
      const periodic = swReg && 'periodicSync' in swReg && (await registerPeriodic());
      el.textContent = periodic
        ? 'Aktiv – das Handy prüft auch im Hintergrund.'
        : 'Aktiv, solange die App im Hintergrund geöffnet ist. Das App-Symbol zeigt fällige Pflanzen als Zahl.';
      btn.textContent = 'Testen';
    } else if (perm === 'denied') {
      el.textContent = 'Blockiert – lässt sich in den Systemeinstellungen ändern.';
      btn.textContent = 'Blockiert';
      btn.disabled = true;
    } else {
      el.textContent = 'Noch nicht erlaubt';
      btn.textContent = 'Erlauben';
    }
  }

  $('#notif-btn').addEventListener('click', async () => {
    if (Notification.permission === 'granted') {
      if (!swReg) return;
      const dueCount = await Core.checkAndNotify(swReg, { force: true });
      if (!dueCount) {
        await swReg.showNotification('So sieht eine Erinnerung aus', { body: 'Gerade ist keine Pflanze fällig.', icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: 'giess-test' });
      }
      return;
    }
    const res = await Notification.requestPermission();
    if (res === 'granted') toast('Erinnerungen sind an');
    notifState();
  });

  // ---------- Einstellungen ----------
  function fillSettings() {
    const s = state.settings;
    $('#s-time').value = s.reminderTime;
    $('#s-winter').checked = !!s.winterMode;
    $('#s-factor').value = String(s.winterFactor);
    $('#s-factor').closest('.row').style.display = s.winterMode ? '' : 'none';
  }
  async function updateSetting(patch) {
    state.settings = { ...state.settings, ...patch };
    await saveSettings(state.settings);
    fillSettings();
    afterChange();
  }

  $('#open-settings').addEventListener('click', () => { fillSettings(); notifState(); openSheet($('#settings-sheet')); });
  $('#s-time').addEventListener('change', (e) => e.target.value && updateSetting({ reminderTime: e.target.value, lastNotified: null }));
  $('#s-winter').addEventListener('change', (e) => updateSetting({ winterMode: e.target.checked }));
  $('#s-factor').addEventListener('change', (e) => updateSetting({ winterFactor: Number(e.target.value) }));
  $('#ics-btn').addEventListener('click', () => downloadICS(state.plants));
  $('#export-btn').addEventListener('click', exportBackup);
  $('#import-input').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importBackup(f); e.target.value = ''; });
  $('#add-plant').addEventListener('click', () => openEdit(null));

  // ---------- Start ----------
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') render();
    pingWorker();
  });
  // Mitternacht & Erinnerungszeit abdecken, solange die App offen ist
  setInterval(() => { render(); pingWorker(); }, 10 * 60 * 1000);

  load().then(() => {
    render();
    setupWorker();
  });
})();
