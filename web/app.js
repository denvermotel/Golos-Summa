/* Golos-Summa - user interface, storage, archive, print and PWA glue.
   Calculation lives in engine.js, texts in i18n.js. */
(function () {
  'use strict';

  const E = window.GolosEngine;
  const I = window.GolosI18n;
  const t = I.t;

  const APP_VERSION = '0.1.0';
  const DATA_FORMAT = 2;
  const KEY_CURRENT = 'golos:current';
  const KEY_ARCHIVE = 'golos:archive';
  const KEY_SETTINGS = 'golos:settings';

  const SKINS = ['classic', 'finestra', 'mela', 'rilievo', 'vetro'];
  const SKIN_ALIASES = { windows: 'finestra', macos: 'mela' };
  const THEMES = ['auto', 'light', 'dark'];
  // Row kinds of the current engine plus those of 0.1.0 development tapes,
  // which are shown read-only.
  const ROW_KINDS = ['add', 'sub', 'total', 'md-in', 'eq-in', 'result', 'pct-in', 'pct-result',
    'pct-addon', 'iva-base', 'iva-add', 'iva-total', 'iva-gross', 'iva-sub', 'iva-net', 'm-add',
    'm-sub', 'm-total', 'gt-total', 't1-add', 't2-add', 't1-sub', 't2-sub', 't1-total', 't2-total',
    'sqrt-in', 'sqrt', 'clear', 'clear-all',
    'input', 'op', 'eq', 'cnt', 'm-recall', 'm-clear', 'pct', 'pct-amount', 'pct-simple'];
  // DSEG7 has no comma, apostrophe or U+2212: the group mark is drawn by CSS
  // (span.seg-tick), as the high tick between digits of the Logos 902 display
  const SEGMENT_SEP = { group: "'", point: '.' };
  const SEGMENT_OPTS = { minus: '-' };
  const OP_SYMBOLS = { '+': '+', '-': '−', '*': '×', '/': '÷',
    '−': '−', '×': '×', '÷': '÷' };

  const DEFAULT_SETTINGS = {
    lang: '',
    skin: 'classic',
    theme: 'auto',
    ivaRates: [4, 5, 10, 22],
    ivaActive: 3,
    decimals: '2',
    rounding: 'half',
    currency: '€',
    currencyPos: 'after',
    advancedMode: false,
    showHints: true,
    displayFont: 'plain'
  };

  let settings = cloneSettings(DEFAULT_SETTINGS);
  let calc = new E.Calculator();
  let tape = null;
  let archive = [];
  let printSelected = new Set();
  let exportSelected = new Set();
  let editingIndex = -1;
  let detailTape = null;
  let storageWarned = false;

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- utils

  function cloneSettings(s) {
    return Object.assign({}, s, { ivaRates: s.ivaRates.slice() });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function newId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function cfg() {
    return { dec: settings.decimals, rnd: settings.rounding };
  }

  function fmt(value, dec) {
    return E.formatNumber(value, dec || settings.decimals, I.sep());
  }

  function fmtMoney(value, dec) {
    const d = dec === 'F' || dec === undefined ? (settings.decimals === 'F' ? 'F' : '2') : dec;
    const n = fmt(value, d === 'A' ? '2' : d);
    return settings.currencyPos === 'before' ? settings.currency + ' ' + n : n + ' ' + settings.currency;
  }

  function fmtDate(iso, withYear) {
    const d = new Date(iso);
    if (isNaN(d)) return '-';
    const opt = { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' };
    if (withYear !== false) opt.year = 'numeric';
    return d.toLocaleString(I.intl(), opt);
  }

  // ---------------------------------------------------------------- storage

  function storeGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function storeSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      if (!storageWarned) {
        storageWarned = true;
        toast(e && e.name === 'QuotaExceededError' ? t('toast.storageFull') : t('toast.storageOff'));
      }
      return false;
    }
  }

  function parseJson(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  // ---------------------------------------------------------------- validation (storage and imports are untrusted)

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : undefined; }

  function sanitizeSettings(raw) {
    const s = cloneSettings(DEFAULT_SETTINGS);
    if (!raw || typeof raw !== 'object') return s;
    if (I.languages().includes(raw.lang)) s.lang = raw.lang;
    const skin = SKIN_ALIASES[raw.skin] || raw.skin;
    if (SKINS.includes(skin)) s.skin = skin;
    if (THEMES.includes(raw.theme)) s.theme = raw.theme;
    if (Array.isArray(raw.ivaRates) && raw.ivaRates.length === 4) {
      s.ivaRates = raw.ivaRates.map((r, i) => (num(r) !== undefined && r >= 0 && r <= 100 ? r : DEFAULT_SETTINGS.ivaRates[i]));
    }
    if ([0, 1, 2, 3].includes(raw.ivaActive)) s.ivaActive = raw.ivaActive;
    // the prototype used 'add' for mode A
    const dec = raw.decimals === 'add' ? 'A' : raw.decimals;
    if (E.DECIMAL_MODES.includes(dec)) s.decimals = dec;
    if (E.ROUNDING_MODES.includes(raw.rounding)) s.rounding = raw.rounding;
    if (typeof raw.currency === 'string') s.currency = raw.currency.slice(0, 3);
    if (raw.currencyPos === 'before' || raw.currencyPos === 'after') s.currencyPos = raw.currencyPos;
    if (typeof raw.advancedMode === 'boolean') s.advancedMode = raw.advancedMode;
    if (typeof raw.showHints === 'boolean') s.showHints = raw.showHints;
    if (raw.displayFont === 'plain' || raw.displayFont === 'segment') s.displayFont = raw.displayFont;
    return s;
  }

  function sanitizeAction(a) {
    if (!a || typeof a !== 'object' || !E.CMDS.includes(a.cmd)) return null;
    const out = {
      cmd: a.cmd,
      operand: num(a.operand) !== undefined && Math.abs(a.operand) < E.LIMIT ? a.operand : null,
      dec: E.DECIMAL_MODES.includes(a.dec) ? a.dec : '2',
      rnd: E.ROUNDING_MODES.includes(a.rnd) ? a.rnd : 'half'
    };
    if (a.cmd === 'mul') {
      if (a.op !== '*' && a.op !== '/') return null;
      out.op = a.op;
    }
    if (a.cmd === 'add' || a.cmd === 't1' || a.cmd === 't2') out.sign = a.sign === -1 ? -1 : 1;
    if (a.cmd === 'taxPlus' || a.cmd === 'taxMinus') {
      if (num(a.rate) === undefined || a.rate < 0 || a.rate > 100) return null;
      out.rate = a.rate;
    }
    return out;
  }

  // Rows of tapes that cannot be replayed (prototype, older engine): read-only.
  function sanitizeLegacyRow(r) {
    if (!r || typeof r !== 'object' || !ROW_KINDS.includes(r.kind)) return null;
    const out = { kind: r.kind };
    if (num(r.value) !== undefined) out.value = r.value;
    if (typeof r.op === 'string' && OP_SYMBOLS[r.op]) out.op = r.op;
    if (num(r.rate) !== undefined) out.rate = r.rate;
    if (Number.isInteger(r.count)) out.count = r.count;
    out.dec = E.DECIMAL_MODES.includes(r.dec) ? r.dec : '2';
    return out;
  }

  function sanitizeTape(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const tp = {
      id: typeof raw.id === 'string' && /^[\w-]{1,64}$/.test(raw.id) ? raw.id : newId('tape'),
      title: typeof raw.title === 'string' ? raw.title.slice(0, 80) : '',
      dateStart: !isNaN(new Date(raw.dateStart)) ? new Date(raw.dateStart).toISOString() : new Date().toISOString(),
      dateEnd: raw.dateEnd && !isNaN(new Date(raw.dateEnd)) ? new Date(raw.dateEnd).toISOString() : null,
      startRegs: E.sanitizeRegisters(raw.startRegs),
      actions: [],
      rows: [],
      legacy: false
    };
    if (Array.isArray(raw.actions) && raw.engine === E.ENGINE) {
      tp.actions = raw.actions.map(sanitizeAction).filter(Boolean);
      tp.rows = E.replay(tp.startRegs, tp.actions).rows;
    } else if (Array.isArray(raw.rows) || Array.isArray(raw.items)) {
      tp.legacy = true;
      tp.rows = (raw.rows || raw.items).map(sanitizeLegacyRow).filter(Boolean);
    } else {
      return null;
    }
    return tp;
  }

  function serializeTape(tp) {
    return {
      id: tp.id, title: tp.title, dateStart: tp.dateStart, dateEnd: tp.dateEnd,
      engine: tp.legacy ? undefined : E.ENGINE,
      startRegs: tp.startRegs, actions: tp.legacy ? undefined : tp.actions, rows: tp.rows
    };
  }

  // ---------------------------------------------------------------- persistence

  function newTape(regs) {
    return {
      id: newId('tape'), title: '', dateStart: new Date().toISOString(), dateEnd: null,
      startRegs: E.sanitizeRegisters(regs), actions: [], rows: [], legacy: false
    };
  }

  function saveCurrent() { storeSet(KEY_CURRENT, serializeTape(tape)); }
  function saveArchive() { storeSet(KEY_ARCHIVE, archive.map(serializeTape)); }
  function saveSettings() { storeSet(KEY_SETTINGS, settings); }

  function load() {
    settings = sanitizeSettings(parseJson(storeGet(KEY_SETTINGS)));
    const arch = parseJson(storeGet(KEY_ARCHIVE));
    archive = Array.isArray(arch) ? arch.map(sanitizeTape).filter(Boolean) : [];
    const cur = sanitizeTape(parseJson(storeGet(KEY_CURRENT)));
    if (cur && cur.legacy) {
      // a prototype tape cannot be continued: archive it read-only
      if (cur.rows.length) archive.unshift(cur);
      tape = newTape();
    } else {
      tape = cur || newTape();
    }
    calc = E.replay(tape.startRegs, tape.actions).calc;
  }

  // ---------------------------------------------------------------- row presentation (tape, detail, print)

  // Tape symbols follow the Logos paper: the symbol of the key goes to the
  // right of the amount (+, -, x, /, =, S subtotal, T total, * result).
  function rowView(r) {
    const n = r.count;
    const sym = OP_SYMBOLS[r.op] || '';
    const v = { op: '', label: '', cls: [] };
    const vat = () => t('row.vat', { rate: fmt(r.rate, 'F') });
    const reg = () => r.kind.slice(0, 2).toUpperCase();
    switch (r.kind) {
      case 'add': v.op = sym; break;
      case 'sub': v.op = 'S'; v.label = t('row.subtotal', { n }); v.cls.push('t-subtotal'); break;
      case 'total': v.op = 'T'; v.label = t('row.total', { n }); v.cls.push('t-total'); break;
      case 'md-in': v.op = sym; break;
      case 'eq-in': v.op = '='; break;
      case 'result': case 'pct-result': case 'sqrt': v.op = '∗'; v.cls.push('t-result'); break;
      case 'pct-in': v.op = '%'; break;
      case 'pct-addon': v.op = sym + '%'; v.label = t(r.op === '-' ? 'row.discount' : 'row.addon'); v.cls.push('t-result'); break;
      case 'iva-base': v.label = t('row.taxable'); v.cls.push('t-iva'); break;
      case 'iva-add': v.op = '+'; v.label = vat(); v.cls.push('t-iva'); break;
      case 'iva-total': v.op = '∗'; v.label = t('row.gross'); v.cls.push('t-total', 't-iva'); break;
      case 'iva-gross': v.label = t('row.gross'); v.cls.push('t-iva'); break;
      case 'iva-sub': v.op = '−'; v.label = vat(); v.cls.push('t-iva'); break;
      case 'iva-net': v.op = '∗'; v.label = t('row.taxable'); v.cls.push('t-total', 't-iva'); break;
      case 'm-add': v.op = 'M' + sym; v.label = t('row.memory'); break;
      case 'm-sub': v.op = 'MS'; v.label = t('row.memSub'); v.cls.push('t-subtotal'); break;
      case 'm-total': v.op = 'MT'; v.label = t('row.memTotal'); v.cls.push('t-total'); break;
      case 'gt-total': v.op = 'GT'; v.label = t('row.gt'); v.cls.push('t-total'); break;
      case 't1-add': case 't2-add': v.op = sym; v.label = reg() + ' [' + n + ']'; break;
      case 't1-sub': case 't2-sub': v.op = 'S'; v.label = t('row.tSub', { t: reg(), n }); v.cls.push('t-subtotal'); break;
      case 't1-total': case 't2-total': v.op = 'T'; v.label = t('row.tTotal', { t: reg(), n }); v.cls.push('t-total'); break;
      case 'sqrt-in': v.op = '√'; break;
      case 'clear': v.op = 'C'; v.cls.push('t-subtotal'); break;
      case 'clear-all': v.op = 'C'; v.label = t('row.clearAll'); v.cls.push('t-subtotal'); break;
      // read-only rows of older tapes
      case 'op': case 'pct-amount': v.op = sym; break;
      case 'eq': v.op = '='; v.cls.push('t-total'); break;
      case 'pct': v.op = '%'; break;
      case 'pct-simple': v.op = '∗'; break;
      case 'cnt': v.op = '#'; break;
      case 'm-recall': v.op = 'M'; break;
      case 'm-clear': v.op = 'MT'; break;
      default: break;
    }
    if (r.value === undefined) v.value = '';
    else if (r.kind === 'cnt') v.value = fmt(r.value, '0');
    else v.value = fmt(r.value, r.dec || '2');
    if (r.value < 0) v.cls.push('t-neg');
    return v;
  }

  // ---------------------------------------------------------------- tape rendering

  function tapeRowElement(r, i) {
    const v = rowView(r);
    const row = el('div', 'tape-row ' + v.cls.join(' '));
    row.setAttribute('role', 'listitem');
    row.dataset.index = i;
    row.append(el('div', 'r-num', String(i + 1)), el('div', 'r-label', v.label),
      el('div', 'r-val', v.value), el('div', 'r-op', v.op));
    if (r.edit && !tape.legacy) {
      row.classList.add('editable');
      row.tabIndex = 0;
      row.title = t('tape.editHint');
    }
    return row;
  }

  function renderTapeHeader() {
    const n = tape.rows.length;
    $('tape-counter').textContent = n === 1 ? t('tape.item') : t('tape.items', { n });
    $('tape-date').textContent = n ? fmtDate(tape.dateStart) : '-';
    $('tape-title').value = tape.title || '';
    $('tape-empty').hidden = n > 0;
    // running accumulator while adding, otherwise the last total of the tape
    const last = E.tapeTotal(tape.rows);
    const shown = calc.cnt !== 0 || calc.acc !== 0 ? calc.acc : last;
    $('tape-total').textContent = shown === null ? '-' : fmtMoney(shown);
  }

  function renderTape() {
    editingIndex = -1;
    const roll = $('tape-roll');
    roll.replaceChildren(...tape.rows.map(tapeRowElement));
    renderTapeHeader();
    renderMiniTape();
    scrollTapeToEnd();
  }

  function appendRows(rows, firstIndex) {
    const roll = $('tape-roll');
    rows.forEach((r, k) => roll.appendChild(tapeRowElement(r, firstIndex + k)));
    // paper feed: the reflow restarts the animation instead of queuing it
    roll.classList.remove('feed');
    void roll.offsetWidth;
    roll.classList.add('feed');
    renderTapeHeader();
    renderMiniTape();
    scrollTapeToEnd();
  }

  // Last rows of the tape above the display, shown on phones where the tape
  // has its own view. Read-only: a tap opens the full tape.
  const MINI_ROWS = 40;
  function renderMiniTape() {
    const box = $('mini-tape');
    box.replaceChildren(...tape.rows.slice(-MINI_ROWS).map(r => {
      const v = rowView(r);
      const row = el('div', 'mt-row ' + v.cls.join(' '));
      row.append(el('span', 'mt-label', v.label), el('span', 'mt-val', v.value), el('span', 'mt-op', v.op));
      return row;
    }));
    box.scrollTop = box.scrollHeight;
  }

  function scrollTapeToEnd() {
    const sc = $('tape-scroll');
    sc.scrollTop = sc.scrollHeight;
  }

  // ---------------------------------------------------------------- tape editing

  function startEdit(index) {
    const r = tape.rows[index];
    if (!r || !r.edit || tape.legacy) return;
    if (editingIndex >= 0) cancelEdit();
    editingIndex = index;
    const row = $('tape-roll').children[index];
    row.classList.add('editing');
    const box = el('div', 'tape-edit');
    const input = el('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.value = fmt(tape.actions[r.a].operand, 'F');
    input.setAttribute('aria-label', t('tape.editHint'));
    const ok = el('button', 'edit-save', '✓');
    const ko = el('button', 'edit-cancel', '✗');
    ok.setAttribute('aria-label', t('common.save'));
    ko.setAttribute('aria-label', t('common.cancel'));
    box.append(input, ok, ko);
    row.querySelector('.r-label').replaceWith(box);
    row.querySelector('.r-val').remove();
    ok.addEventListener('click', (e) => { e.stopPropagation(); saveEdit(); });
    ko.addEventListener('click', (e) => { e.stopPropagation(); cancelEdit(); });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') saveEdit();
      else if (e.key === 'Escape') cancelEdit();
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    input.focus();
    input.select();
  }

  function cancelEdit() {
    if (editingIndex < 0) return;
    const i = editingIndex;
    editingIndex = -1;
    const old = $('tape-roll').children[i];
    if (old) {
      const fresh = tapeRowElement(tape.rows[i], i);
      old.replaceWith(fresh);
      fresh.focus();
    }
  }

  function saveEdit() {
    const r = tape.rows[editingIndex];
    const input = $('tape-roll').querySelector('.tape-edit input');
    if (!r || !input) return;
    const v = E.parseNumber(input.value, I.sep());
    if (!isFinite(v) || Math.abs(v) >= E.LIMIT) {
      toast(t('toast.invalid'));
      input.focus();
      return;
    }
    tape.actions[r.a].operand = v;
    const res = E.replay(tape.startRegs, tape.actions);
    calc = res.calc;
    tape.rows = res.rows;
    renderTape();
    renderDisplay();
    saveCurrent();
    toast(t('toast.updated'));
  }

  // ---------------------------------------------------------------- display

  // Shrinks the number on its measured width: glyph widths differ a lot
  // between fonts (segment digits are wider than monospace ones) and a
  // cut-off amount would show wrong decimals. Hidden display: nothing to measure.
  function fitDisplay() {
    const main = $('disp-main');
    main.style.fontSize = '';
    if (!main.clientWidth || main.scrollWidth <= main.clientWidth) return;
    const size = parseFloat(getComputedStyle(main).fontSize);
    main.style.fontSize = Math.floor(size * main.clientWidth / main.scrollWidth) + 'px';
  }

  function renderDisplay() {
    const disp = $('disp');
    const main = $('disp-main');
    const segment = settings.skin === 'classic' && settings.displayFont === 'segment';
    let text, spoken;
    if (calc.error) {
      text = spoken = 'ERR';
      $('disp-msg').textContent = t('err.' + calc.error);
    } else {
      $('disp-msg').textContent = '';
      const show = (sep, opts) => calc.hasEntry() ? E.formatEntry(calc.entryText(), sep, opts)
        : E.formatNumber(calc.x, settings.decimals, sep, opts);
      spoken = show(I.sep());
      text = segment ? show(SEGMENT_SEP, SEGMENT_OPTS) : spoken;
    }
    if (segment) {
      main.replaceChildren(...text.split("'").flatMap((part, i) =>
        i ? [el('span', 'seg-tick'), part] : [part]));
    } else {
      main.textContent = text;
    }
    $('disp-sr').textContent = spoken;
    // the classic display turns red on negative values, like the Logos 902
    disp.classList.toggle('neg', !calc.error && spoken.startsWith('\u2212'));
    fitDisplay();
    disp.classList.toggle('error', !!calc.error);
    $('disp-pending').textContent = calc.md ? fmt(calc.md.a) + ' ' + OP_SYMBOLS[calc.md.op] : '';
    const regs = calc.regs;
    $('ind-m').classList.toggle('on', regs.memory !== 0);
    $('ind-gt').classList.toggle('on', regs.gt !== 0);
    $('ind-t1').classList.toggle('on', regs.t1 !== 0);
    $('ind-t2').classList.toggle('on', regs.t2 !== 0);
    $('ind-acc').classList.toggle('on', calc.acc !== 0 || calc.cnt !== 0);
    $('ind-acc').textContent = calc.cnt ? '\u03a3 ' + String(calc.cnt).padStart(3, '0') : '\u03a3';
    $('ind-iva').textContent = t('disp.vatShort', { rate: fmt(settings.ivaRates[settings.ivaActive], 'F') });
    $('ind-dec').textContent = settings.decimals + ' ' + { down: '↓', half: '5/4', up: '↑' }[settings.rounding];
  }

  // ---------------------------------------------------------------- commands

  function command(cmd, extra) {
    if (editingIndex >= 0) cancelEdit();
    const action = calc.press(cmd, cfg(), extra);
    if (action) {
      tape.actions.push(action);
      const rows = calc.exec(action, tape.actions.length - 1);
      const first = tape.rows.length;
      tape.rows.push(...rows);
      if (rows.length) appendRows(rows, first);
      else renderTapeHeader();
      if (rows.some(r => r.kind === 'clear-all')) toast(t('toast.registersCleared'));
      saveCurrent();
    }
    renderDisplay();
  }

  function entryKey(kind, digit) {
    if (kind === 'digit') calc.inputDigit(digit);
    else if (kind === 'point') calc.inputPoint();
    else if (kind === 'bksp') { if (calc.error) calc.clearEntry(); else calc.backspace(); }
    else if (kind === 'ce') calc.clearEntry();
    renderDisplay();
  }

  function setVat(i) {
    settings.ivaActive = i;
    saveSettings();
    applySettings();
  }

  function setDecimals(d) {
    settings.decimals = d;
    saveSettings();
    applySettings();
  }

  // ---------------------------------------------------------------- tear and archive

  function tearTape() {
    if (editingIndex >= 0) cancelEdit();
    if (!tape.actions.length) { toast(t('toast.tapeEmpty')); return; }
    archiveCurrent();
    // memory and GT carry over, as on the machine; totalizers start clean
    const regs = calc.registers();
    tape = newTape({ memory: regs.memory, gt: regs.gt });
    calc = new E.Calculator(tape.startRegs);
    saveCurrent();
    renderTape();
    renderDisplay();
    updateArchCount();
    toast(t('toast.archived'));
  }

  function archiveCurrent() {
    tape.dateEnd = new Date().toISOString();
    if (!tape.title.trim()) tape.title = t('tape.defaultTitle', { date: fmtDate(tape.dateStart, false) });
    archive.unshift(tape);
    saveArchive();
  }

  function updateArchCount() {
    $('arch-count').textContent = archive.length ? '(' + archive.length + ')' : '';
  }

  function archiveCard(tp, opts) {
    const card = el('div', 'arch-item');
    card.dataset.id = tp.id;
    const title = el('div', 'arch-title', tp.title || t('common.untitled'));
    const date = el('div', 'arch-date', fmtDate(tp.dateStart));
    const meta = el('div', 'arch-meta');
    meta.append(el('span', '', t('common.items', { n: tp.rows.length })));
    const last = E.tapeTotal(tp.rows);
    const total = el('strong', '', last === null ? '-' : fmtMoney(last));
    meta.append(total);
    card.append(title, date, meta);
    if (opts && opts.select) {
      const cb = el('input', 'arch-check');
      cb.type = 'checkbox';
      cb.checked = opts.select.has(tp.id);
      cb.setAttribute('aria-label', t('archive.select'));
      cb.addEventListener('change', () => {
        if (cb.checked) opts.select.add(tp.id); else opts.select.delete(tp.id);
        card.classList.toggle('selected', cb.checked);
        if (opts.onSelect) opts.onSelect();
      });
      card.classList.toggle('selected', cb.checked);
      card.prepend(cb);
    }
    if (opts && opts.actions) {
      const act = el('div', 'arch-actions');
      const open = el('button', '', t('archive.open'));
      const del = el('button', '', t('archive.delete'));
      open.addEventListener('click', () => showDetail(tp));
      del.addEventListener('click', () => deleteTape(tp.id));
      act.append(open, del);
      card.append(act);
    }
    return card;
  }

  function searchText(tp) {
    const last = E.tapeTotal(tp.rows);
    return [tp.title, fmtDate(tp.dateStart), last === null ? '' : fmt(last, '2')]
      .join(' ').toLowerCase();
  }

  function renderArchive() {
    const q = $('arch-search').value.trim().toLowerCase();
    const list = $('arch-list');
    const items = q ? archive.filter(tp => searchText(tp).includes(q)) : archive;
    $('arch-info').textContent = t('archive.count', { n: items.length, total: archive.length });
    if (!items.length) {
      list.replaceChildren(el('div', 'arch-empty', archive.length ? t('archive.noMatch') : t('archive.empty')));
    } else {
      list.replaceChildren(...items.map(tp => archiveCard(tp, { select: exportSelected, actions: true, onSelect: updateExportBtn })));
    }
    updateExportBtn();
  }

  function updateExportBtn() {
    $('arch-export-btn').disabled = exportSelected.size === 0;
  }

  function deleteTape(id) {
    if (!confirm(t('archive.deleteConfirm'))) return;
    archive = archive.filter(tp => tp.id !== id);
    exportSelected.delete(id);
    printSelected.delete(id);
    saveArchive();
    renderArchive();
    updateArchCount();
  }

  function showDetail(tp) {
    detailTape = tp;
    $('detail-h').textContent = tp.title || t('common.untitled');
    $('detail-date').textContent = fmtDate(tp.dateStart) + (tp.legacy ? ' - ' + t('tape.readonly') : '');
    $('detail-rows').innerHTML = receiptRowsHtml(tp);
    $('detail-restore').hidden = tp.legacy;
    showOverlay('ov-detail');
  }

  function restoreDetail() {
    const tp = detailTape;
    if (!tp || tp.legacy) return;
    if (tape.actions.length && !confirm(t('archive.restoreConfirm'))) return;
    archive = archive.filter(x => x.id !== tp.id);
    if (tape.actions.length) archiveCurrent();
    tape = tp;
    tape.dateEnd = null;
    const res = E.replay(tape.startRegs, tape.actions);
    calc = res.calc;
    tape.rows = res.rows;
    saveArchive();
    saveCurrent();
    renderTape();
    renderDisplay();
    updateArchCount();
    hideOverlay('ov-detail');
    hideOverlay('ov-archive');
    toast(t('toast.restored'));
  }

  // ---------------------------------------------------------------- backup

  function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function stamp() {
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  }

  function exportAll() {
    downloadJSON({
      format: DATA_FORMAT, version: APP_VERSION, exported: new Date().toISOString(),
      settings, archive: archive.map(serializeTape), current: serializeTape(tape)
    }, 'golos-summa-backup-' + stamp() + '.json');
  }

  function exportSelectedTapes() {
    const sel = archive.filter(tp => exportSelected.has(tp.id));
    if (!sel.length) return;
    downloadJSON({ format: DATA_FORMAT, version: APP_VERSION, exported: new Date().toISOString(),
      archive: sel.map(serializeTape) }, 'golos-summa-export-' + stamp() + '.json');
  }

  function importFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const data = parseJson(reader.result);
      const list = data && (Array.isArray(data.archive) ? data.archive : (Array.isArray(data) ? data : null));
      const tapes = list ? list.map(sanitizeTape).filter(Boolean) : [];
      if (!tapes.length) { toast(t('toast.importInvalid')); return; }
      if (!confirm(t('toast.importConfirm', { n: tapes.length }))) return;
      const known = new Set(archive.map(tp => tp.id));
      tapes.forEach(tp => { if (known.has(tp.id)) tp.id = newId('tape'); known.add(tp.id); });
      archive = tapes.concat(archive);
      saveArchive();
      updateArchCount();
      toast(t('toast.imported', { n: tapes.length }));
    };
    reader.onerror = () => toast(t('toast.importInvalid'));
    reader.readAsText(file);
  }

  function wipeAll() {
    if (!confirm(t('settings.wipeConfirm'))) return;
    if (!confirm(t('settings.wipeConfirm2'))) return;
    archive = [];
    exportSelected.clear();
    printSelected.clear();
    saveArchive();
    updateArchCount();
    toast(t('toast.wiped'));
  }

  // ---------------------------------------------------------------- print

  function receiptRowsHtml(tp) {
    return tp.rows.map(r => {
      const v = rowView(r);
      const cls = v.cls.includes('t-total') ? 'r-total' : (v.cls.includes('t-subtotal') ? 'r-subtotal' : '');
      return '<div class="pr-row ' + cls + '"><span class="pr-label">' + escapeHtml(v.label) +
        '</span><span>' + escapeHtml(v.value) + ' <span class="pr-op">' + escapeHtml(v.op) + '</span></span></div>';
    }).join('');
  }

  function receiptsToPrint() {
    const list = [];
    if ($('prn-include-current').checked && tape.rows.length) list.push({ tp: tape, current: true });
    archive.forEach(tp => { if (printSelected.has(tp.id)) list.push({ tp, current: false }); });
    return list;
  }

  function printHtml() {
    const title = $('prn-title').value || t('print.defaultTitle');
    const cols = parseInt($('prn-cols').value, 10) || 1;
    const list = receiptsToPrint();
    const now = new Date().toLocaleString(I.intl(), { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    let html = '<div class="print-page-header"><h1>' + escapeHtml(title) + '</h1><span>' + escapeHtml(now) + '</span></div>' +
      '<div class="print-cols" style="column-count:' + cols + '">';
    if (!list.length) html += '<div style="text-align:center;color:#999;padding:60px 0">' + escapeHtml(t('print.none')) + '</div>';
    list.forEach(({ tp, current }) => {
      const last = E.tapeTotal(tp.rows);
      html += '<div class="print-receipt"><div class="print-receipt-head"><div class="pr-title">' +
        escapeHtml(tp.title || t('common.untitled')) + (current ? ' <em>' + escapeHtml(t('print.current')) + '</em>' : '') +
        '</div><div class="pr-date">' + escapeHtml(fmtDate(tp.dateStart)) + '</div></div>' +
        '<div class="print-receipt-rows">' + receiptRowsHtml(tp) +
        (last !== null ? '<div class="pr-row r-total"><span>' + escapeHtml(t('print.total')) + '</span><span>' +
          escapeHtml(fmtMoney(last)) + '</span></div>' : '') + '</div></div>';
    });
    return html + '</div>';
  }

  function renderPrint() {
    const list = $('prn-list');
    if (!archive.length) list.replaceChildren(el('div', 'arch-empty', t('archive.empty')));
    else list.replaceChildren(...archive.map(tp => archiveCard(tp, { select: printSelected, onSelect: renderPrintPreview })));
    renderPrintPreview();
  }

  function renderPrintPreview() { $('prn-preview').innerHTML = printHtml(); }

  function openPrint() {
    if (editingIndex >= 0) cancelEdit();
    $('prn-include-current').checked = tape.rows.length > 0;
    if (!$('prn-title').value) $('prn-title').value = t('print.defaultTitle');
    renderPrint();
    showOverlay('ov-print');
  }

  function doPrint() {
    if (!receiptsToPrint().length) { toast(t('print.none')); return; }
    const area = $('print-area');
    area.innerHTML = '<div class="print-page">' + printHtml() + '</div>';
    const cleanup = () => { area.innerHTML = ''; window.removeEventListener('afterprint', cleanup); };
    window.addEventListener('afterprint', cleanup);
    window.print();
  }

  // ---------------------------------------------------------------- overlays and toast

  let lastFocus = null;
  function showOverlay(id) {
    lastFocus = document.activeElement;
    const ov = $(id);
    ov.classList.add('show');
    const first = ov.querySelector('input, select, button:not(.close)');
    if (first) first.focus();
  }

  function hideOverlay(id) {
    $(id).classList.remove('show');
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }

  function openOverlay() {
    const all = document.querySelectorAll('.overlay.show');
    return all.length ? all[all.length - 1] : null;
  }

  let toastTimer;
  function toast(msg) {
    const n = $('toast');
    n.textContent = msg;
    n.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => n.classList.remove('show'), 2600);
  }

  // ---------------------------------------------------------------- settings and appearance

  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function applyTheme() {
    const root = document.documentElement;
    root.dataset.skin = settings.skin;
    const dark = settings.theme === 'dark' || (settings.theme === 'auto' && darkQuery && darkQuery.matches);
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.dispFont = settings.displayFont;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(root).getPropertyValue('--bg-header').trim().startsWith('#')
      ? getComputedStyle(root).getPropertyValue('--bg-header').trim()
      : getComputedStyle(root).getPropertyValue('--kbd-bg').trim();
  }

  function applySettings() {
    I.setLanguage(settings.lang || I.detect());
    I.apply();
    applyTheme();
    document.querySelectorAll('#sel-dec .sel-btn').forEach(b => {
      const on = b.dataset.dec === settings.decimals;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on);
    });
    document.querySelectorAll('#sel-iva .sel-btn').forEach(b => {
      const i = parseInt(b.dataset.iva, 10);
      const on = i === settings.ivaActive;
      b.textContent = fmt(settings.ivaRates[i], 'F') + '%';
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on);
    });
    document.querySelectorAll('.k-iva-current').forEach(s => { s.textContent = fmt(settings.ivaRates[settings.ivaActive], 'F') + '%'; });
    $('calc-zone').classList.toggle('basic-mode', !settings.advancedMode);
    document.body.classList.toggle('basic-mode-hints', !settings.advancedMode);
    $('mode-switch').setAttribute('aria-checked', settings.advancedMode);
    document.body.classList.toggle('hints-off', !settings.showHints);
    $('app-version').textContent = 'v' + APP_VERSION;
    // decimal key shows the locale separator
    $('keypad').querySelector('[data-k="point"]').textContent = I.sep().point;
    renderTape();
    renderDisplay();
    updateArchCount();
  }

  // the display font choice exists only for the classic skin
  function toggleDisplayFontRow() {
    $('row-disp-font').hidden = $('set-skin').value !== 'classic';
  }

  function fillSettingsForm() {
    $('set-skin').value = settings.skin;
    $('set-theme').value = settings.theme;
    $('set-disp-font').value = settings.displayFont;
    toggleDisplayFontRow();
    $('set-lang').value = I.language();
    $('set-advanced').checked = settings.advancedMode;
    $('set-hints').checked = settings.showHints;
    $('set-decimals').value = settings.decimals;
    $('set-rounding').value = settings.rounding;
    $('set-currency').value = settings.currency;
    $('set-currency-pos').value = settings.currencyPos;
    settings.ivaRates.forEach((r, i) => { $('set-iva-' + i).value = r; });
  }

  function saveSettingsForm() {
    const s = cloneSettings(settings);
    s.skin = $('set-skin').value;
    s.theme = $('set-theme').value;
    s.displayFont = $('set-disp-font').value;
    s.lang = $('set-lang').value;
    s.advancedMode = $('set-advanced').checked;
    s.showHints = $('set-hints').checked;
    s.decimals = $('set-decimals').value;
    s.rounding = $('set-rounding').value;
    s.currency = $('set-currency').value.trim() || '€';
    s.currencyPos = $('set-currency-pos').value;
    for (let i = 0; i < 4; i++) {
      const v = parseFloat($('set-iva-' + i).value);
      if (isFinite(v) && v >= 0 && v <= 100) s.ivaRates[i] = v;
    }
    settings = sanitizeSettings(s);
    saveSettings();
    applySettings();
    hideOverlay('ov-settings');
    toast(t('toast.saved'));
  }

  function toggleAdvanced() {
    settings.advancedMode = !settings.advancedMode;
    saveSettings();
    applySettings();
  }

  // ---------------------------------------------------------------- input binding

  function flash(k) {
    const b = $('keypad').querySelector('[data-k="' + k + '"]');
    if (!b) return;
    b.classList.add('pressed');
    setTimeout(() => b.classList.remove('pressed'), 90);
  }

  function keypadClick(b) {
    const d = b.dataset;
    if (d.digit) entryKey('digit', d.digit);
    else if (d.entry) entryKey(d.entry);
    else if (d.cmd === 'mul') command('mul', { op: d.op });
    else if (d.cmd === 'taxPlus' || d.cmd === 'taxMinus') command(d.cmd, { rate: settings.ivaRates[settings.ivaActive] });
    else if (d.cmd === 'add' || d.cmd === 't1' || d.cmd === 't2') command(d.cmd, { sign: parseInt(d.sign, 10) });
    else if (d.cmd) command(d.cmd);
  }

  function bind() {
    const keypad = $('keypad');
    // keep focus where it is, so Enter on the keyboard never re-clicks a key
    keypad.addEventListener('mousedown', (e) => { if (e.target.closest('.k')) e.preventDefault(); });
    keypad.addEventListener('click', (e) => {
      const b = e.target.closest('.k');
      if (b) keypadClick(b);
    });
    $('sel-dec').addEventListener('click', (e) => { const b = e.target.closest('.sel-btn'); if (b) setDecimals(b.dataset.dec); });
    $('sel-iva').addEventListener('click', (e) => { const b = e.target.closest('.sel-btn'); if (b) setVat(parseInt(b.dataset.iva, 10)); });

    $('tape-roll').addEventListener('click', (e) => {
      const row = e.target.closest('.tape-row.editable');
      if (row && !row.classList.contains('editing')) startEdit(parseInt(row.dataset.index, 10));
    });
    $('tape-roll').addEventListener('keydown', (e) => {
      const row = e.target.closest('.tape-row.editable');
      if (row && (e.key === 'Enter' || e.key === ' ') && !row.classList.contains('editing')) {
        e.preventDefault();
        e.stopPropagation();
        startEdit(parseInt(row.dataset.index, 10));
      }
    });
    $('mini-tape').addEventListener('click', () => document.querySelector('.view-btn[data-view="tape"]').click());
    $('tape-title').addEventListener('input', (e) => { tape.title = e.target.value.slice(0, 80); saveCurrent(); });

    $('btn-tear').addEventListener('click', tearTape);
    $('btn-archive').addEventListener('click', () => { $('arch-search').value = ''; renderArchive(); showOverlay('ov-archive'); });
    $('btn-print').addEventListener('click', openPrint);
    $('btn-settings').addEventListener('click', () => { fillSettingsForm(); showOverlay('ov-settings'); });
    $('mode-switch').addEventListener('click', toggleAdvanced);
    $('hints-toggle').addEventListener('click', () => { settings.showHints = false; saveSettings(); applySettings(); });
    $('hints-show').addEventListener('click', () => { settings.showHints = true; saveSettings(); applySettings(); });
    document.querySelectorAll('.view-btn').forEach(b => b.addEventListener('click', () => {
      document.querySelector('.app-main').dataset.view = b.dataset.view;
      document.querySelectorAll('.view-btn').forEach(x => x.classList.toggle('active', x === b));
      if (b.dataset.view === 'tape') scrollTapeToEnd();
      else fitDisplay();
    }));
    // refit when the display width changes (window, rotation, view switch);
    // width only, since fitting changes the height
    if (window.ResizeObserver) {
      let lastWidth = -1;
      new ResizeObserver(entries => {
        const w = entries[0].contentRect.width;
        if (w !== lastWidth) { lastWidth = w; fitDisplay(); }
      }).observe($('disp-main'));
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitDisplay);

    document.querySelectorAll('.overlay').forEach(ov => {
      ov.addEventListener('click', (e) => {
        if (e.target === ov || e.target.closest('[data-close]')) hideOverlay(ov.id);
      });
    });
    $('arch-search').addEventListener('input', renderArchive);
    $('arch-export-btn').addEventListener('click', exportSelectedTapes);
    $('detail-restore').addEventListener('click', restoreDetail);
    $('btn-save-settings').addEventListener('click', saveSettingsForm);
    $('set-skin').addEventListener('change', toggleDisplayFontRow);
    $('btn-export').addEventListener('click', exportAll);
    $('btn-import').addEventListener('click', () => $('import-file').click());
    $('import-file').addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) importFile(f);
    });
    $('btn-wipe').addEventListener('click', wipeAll);
    ['prn-cols', 'prn-title', 'prn-include-current'].forEach(id => $(id).addEventListener('input', renderPrintPreview));
    $('prn-include-current').addEventListener('change', renderPrintPreview);
    $('btn-do-print').addEventListener('click', doPrint);
    if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', applyTheme);

    document.addEventListener('keydown', onKey);
  }

  function onKey(e) {
    const ov = openOverlay();
    if (ov) {
      if (e.key === 'Escape') { e.preventDefault(); hideOverlay(ov.id); }
      return;
    }
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('button, .tape-row')) return;

    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'p') { e.preventDefault(); openPrint(); }
      else if (e.key === 'Enter') { e.preventDefault(); tearTape(); }
      return;
    }
    if (e.altKey) {
      const m = /^Digit([1-4])$/.exec(e.code);
      if (m) { e.preventDefault(); setVat(parseInt(m[1], 10) - 1); }
      else if (e.code === 'KeyA') { e.preventDefault(); toggleAdvanced(); }
      return;
    }

    const rate = () => ({ rate: settings.ivaRates[settings.ivaActive] });
    const k = e.key;
    let handled = true;
    if (/^[0-9]$/.test(k)) { entryKey('digit', k); flash('n' + k); }
    else switch (k) {
      case '.': case ',': entryKey('point'); flash('point'); break;
      case '+': command('add', { sign: 1 }); flash('plus'); break;
      case '-': command('add', { sign: -1 }); flash('minus'); break;
      case '*': case 'x': case 'X': command('mul', { op: '*' }); flash('mul'); break;
      case '/': command('mul', { op: '/' }); flash('div'); break;
      case '=': command('eq'); flash('eq'); break;
      case 'Enter':
        // Enter closes a multiplication or a constant calculation, otherwise
        // it gives the total of the additions.
        if (calc.md || (calc.constant && calc.acc === 0 && calc.cnt === 0)) { command('eq'); flash('eq'); }
        else { command('total'); flash('total'); }
        break;
      case 's': case 'S': command('sub'); flash('sub'); break;
      case 't': case 'T': command('total'); flash('total'); break;
      case 'Backspace': entryKey('bksp'); flash('bksp'); break;
      case 'Escape': entryKey('ce'); flash('ce'); break;
      case 'Delete': command('clear'); flash('clear'); break;
      case '%': command('percent'); flash('percent'); break;
      case 'n': case 'N': command('neg'); flash('sign'); break;
      case 'i': command('taxPlus', rate()); flash('taxplus'); break;
      case 'I': command('taxMinus', rate()); flash('taxminus'); break;
      case 'm': command('mPlus'); flash('mplus'); break;
      case 'M': command('mMinus'); flash('mminus'); break;
      case 'r': command('mSub'); flash('msub'); break;
      case 'R': command('mTotal'); flash('mtotal'); break;
      case 'g': case 'G': command('gt'); flash('gt'); break;
      case 'q': case 'Q': command('sqrt'); flash('sqrt'); break;
      case 'F7': command('t1', { sign: 1 }); flash('t1plus'); break;
      case 'F8': command('t1', { sign: -1 }); flash('t1minus'); break;
      case 'F9': command('tot1'); flash('tot1'); break;
      case 'F10': command('tot2'); flash('tot2'); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  }

  // ---------------------------------------------------------------- PWA

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed') toast(navigator.serviceWorker.controller ? t('toast.update') : t('toast.offline'));
        });
      });
    }).catch(() => { /* offline support is optional */ });
  }

  // Installed app only: pinch and double-tap zoom break the fixed layout. In a
  // browser tab zoom stays available for accessibility.
  function lockZoomWhenInstalled() {
    const installed = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) ||
      navigator.standalone === true;
    if (!installed) return;
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta) meta.content += ', maximum-scale=1, user-scalable=no';
    document.documentElement.classList.add('installed');
    // iOS ignores user-scalable=no: block the pinch gesture itself
    document.addEventListener('gesturestart', e => e.preventDefault());
    document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  }

  // ---------------------------------------------------------------- init

  lockZoomWhenInstalled();
  load();
  bind();
  applySettings();
  saveCurrent();
  registerServiceWorker();
})();
