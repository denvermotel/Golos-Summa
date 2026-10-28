/*
 * Golos-Summa calculation engine.
 *
 * Pure logic: no DOM, no storage, no translated text. It is the executable
 * specification the Rust port must follow (same test cases).
 *
 * Key logic follows the Olivetti Logos printing calculators (adding machine):
 *   - [+] and [-] add the entry to the accumulator, which is shown at once;
 *     pressed again without a new entry they repeat the last amount;
 *   - [S] (subtotal) shows the accumulator, [T] (total) shows and clears it
 *     and adds it to the grand total;
 *   - [x] and [/] are chained left to right and closed by [=], [%] or [+]/[-]
 *     (which then add the result to the accumulator);
 *   - constant: [x] keeps the first factor, [/] keeps the divisor;
 *   - [%] after a [x] gives the percentage; [+] or [-] right after it gives
 *     the add-on or the discount.
 *
 * Digits typed by the user build an "entry". Every key that consumes a number
 * is a command; the command records the typed operand (or null when no number
 * was typed) so a tape can be replayed after a row is edited.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GolosEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ENGINE = 2;            // action log format; tapes of other versions are read-only
  const MAX_DIGITS = 12;
  const LIMIT = 1e12;          // 12-digit capacity, like the Logos
  const FLOAT_DECIMALS = 10;   // precision kept in floating decimal mode (F)
  const DECIMAL_MODES = ['A', '0', '2', '3', '4', '5', 'F'];
  const ROUNDING_MODES = ['down', 'half', 'up'];
  const MINUS = '−';
  // Commands whose typed operand is an amount: in mode A it gets two
  // implicit decimals (unless a multiplication or division is open).
  const AMOUNT_CMDS = ['add', 'sub', 'total', 'mPlus', 'mMinus', 't1', 't2', 'taxPlus', 'taxMinus'];
  const CMDS = ['add', 'sub', 'total', 'mul', 'eq', 'percent', 'sqrt', 'neg', 'taxPlus',
    'taxMinus', 'mPlus', 'mMinus', 'mSub', 'mTotal', 'gt', 't1', 't2', 'sub1', 'sub2',
    'tot1', 'tot2', 'clear'];

  // ---- Rounding ----------------------------------------------------------

  // Decimal shift through the exponent notation avoids the binary error of
  // x * 10^n (1.005 * 100 = 100.49999...).
  function shift(x, exp) {
    const parts = String(x).split('e');
    return Number(parts[0] + 'e' + (Number(parts[1] || 0) + exp));
  }

  // Rounds |x| to `dec` decimals: 'half' = commercial (half away from zero),
  // 'down' = truncate, 'up' = away from zero. Returns +0 instead of -0.
  function roundTo(x, dec, mode) {
    if (!isFinite(x)) return x;
    const sign = x < 0 ? -1 : 1;
    // toPrecision(15) drops binary noise such as 0.30000000000000004
    const scaled = Number(shift(Math.abs(x), dec).toPrecision(15));
    let n;
    if (mode === 'down') n = Math.floor(scaled);
    else if (mode === 'up') n = Math.ceil(scaled);
    else n = Math.round(scaled);
    const r = sign * shift(n, -dec);
    return r === 0 ? 0 : r;
  }

  function decimalsOf(mode) {
    if (mode === 'F') return FLOAT_DECIMALS;
    if (mode === 'A') return 2;
    return parseInt(mode, 10);
  }

  // Rounds a result according to the decimal and rounding selectors.
  function roundResult(x, cfg) {
    if (cfg.dec === 'F') return roundTo(x, FLOAT_DECIMALS, 'half');
    return roundTo(x, decimalsOf(cfg.dec), cfg.rnd);
  }

  // Internal precision for sums: removes binary noise only.
  function clean(x) { return roundTo(x, FLOAT_DECIMALS, 'half'); }

  // ---- Formatting --------------------------------------------------------

  function groupInt(intPart, group) {
    return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  }

  // sep = { group: '.', point: ',' }. dec: decimal mode or a number of digits.
  function formatNumber(value, dec, sep, opts) {
    if (!isFinite(value)) return 'ERR';
    const minus = (opts && opts.minus) || MINUS;
    let str;
    if (dec === 'F') {
      str = roundTo(Math.abs(value), FLOAT_DECIMALS, 'half').toFixed(FLOAT_DECIMALS)
        .replace(/0+$/, '').replace(/\.$/, '');
    } else {
      const d = typeof dec === 'number' ? dec : decimalsOf(dec);
      str = roundTo(Math.abs(value), d, 'half').toFixed(d);
    }
    const parts = str.split('.');
    let out = groupInt(parts[0], sep.group);
    if (parts[1] !== undefined) out += sep.point + parts[1];
    const isNeg = value < 0 && /[1-9]/.test(str);
    return isNeg ? minus + out : out;
  }

  // Formats a neutral entry string ("-1234.5", "12.") keeping what the user typed.
  function formatEntry(neutral, sep, opts) {
    const minus = (opts && opts.minus) || MINUS;
    const neg = neutral.startsWith('-');
    const body = neg ? neutral.slice(1) : neutral;
    const dot = body.indexOf('.');
    const intPart = dot < 0 ? body : body.slice(0, dot);
    let out = groupInt(intPart || '0', sep.group);
    if (dot >= 0) out += sep.point + body.slice(dot + 1);
    return (neg ? minus : '') + out;
  }

  // Parses a number typed in a text field. Accepts the locale separators, a
  // plain "." as decimal point when no group separator is ambiguous, and both
  // "-" and the minus sign. Returns NaN when the text is not a number.
  function parseNumber(text, sep) {
    let s = String(text).trim().replace(/\s| /g, '').replace(MINUS, '-');
    if (!s) return NaN;
    if (sep.point === ',') {
      if (s.includes(',')) s = s.split(sep.group).join('').replace(',', '.');
      else if ((s.match(/\./g) || []).length > 1) s = s.split('.').join('');
      else if (/^-?\d{1,3}\.\d{3}$/.test(s)) s = s.replace('.', '');
    } else {
      s = s.split(sep.group).join('');
    }
    if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
    return Number(s);
  }

  // ---- Calculator --------------------------------------------------------

  function emptyRegisters() {
    return { memory: 0, gt: 0, t1: 0, t2: 0, cnt1: 0, cnt2: 0 };
  }

  function sanitizeRegisters(r) {
    const out = emptyRegisters();
    if (r && typeof r === 'object') {
      for (const k of Object.keys(out)) {
        if (typeof r[k] === 'number' && isFinite(r[k])) out[k] = r[k];
      }
    }
    return out;
  }

  class Calculator {
    constructor(registers) {
      this.regs = sanitizeRegisters(registers);
      this.x = 0;              // value shown on the display
      this.xNew = false;       // x is a result not yet used by a key
      this.acc = 0;            // adding accumulator ([+], [-], [S], [T])
      this.cnt = 0;            // item count of the accumulator
      this.lastAddend = null;  // amount repeated by [+]/[-] without a new entry
      this.md = null;          // open multiplication/division { op, a }
      this.factor = null;      // first factor of the open multiplication
      this.constant = null;    // { op, k } for [=] without an open operation
      this.pct = null;         // { base, amount } right after [%]
      this.error = null;       // 'div0' | 'overflow' | 'sqrtNeg'
      this.entry = null;       // { neg, digits, point } while typing
      this.lastCmd = null;
    }

    registers() { return Object.assign({}, this.regs); }

    // ---- Entry (not recorded: it becomes the operand of the next command)

    hasEntry() { return this.entry !== null; }

    inputDigit(d) {
      if (this.error) return;
      if (!this.entry) this.entry = { neg: false, digits: '', point: -1 };
      const e = this.entry;
      for (const ch of d) {
        if (e.digits.replace(/^0+/, '').length >= MAX_DIGITS) return;
        if (e.digits === '0' && e.point < 0) e.digits = '';
        e.digits += ch;
      }
      if (e.digits === '') e.digits = '0';
    }

    inputPoint() {
      if (this.error) return;
      if (!this.entry) this.entry = { neg: false, digits: '0', point: -1 };
      if (this.entry.point < 0) {
        if (this.entry.digits === '') this.entry.digits = '0';
        this.entry.point = this.entry.digits.length;
      }
    }

    backspace() {
      if (!this.entry) return;
      const e = this.entry;
      if (e.point === e.digits.length) e.point = -1;
      else e.digits = e.digits.slice(0, -1);
      if (e.digits === '' && e.point < 0) this.entry = null;
    }

    clearEntry() {
      this.entry = null;
      this.error = null;
    }

    // Neutral entry string exactly as typed (mode A decimals are applied by
    // the key that consumes the entry, as on the Logos).
    entryText() {
      const e = this.entry;
      if (!e) return null;
      const s = e.point >= 0 ? e.digits.slice(0, e.point) + '.' + e.digits.slice(e.point) : e.digits;
      return (e.neg ? '-' : '') + s;
    }

    entryValue(dec, amount) {
      const e = this.entry;
      if (!e) return null;
      let v = Number(e.digits.slice(0, e.point >= 0 ? e.point : undefined) +
        (e.point >= 0 ? '.' + e.digits.slice(e.point) : '')) || 0;
      if (dec === 'A' && amount && e.point < 0) v = shift(v, -2);
      return e.neg ? -v : v;
    }

    // ---- Commands

    // Builds the recorded action for a key press. The caller executes it.
    press(cmd, cfg, extra) {
      if (this.error && cmd !== 'clear') return null;
      if (cmd === 'neg' && this.hasEntry()) {
        this.entry.neg = !this.entry.neg;   // sign change while typing
        return null;
      }
      const amount = AMOUNT_CMDS.includes(cmd) && !this.md;
      const action = Object.assign({ cmd }, extra || {}, {
        operand: this.hasEntry() ? this.entryValue(cfg.dec, amount) : null,
        dec: cfg.dec,
        rnd: cfg.rnd
      });
      this.entry = null;
      return action;
    }

    // Executes an action and returns the tape rows it produces.
    exec(action, index) {
      const rows = [];
      const cfg = { dec: action.dec, rnd: action.rnd };
      const typed = action.operand !== null && action.operand !== undefined;
      const v = typed ? action.operand : null;
      const row = (r) => { r.a = index; r.dec = cfg.dec; rows.push(r); return r; };
      const check = (x) => {
        if (!isFinite(x)) { this.fail('div0'); return null; }
        if (Math.abs(x) >= LIMIT) { this.fail('overflow'); return null; }
        return x;
      };
      const result = (x) => check(roundResult(x, cfg));

      if (this.error && action.cmd !== 'clear') return rows;
      const prev = this.lastCmd;
      const pct = this.pct;
      this.pct = null;
      if (typed) { this.x = v; this.xNew = true; }

      // Closes an open multiplication/division as [=] does. Returns false on error.
      const closeMd = () => {
        const { op, a } = this.md;
        let b = this.x;
        if (!typed && !this.xNew && op === '*') b = this.factor;
        row({ kind: 'eq-in', value: b, edit: typed });
        if (op === '/' && b === 0) { this.fail('div0'); return false; }
        const r = result(op === '*' ? a * b : a / b);
        if (r === null) return false;
        row({ kind: 'result', value: r });
        this.constant = op === '*' ? { op, k: this.factor } : { op, k: b };
        this.md = null;
        this.x = r;
        this.xNew = true;
        return true;
      };

      // Amount used by an adding key: the typed entry, the closed operation,
      // or the value on display.
      const takeAmount = () => {
        if (this.md) return closeMd() ? { value: this.x, edit: false } : null;
        return { value: this.x, edit: typed };
      };

      switch (action.cmd) {
        case 'add': {
          const sign = action.sign < 0 ? -1 : 1;
          const op = sign > 0 ? '+' : '-';
          if (pct && !typed && prev === 'percent') {
            // add-on or discount: 180 x 15 % [+] = 207
            const r = result(pct.base + sign * pct.amount);
            if (r === null) break;
            row({ kind: 'pct-addon', op, value: r });
            this.x = r;
            this.xNew = true;
            break;
          }
          let amt;
          if (this.md) {
            amt = takeAmount();
            if (!amt) break;
          } else if (typed || this.xNew) {
            amt = { value: this.x, edit: typed };
          } else if (prev === 'add' && this.lastAddend !== null) {
            amt = { value: this.lastAddend, edit: false };   // sequential add/subtract
          } else {
            amt = { value: this.x, edit: false };
          }
          const acc = check(clean(this.acc + sign * amt.value));
          if (acc === null) break;
          this.acc = acc;
          this.cnt += sign;
          this.lastAddend = amt.value;
          row({ kind: 'add', op, value: amt.value, edit: amt.edit });
          this.x = this.acc;
          this.xNew = false;
          break;
        }
        case 'sub':
        case 'total': {
          if (this.md) {
            if (!closeMd()) break;
          } else if (typed) {
            // a number typed before S/T is added first
            const acc = check(clean(this.acc + v));
            if (acc === null) break;
            this.acc = acc;
            this.cnt += 1;
            row({ kind: 'add', op: '+', value: v, edit: true });
          }
          const tot = result(this.acc);
          if (tot === null) break;
          row({ kind: action.cmd, value: tot, count: this.cnt });
          if (action.cmd === 'total') {
            const gt = check(clean(this.regs.gt + tot));
            if (gt === null) break;
            this.regs.gt = gt;
            this.acc = 0;
            this.cnt = 0;
          }
          this.x = tot;
          this.xNew = true;
          break;
        }
        case 'mul': {
          const op = action.op === '/' ? '/' : '*';
          if (this.md) {
            const same = !typed && !this.xNew;
            if (!same) {
              const b = this.x;
              row({ kind: 'md-in', op, value: b, edit: typed });
              if (this.md.op === '/' && b === 0) { this.fail('div0'); break; }
              const r = result(this.md.op === '*' ? this.md.a * b : this.md.a / b);
              if (r === null) break;
              this.md = { op, a: r };
              this.x = r;
            } else if (op === '*' && this.md.op === '*') {
              // 2 [x] [x] [=] = 8: repeated multiplication by the first factor
              row({ kind: 'md-in', op, value: this.factor });
              const r = result(this.md.a * this.factor);
              if (r === null) break;
              this.md = { op, a: r };
              this.x = r;
            } else {
              this.md.op = op;   // operator change
            }
          } else {
            row({ kind: 'md-in', op, value: this.x, edit: typed });
            this.md = { op, a: this.x };
            this.factor = this.x;
          }
          this.xNew = false;
          break;
        }
        case 'eq': {
          if (this.md) {
            closeMd();
          } else if (this.constant) {
            const { op, k } = this.constant;
            const b = this.x;
            row({ kind: 'eq-in', value: b, edit: typed });
            if (op === '/' && k === 0) { this.fail('div0'); break; }
            const r = result(op === '*' ? k * b : b / k);
            if (r === null) break;
            row({ kind: 'result', value: r });
            this.x = r;
            this.xNew = true;
          }
          break;
        }
        case 'percent': {
          const p = this.x;
          let base = null;
          if (this.md && this.md.op === '/') {
            row({ kind: 'pct-in', value: p, edit: typed });
            if (p === 0) { this.fail('div0'); break; }
            const r = result(this.md.a / p * 100);
            if (r === null) break;
            row({ kind: 'pct-result', value: r });
            this.md = null;
            this.x = r;
            this.xNew = true;
            break;
          }
          if (this.md) { base = this.md.a; this.constant = { op: '*', k: this.factor }; }
          else if (this.constant && this.constant.op === '*') base = this.constant.k;
          row({ kind: 'pct-in', value: p, edit: typed });
          const r = result(base === null ? p / 100 : base * p / 100);
          if (r === null) break;
          row({ kind: 'pct-result', value: r });
          if (base !== null) this.pct = { base, amount: r };
          this.md = null;
          this.x = r;
          this.xNew = true;
          break;
        }
        case 'sqrt': {
          if (this.x < 0) { this.fail('sqrtNeg'); break; }
          row({ kind: 'sqrt-in', value: this.x, edit: typed });
          const r = result(Math.sqrt(this.x));
          if (r === null) break;
          row({ kind: 'sqrt', value: r });
          this.x = r;
          this.xNew = true;
          break;
        }
        case 'neg': {
          this.x = this.x === 0 ? 0 : -this.x;
          this.xNew = true;
          break;
        }
        case 'taxPlus':
        case 'taxMinus': {
          const amt = takeAmount();
          if (!amt) break;
          const rate = action.rate;
          if (action.cmd === 'taxPlus') {
            const base = amt.value;
            const tax = result(base * rate / 100);
            if (tax === null) break;
            const total = result(base + tax);
            if (total === null) break;
            row({ kind: 'iva-base', value: base, edit: amt.edit });
            row({ kind: 'iva-add', value: tax, rate });
            row({ kind: 'iva-total', value: total });
            this.x = total;
          } else {
            const gross = amt.value;
            const base = result(gross / (1 + rate / 100));
            if (base === null) break;
            const tax = result(gross - base);
            row({ kind: 'iva-gross', value: gross, edit: amt.edit });
            row({ kind: 'iva-sub', value: tax, rate });
            row({ kind: 'iva-net', value: base });
            this.x = base;
          }
          this.xNew = true;
          break;
        }
        case 'mPlus':
        case 'mMinus': {
          const amt = takeAmount();
          if (!amt) break;
          const sign = action.cmd === 'mPlus' ? 1 : -1;
          const m = check(clean(this.regs.memory + sign * amt.value));
          if (m === null) break;
          this.regs.memory = m;
          row({ kind: 'm-add', op: sign > 0 ? '+' : '-', value: amt.value, edit: amt.edit });
          this.xNew = false;
          break;
        }
        case 'mSub':
        case 'mTotal': {
          const m = result(this.regs.memory);
          row({ kind: action.cmd === 'mSub' ? 'm-sub' : 'm-total', value: m });
          if (action.cmd === 'mTotal') this.regs.memory = 0;
          this.x = m;
          this.xNew = true;
          break;
        }
        case 'gt': {
          row({ kind: 'gt-total', value: this.regs.gt });
          this.x = this.regs.gt;
          this.regs.gt = 0;
          this.xNew = true;
          break;
        }
        case 't1':
        case 't2': {
          const n = action.cmd.slice(1);
          const amt = takeAmount();
          if (!amt) break;
          const sign = action.sign < 0 ? -1 : 1;
          const t = check(clean(this.regs['t' + n] + sign * amt.value));
          if (t === null) break;
          this.regs['t' + n] = t;
          this.regs['cnt' + n] += sign;
          row({ kind: 't' + n + '-add', op: sign > 0 ? '+' : '-', value: amt.value,
                count: this.regs['cnt' + n], edit: amt.edit });
          this.xNew = false;
          break;
        }
        case 'sub1':
        case 'sub2':
        case 'tot1':
        case 'tot2': {
          const n = action.cmd.slice(-1);
          const isTotal = action.cmd.startsWith('tot');
          const t = result(this.regs['t' + n]);
          row({ kind: 't' + n + (isTotal ? '-total' : '-sub'), value: t, count: this.regs['cnt' + n] });
          if (isTotal) {
            const gt = check(clean(this.regs.gt + t));
            if (gt === null) break;
            this.regs.gt = gt;
            this.regs['t' + n] = 0;
            this.regs['cnt' + n] = 0;
          }
          this.x = t;
          this.xNew = true;
          break;
        }
        case 'clear': {
          // First press clears the calculation (accumulator, open operations,
          // error). A second consecutive press also clears T1 and T2. Memory
          // and grand total have their own keys (M*, GT), as on the Logos.
          if (prev === 'clear') {
            Object.assign(this.regs, { t1: 0, t2: 0, cnt1: 0, cnt2: 0 });
            row({ kind: 'clear-all' });
          } else {
            row({ kind: 'clear', value: 0 });
          }
          this.x = 0;
          this.xNew = false;
          this.acc = 0;
          this.cnt = 0;
          this.lastAddend = null;
          this.md = null;
          this.constant = null;
          this.error = null;
          break;
        }
        default:
          break;
      }
      this.lastCmd = action.cmd;
      return rows;
    }

    fail(code) {
      this.error = code;
      this.md = null;
      this.entry = null;
    }
  }

  // Rebuilds a calculator and the tape rows from the recorded actions.
  function replay(startRegs, actions) {
    const calc = new Calculator(startRegs);
    const rows = [];
    actions.forEach((a, i) => { rows.push(...calc.exec(a, i)); });
    return { calc, rows };
  }

  // Value used as the tape total: last total-like row, if any.
  const TOTAL_KINDS = ['total', 'result', 'pct-result', 'pct-addon', 'iva-total', 'iva-net',
    't1-total', 't2-total', 'gt-total', 'm-total'];
  function tapeTotal(rows) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (TOTAL_KINDS.includes(rows[i].kind)) return rows[i].value;
    }
    return null;
  }

  return {
    ENGINE, MAX_DIGITS, LIMIT, DECIMAL_MODES, ROUNDING_MODES, MINUS, TOTAL_KINDS, CMDS,
    roundTo, roundResult, decimalsOf, formatNumber, formatEntry, parseNumber,
    emptyRegisters, sanitizeRegisters, Calculator, replay, tapeTotal
  };
});
