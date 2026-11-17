/*
 * Gemeinsame Logik für App und Service Worker.
 * Klassisches Skript (kein Modul), damit es auch per importScripts()
 * im Service Worker geladen werden kann – iOS Safari mag keine Modul-Worker.
 */
(function (root) {
  'use strict';

  // ---------- Datum ----------
  const DAY = 86400000;

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }
  function parseDay(s) {
    const [y, m, d] = String(s).split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function toDayString(d) {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  }
  function addDays(date, n) {
    const x = new Date(date);
    x.setDate(x.getDate() + n);
    return x;
  }
  /** Ganze Kalendertage von a nach b (b − a). */
  function diffDays(a, b) {
    return Math.round((startOfDay(b) - startOfDay(a)) / DAY);
  }

  // ---------- Gießlogik ----------
  /** Winterruhe: November bis Februar. */
  function isWinter(date) {
    const m = new Date(date).getMonth();
    return m >= 10 || m <= 1;
  }

  function effectiveInterval(plant, settings, date) {
    let i = Number(plant.interval) || 7;
    if (settings && settings.winterMode && plant.winterRest !== false && isWinter(date || new Date())) {
      i = Math.round(i * (Number(settings.winterFactor) || 1.5));
    }
    return Math.max(1, i);
  }

  function nextDue(plant, settings, today) {
    today = today || new Date();
    let due = addDays(parseDay(plant.lastWatered), effectiveInterval(plant, settings, today));
    if (plant.snoozedUntil) {
      const s = parseDay(plant.snoozedUntil);
      if (s > due) due = s;
    }
    return due;
  }

  function status(plant, settings, today) {
    today = today || new Date();
    const interval = effectiveInterval(plant, settings, today);
    const due = nextDue(plant, settings, today);
    const daysLeft = diffDays(today, due);
    const elapsed = diffDays(parseDay(plant.lastWatered), today);
    const level = Math.max(0, Math.min(1, 1 - elapsed / interval));
    return { due, daysLeft, interval, level, isDue: daysLeft <= 0 };
  }

  // ---------- Düngen ----------
  /** Düngerstatus oder null, wenn für die Pflanze keine Düngeerinnerung aktiv ist. */
  function fertStatus(plant, settings, today) {
    if (!plant.fertEnabled || !plant.fertLast) return null;
    today = today || new Date();
    const interval = Math.max(1, Number(plant.fertInterval) || 28);
    let due = addDays(parseDay(plant.fertLast), interval);
    if (plant.fertSnoozed) {
      const s = parseDay(plant.fertSnoozed);
      if (s > due) due = s;
    }
    let paused = false;
    if (settings && settings.fertWinterPause !== false) {
      // Im Winter wird nicht gedüngt: Fälligkeit verschiebt sich auf den 1. März.
      const ref = due > today ? due : today;
      if (isWinter(ref)) {
        const spring = new Date(ref.getMonth() >= 10 ? ref.getFullYear() + 1 : ref.getFullYear(), 2, 1);
        if (spring > due) { due = spring; paused = true; }
      }
    }
    const daysLeft = diffDays(today, due);
    return { due, daysLeft, interval, isDue: daysLeft <= 0, paused };
  }

  // ---------- IndexedDB ----------
  const DB_NAME = 'giess';
  const DB_VERSION = 1;
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('plants')) db.createObjectStore('plants', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function run(storeName, mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const store = t.objectStore(storeName);
      const req = fn(store);
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const db = {
    all: (s) => run(s, 'readonly', (st) => st.getAll()),
    get: (s, key) => run(s, 'readonly', (st) => st.get(key)),
    put: (s, value) => run(s, 'readwrite', (st) => st.put(value)),
    del: (s, key) => run(s, 'readwrite', (st) => st.delete(key)),
    clear: (s) => run(s, 'readwrite', (st) => st.clear()),
  };

  const DEFAULT_SETTINGS = {
    key: 'settings',
    reminderTime: '08:00',
    winterMode: true,
    winterFactor: 1.5,
    fertWinterPause: true,
    lastNotified: null,
  };

  async function getSettings() {
    const s = await db.get('meta', 'settings');
    return Object.assign({}, DEFAULT_SETTINGS, s || {});
  }
  function saveSettings(s) {
    return db.put('meta', Object.assign({}, s, { key: 'settings' }));
  }

  // ---------- Erinnerungen ----------
  function namesList(names) {
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} und ${names[1]}`;
    if (names.length === 3) return `${names[0]}, ${names[1]} und ${names[2]}`;
    return `${names.slice(0, 2).join(', ')} und ${names.length - 2} weitere`;
  }

  /**
   * Prüft fällige Pflanzen, setzt das App-Badge und zeigt höchstens
   * einmal pro Tag (ab der Erinnerungszeit) eine Benachrichtigung.
   */
  async function checkAndNotify(registration, opts) {
    opts = opts || {};
    const settings = await getSettings();
    const plants = await db.all('plants');
    const now = new Date();
    const water = plants.filter((p) => status(p, settings, now).isDue);
    const fert = plants.filter((p) => { const f = fertStatus(p, settings, now); return f && f.isDue; });
    const due = Array.from(new Set([...water, ...fert]));

    const nav = root.navigator;
    try {
      if (nav && 'setAppBadge' in nav) {
        if (due.length) await nav.setAppBadge(due.length);
        else await nav.clearAppBadge();
      }
    } catch (e) { /* Badge nicht erlaubt – egal */ }

    if (!due.length || !registration) return due.length;

    const todayStr = toDayString(now);
    const [h, m] = String(settings.reminderTime || '08:00').split(':').map(Number);
    const reminderMoment = new Date(now);
    reminderMoment.setHours(h || 0, m || 0, 0, 0);

    if (!opts.force && (settings.lastNotified === todayStr || now < reminderMoment)) return due.length;
    if (!root.Notification || root.Notification.permission !== 'granted') return due.length;

    const wn = water.map((p) => p.name);
    const fn = fert.map((p) => p.name);
    let title, body;
    if (wn.length && fn.length) {
      title = 'Heute ist Pflegetag';
      body = `Gießen: ${namesList(wn)}. Düngen: ${namesList(fn)}.`;
    } else if (fn.length) {
      title = fn.length === 1 ? `${fn[0]} braucht Dünger` : `${fn.length} Pflanzen brauchen Dünger`;
      body = fn.length === 1 ? 'Heute ist Düngetag.' : `Heute dran: ${namesList(fn)}.`;
    } else {
      title = wn.length === 1 ? `${wn[0]} hat Durst` : `${wn.length} Pflanzen haben Durst`;
      body = wn.length === 1 ? 'Heute ist Gießtag.' : `Heute dran: ${namesList(wn)}.`;
    }
    await registration.showNotification(
      title,
      {
        body,
        tag: 'giess-due',
        renotify: true,
        icon: 'icons/icon-192.png',
        badge: 'icons/badge-96.png',
        data: { url: './' },
      }
    );
    settings.lastNotified = todayStr;
    await saveSettings(settings);
    return due.length;
  }

  root.Core = {
    DAY, startOfDay, parseDay, toDayString, addDays, diffDays,
    isWinter, effectiveInterval, nextDue, status, fertStatus,
    db, getSettings, saveSettings, DEFAULT_SETTINGS,
    namesList, checkAndNotify,
  };
})(self);
