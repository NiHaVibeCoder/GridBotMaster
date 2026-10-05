// GridBot Master – vanilla JS, Binance public REST API (kein API-Key nötig).
// Zusammengeführt aus: Grid Bot Backtester + Grid-Bot Analyse & Optimierung.
// Neu: Bot-Monitoring (Tab 3).

const $ = (id) => document.getElementById(id);

// ============================================================
// SHARED: API / Symbole
// ============================================================

const API_BASES = ['https://api.binance.com', 'https://data-api.binance.vision'];
const FEE = 0.001; // 0.1 % pro Trade
const MAX_CANDLES = 8000;
const INTERVALS = [
  ['1m', 60], ['3m', 180], ['5m', 300], ['15m', 900], ['30m', 1800],
  ['1h', 3600], ['2h', 7200], ['4h', 14400], ['6h', 21600], ['8h', 28800],
  ['12h', 43200], ['1d', 86400],
];

let symbols = [];        // flache Liste von Symbol-Strings, für Datalists
let symbolMeta = [];     // [{symbol, base, quote, decimals}]
let symbolMap = new Map();

async function apiGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  let lastErr;
  for (const base of API_BASES) {
    try {
      const res = await fetch(`${base}${path}${qs ? '?' + qs : ''}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} von ${base}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function decimalsFromTick(tickSize) {
  // tickSize kommt als Dezimalstring (z. B. "0.00000001"); parseFloat+String würde bei sehr
  // kleinen Werten in wissenschaftliche Notation ("1e-8") kippen und die Nachkommastellen verlieren.
  const s = String(tickSize).trim();
  const i = s.indexOf('.');
  if (i < 0) return 0;
  return s.slice(i + 1).replace(/0+$/, '').length;
}

async function loadAllSymbols() {
  const info = await apiGet('/api/v3/exchangeInfo');
  symbolMeta = info.symbols
    .filter((s) => s.status === 'TRADING' && s.isSpotTradingAllowed)
    .map((s) => {
      const pf = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
      return { symbol: s.symbol, base: s.baseAsset, quote: s.quoteAsset, decimals: pf ? decimalsFromTick(pf.tickSize) : 4 };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  symbols = symbolMeta.map((s) => s.symbol);
  symbolMap = new Map(symbolMeta.map((s) => [s.symbol, s]));
}

// ---------- Paar-Auswahl (Quote-Asset + Währungspaar), in Analyse, Backtest und Monitoring gleich ----------

// Quote-Assets nach Anzahl Paare sortiert, USDT vorausgewählt
function fillQuoteSelect(quoteSel) {
  const counts = {};
  for (const s of symbolMeta) counts[s.quote] = (counts[s.quote] || 0) + 1;
  const quotes = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  quoteSel.innerHTML = quotes.map((q) => `<option value="${q}">${q} (${counts[q]})</option>`).join('');
  quoteSel.value = quotes.includes('USDT') ? 'USDT' : quotes[0];
}

// Paare des gewählten Quote-Assets als "BASE/QUOTE"; Vorauswahl BTC bzw. erstes Paar
function fillPairSelect(quoteSel, pairSel) {
  const list = symbolMeta.filter((s) => s.quote === quoteSel.value);
  pairSel.innerHTML = list.map((s) => `<option value="${s.symbol}">${s.base}/${s.quote}</option>`).join('');
  const preferred = list.find((s) => s.base === 'BTC') || list[0];
  if (preferred) pairSel.value = preferred.symbol;
}

// Bestimmtes Paar auswählen (Quote-Asset wird passend umgestellt). false = Paar unbekannt.
function selectPair(quoteSel, pairSel, symbol) {
  const sym = symbolMap.get(symbol);
  if (!sym) return false;
  quoteSel.value = sym.quote;
  fillPairSelect(quoteSel, pairSel);
  pairSel.value = symbol;
  return true;
}

// Macht ein <select> durchsuchbar. Das native Select bleibt (versteckt) die Datenquelle: `.value`,
// `innerHTML` und das `change`-Event funktionieren für den übrigen Code unverändert.
function makeSearchable(sel) {
  const wrap = document.createElement('div');
  wrap.className = 'ss';
  sel.parentNode.insertBefore(wrap, sel);
  wrap.innerHTML = `
    <button type="button" class="ss-trigger" aria-haspopup="listbox" aria-expanded="false"><span class="ss-text"></span></button>
    <div class="ss-panel hidden">
      <input type="text" class="ss-search" placeholder="Suchen …" autocomplete="off" spellcheck="false">
      <ul class="ss-list" role="listbox"></ul>
    </div>`;
  wrap.appendChild(sel);
  sel.classList.add('ss-native');
  const trigger = wrap.querySelector('.ss-trigger');
  const text = wrap.querySelector('.ss-text');
  const panel = wrap.querySelector('.ss-panel');
  const search = wrap.querySelector('.ss-search');
  const listEl = wrap.querySelector('.ss-list');
  let items = [];
  let active = -1;

  const sync = () => {
    const o = sel.options[sel.selectedIndex];
    text.textContent = o ? o.textContent : '–';
  };
  // Programmatisches Setzen von `.value` soll die Anzeige mitziehen
  const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(sel, 'value', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(v) { desc.set.call(this, v); sync(); },
  });
  new MutationObserver(sync).observe(sel, { childList: true });

  const norm = (x) => x.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const render = () => {
    const q = norm(search.value);
    const all = [...sel.options].map((o) => ({
      value: o.value, label: o.textContent, key: norm(o.textContent), head: norm(o.textContent.split(/[/\s]/)[0]),
    }));
    // Reihenfolge: exakter Base-Treffer ("ETH" → ETH/USDT), dann Treffer am Anfang (ETHFI/USDT), dann mittendrin (WBETH/USDT)
    const rank = (x) => (x.head === q ? 0 : x.key.startsWith(q) ? 1 : x.key.includes(q) ? 2 : 3);
    items = q ? all.map((x) => [rank(x), x]).filter(([r]) => r < 3).sort((a, b) => a[0] - b[0]).map(([, x]) => x) : all;
    active = Math.max(0, items.findIndex((x) => x.value === sel.value));
    listEl.innerHTML = items.length
      ? items.map((x, i) => `<li role="option" data-i="${i}" class="${i === active ? 'active' : ''}${x.value === sel.value ? ' selected' : ''}">${escapeHtml(x.label)}</li>`).join('')
      : '<li class="ss-empty">Keine Treffer</li>';
    listEl.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  const setActive = (i) => {
    if (!items.length) return;
    active = Math.max(0, Math.min(items.length - 1, i));
    listEl.querySelectorAll('li').forEach((li, k) => li.classList.toggle('active', k === active));
    listEl.children[active]?.scrollIntoView({ block: 'nearest' });
  };
  const open = (seed = '') => {
    if (!panel.classList.contains('hidden')) return;
    panel.classList.remove('hidden');
    trigger.setAttribute('aria-expanded', 'true');
    search.value = seed;
    render();
    search.focus();
  };
  const close = (refocus) => {
    if (panel.classList.contains('hidden')) return;
    panel.classList.add('hidden');
    trigger.setAttribute('aria-expanded', 'false');
    if (refocus) trigger.focus();
  };
  const choose = (i) => {
    const it = items[i];
    if (!it) return;
    const changed = sel.value !== it.value;
    sel.value = it.value;
    close(true);
    if (changed) sel.dispatchEvent(new Event('change', { bubbles: true }));
  };

  trigger.addEventListener('click', () => (panel.classList.contains('hidden') ? open() : close(true)));
  trigger.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); open(e.key); }
  });
  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'Tab') close(false);
  });
  listEl.addEventListener('mousedown', (e) => e.preventDefault()); // Fokus im Suchfeld behalten
  listEl.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) choose(+li.dataset.i);
  });
  // Klicks im Panel nicht an das umschliessende <label> weiterreichen (würde den Trigger erneut klicken)
  panel.addEventListener('click', (e) => e.preventDefault());
  document.addEventListener('mousedown', (e) => { if (!wrap.contains(e.target)) close(false); });
  sync();
}

// Einzelner Kline-Request (max. `limit` Kerzen, optional start-/endTime).
// Gibt Kerzen mit beiden Feld-Namensschemata zurück (t/o/h/l/c UND time/open/high/low/close),
// damit beide portierten Engines unverändert weiterverwendet werden können.
async function fetchKlines(symbol, interval, { limit = 500, startTime, endTime } = {}) {
  const params = { symbol, interval, limit };
  if (startTime) params.startTime = startTime;
  if (endTime) params.endTime = endTime;
  const data = await apiGet('/api/v3/klines', params);
  return data.map((k) => ({
    t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4],
    time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4],
    qv: +k[7], // Handelsvolumen in Quote-Währung
  }));
}

// Paginierter Abruf über einen ganzen Zeitraum (für den Backtest-Tab).
function pickInterval(durationSec) {
  for (const [name, sec] of INTERVALS) {
    if (durationSec / sec <= MAX_CANDLES) return name;
  }
  return '1d';
}

// Text für empfohlenen Stop-Loss/Take-Profit: Abstand zur Grenze, Preis, Abstand zum Kurs
function anSlTpText(r, kind, pd) {
  const isSl = kind === 'sl';
  const price = isSl ? r.stopLossPrice : r.takeProfitPrice;
  const pct = isSl ? r.sl : r.tp;
  return `${pct}% ${isSl ? 'unter der unteren' : 'über der oberen'} Grenze (${fmtPrice(price, pd)}) ${anDistText(price, r.currentPrice)}`;
}

// Hinweis, worauf die SL/TP-Empfehlung beruht
function anSlTpNote(r) {
  const n = r.validatedFolds;
  const parts = [];
  if (r.sl) parts.push(`Stop-Loss in ${r.slHits} von ${n} Testzeitfenstern ausgelöst`);
  if (r.tp) parts.push(`Take-Profit in ${r.tpHits} von ${n} Testzeitfenstern ausgelöst`);
  if (!parts.length) return '';
  return `<p class="note">${parts.join(', ')}.</p>`;
}

// Gewinn/Verlust, wenn ein Bot mit dem Mindestinvest jetzt startet und der Kurs ohne
// Zwischenschwankung direkt bis zum Stop-Loss bzw. Take-Profit läuft (eine synthetische Kerze).
// Unterwegs kauft bzw. verkauft das Grid auf jeder Stufe, beim Auslösen wird alles verkauft.
// Hin- und Herschwankungen würden zusätzlichen Grid-Gewinn bringen.
function anStopPnlText(r, kind, price, quote) {
  if (!r.minInvest || !(price > 0)) return '';
  const isSl = kind === 'sl';
  const target = isSl ? r.stopLossPrice : r.takeProfitPrice;
  if (!(target > 0)) return '';
  const candle = { t: Date.now(), o: price, h: Math.max(price, target), l: Math.min(price, target), c: target };
  const res = simulateGrid([candle], {
    lower: r.rlow, upper: r.rhigh, grids: r.gc, investment: r.minInvest.total, startPrice: price,
    stopLoss: isSl ? target : null, takeProfit: isSl ? null : target, mode: r.mode,
  });
  if (!res.stopped) return '';
  const pct = res.total / r.minInvest.total * 100;
  return `<br>Bei Auslösung mit ${fmt(r.minInvest.total, 0)} ${quote} Mindestinvest: `
    + `<b class="${res.total >= 0 ? 'pos' : 'neg'}">${signed(res.total)} ${quote} (${signed(pct)} %)</b> `
    + `<span class="status">(Kurs läuft direkt vom aktuellen Kurs bis zum ${isSl ? 'Stop-Loss' : 'Take-Profit'}, inkl. Gebühren)</span>`;
}

// Abstand einer Grid-Grenze zum aktuellen Kurs, z.B. "(−8.5% unter aktuellem Kurs)"
function anDistText(level, price) {
  if (!(price > 0) || !isFinite(level)) return '';
  const pct = (level - price) / price * 100;
  const dir = pct < 0 ? 'unter' : 'über';
  return `<span class="status">(${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}% ${dir} aktuellem Kurs)</span>`;
}

async function loadKlinesRange(symbol, interval, startTime, endTime, onProgress) {
  const out = [];
  let from = startTime;
  while (from < endTime) {
    const chunk = await fetchKlines(symbol, interval, { limit: 1000, startTime: from, endTime });
    if (!chunk.length) break;
    out.push(...chunk);
    from = chunk[chunk.length - 1].t + 1;
    onProgress(out.length);
    if (chunk.length < 1000) break;
  }
  return out;
}

// ---------- gemeinsame Formatierung ----------

function fmt(n, d = 2) {
  return n.toLocaleString('de-CH', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function signed(n, d = 2) {
  return (n > 0 ? '+' : '') + fmt(n, d);
}
function fmt6(n) {
  return fmtPrice(n);
}

// Preisformatierung mit genug Nachkommastellen auch für Coins mit sehr kleinem Preis (z. B. SHIB).
// decimals kommt idealerweise vom Binance PRICE_FILTER-Tick des Symbols; Fallback: aus dem Wert
// selbst ableiten, damit auch ohne bekanntes Symbol genug signifikante Stellen sichtbar bleiben.
function fmtPrice(n, decimals) {
  const v = Number(n);
  let d = decimals;
  if (d == null) {
    const abs = Math.abs(v);
    d = abs > 0 && abs < 1 ? Math.min(12, Math.max(6, Math.ceil(-Math.log10(abs)) + 4)) : 6;
  } else {
    d = Math.max(d, 6);
  }
  return v.toFixed(d).replace('.', ',');
}
// Alias (fmtPrice liefert inzwischen selbst das Dezimalkomma, z. B. 0,019280)
function fmtPriceComma(n, decimals) {
  return fmtPrice(n, decimals);
}
// Preis für Eingabefelder: Tick-Genauigkeit des Symbols, Dezimalkomma
function priceToInput(n, decimals) {
  return Number(n).toFixed(decimals ?? 6).replace('.', ',');
}
// Zahl aus Eingabefeld lesen: akzeptiert Komma und Punkt als Dezimaltrennzeichen
function parseNum(v) {
  const t = String(v ?? '').trim().replace(/[\s'’]/g, '').replace(',', '.');
  return t === '' ? NaN : Number(t);
}
function colorize(node, n) {
  node.classList.toggle('pos', n > 0);
  node.classList.toggle('neg', n < 0);
}
function fmtDate(ms) {
  return new Date(ms).toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' });
}

// ---------- ATR, Walk-Forward-Folds, Prüfintervall ----------

// Average True Range (Wilder-Glättung) auf Kerzen mit .high/.low/.close.
function computeATR(candles, period = 14) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  if (!trs.length) return 0;
  if (trs.length <= period) return trs.reduce((a, b) => a + b, 0) / trs.length;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

// Teilt Kerzen in aufeinanderfolgende, nicht überlappende Zeitfenster für Walk-Forward-Tests.
function splitIntoFolds(candles, foldCount) {
  const foldSize = Math.floor(candles.length / foldCount);
  if (foldCount <= 1 || foldSize < 10) return [candles];
  const folds = [];
  for (let i = 0; i < foldCount; i++) {
    const start = i * foldSize;
    const end = i === foldCount - 1 ? candles.length : start + foldSize;
    folds.push(candles.slice(start, end));
  }
  return folds;
}

// Grid-Range aus tatsächlichem Kursverlauf (Support/Resistance) statt symmetrisch um den
// aktuellen Kurs gespiegelt: untere/obere Grenze = tailPct-Perzentil der Low/High-Werte im
// Fenster. Deckt automatisch ≥ (100-2*tailPct)% der realisierten Kursbewegung ab (Literatur-
// Richtwert: Range soll ≥80% der Zeit abdecken) und liefert von Natur aus asymmetrische
// Abstände zum aktuellen Kurs, weil Kursverteilungen selten symmetrisch sind — z. B. nach einem
// Pump liegt der aktuelle Kurs näher an der oberen als an der unteren Grenze.
// anchorPrice (optional): Start-/aktueller Kurs des Fensters. Liegt dieser über der Resistance
// (bzw. unter dem Support) oder weniger als einen Grid-Abstand davon entfernt (z. B. nach einem
// frischen Pump/Dump), hätte das Grid auf dieser Seite keine einzige Order-Stufe und würde beim
// nächsten Schritt in diese Richtung sofort die Range verlassen. Dann wird die nächsthöhere
// beobachtete Resistance (99. Perzentil = breiteste geprüfte Stufe) bzw. der nächsttiefere
// Support verwendet; mindestens aber ein Grid-Abstand (2%, Obergrenze des Literatur-Bands) Luft.
// atr/atrMult (optional, Tages-ATR in Preiseinheiten und Faktor k): Grenzen aus der Volatilität
// wie bei Bitget ("Upper limit = market price + ATR, lower limit = market price − ATR"):
// - Obere Grenze: Gibt es über dem Kurs keinen Widerstand (Kurs am Hoch des Fensters, z. B. nach
//   einem Anstieg), wird sie auf Kurs + k·ATR gesetzt statt fix auf +2%.
// - Untere Grenze: höchstens k·ATR unter dem Kurs, damit nach einem starken Anstieg keine
//   Grenzen bei veralteten, weit tiefer liegenden Kursen entstehen (z. B. −70%).
// Ohne atr/atrMult (Coin Scanner) bleibt die Berechnung wie bisher.
const RANGE_MIN_HEADROOM = 0.02;
const RANGE_OUTER_TAIL_PCT = 1;
function computeSwingRange(candles, tailPct, anchorPrice, { atr = null, atrMult = null } = {}) {
  const lows = candles.map((c) => c.low).sort((a, b) => a - b);
  const highs = candles.map((c) => c.high).sort((a, b) => a - b);
  const lowAt = (p) => lows[Math.min(lows.length - 1, Math.floor(lows.length * p / 100))];
  const highAt = (p) => highs[Math.max(0, Math.ceil(highs.length * (1 - p / 100)) - 1)];
  let rlow = lowAt(tailPct), rhigh = highAt(tailPct);
  let upperSource = 'resistance', lowerSource = 'support';
  if (anchorPrice != null) {
    const minHigh = anchorPrice * (1 + RANGE_MIN_HEADROOM);
    const maxLow = anchorPrice * (1 - RANGE_MIN_HEADROOM);
    const useAtr = atr > 0 && atrMult > 0;
    if (rhigh < minHigh) {
      const outer = highAt(RANGE_OUTER_TAIL_PCT);
      if (useAtr) {
        const atrHigh = anchorPrice + atrMult * atr;
        rhigh = Math.max(minHigh, outer, atrHigh);
        upperSource = rhigh === outer ? 'outer' : 'atr';
      } else {
        rhigh = Math.max(minHigh, outer);
        upperSource = rhigh === outer ? 'outer' : 'headroom';
      }
    }
    if (rlow > maxLow) {
      rlow = Math.min(maxLow, lowAt(RANGE_OUTER_TAIL_PCT));
      lowerSource = rlow < maxLow ? 'outer' : 'headroom';
    }
    if (useAtr) {
      const atrLow = anchorPrice - atrMult * atr;
      if (atrLow > rlow) {
        rlow = Math.min(maxLow, atrLow);
        lowerSource = 'atr';
      }
    }
  }
  return { rlow, rhigh, upperSource, lowerSource };
}

// Tages-ATR (Wilder, 14 Tage) in Preiseinheiten aus Kerzen beliebiger Länge (Bitget: ATR aus
// einer langen Zeiteinheit statt aus der Handels-Zeiteinheit).
function dailyATR(candles, period = 14) {
  return computeATR(scToDaily(candles), period);
}

// Heuristische Prüfintervall-Empfehlung: höhere Volatilität = engmaschiger prüfen.
function recommendCheckInterval(volPct) {
  if (volPct > 40) return 'Täglich';
  if (volPct > 25) return 'Alle 2–3 Tage';
  if (volPct > 12) return 'Wöchentlich';
  return 'Alle 1–2 Wochen';
}

// ============================================================
// TAB 1: ANALYSE & OPTIMIERUNG
// ============================================================

let anCandles500 = null;
let anChosenSymbol = null;
let anLastOptResult = null; // für "Als Bot ins Monitoring übernehmen"
let anSuitEv = null; // Marktphase aus der Eignungsprüfung (für die Grid-Modus-Empfehlung)
let anQuickRec = null; // für "Backtesting" (Übernahme der Eignungsprüfungs-Empfehlung in Tab 2)

function assessSuitability(candles) {
  const closes = candles.map((c) => c.close);
  const returns = [];
  for (let i = 1; i < closes.length; i++) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
  const vol = std(returns) * Math.sqrt(candles.length);
  const low = Math.min(...candles.map((c) => c.low));
  const high = Math.max(...candles.map((c) => c.high));
  const rangePct = (high - low) / low * 100;
  const netDrift = Math.abs(closes[closes.length - 1] - closes[0]) / closes[0] * 100;
  const driftRatio = rangePct > 0 ? netDrift / rangePct : 0;

  let verdict, cls;
  if (rangePct < 4) {
    verdict = 'Ungeeignet: Die Preisspanne ist sehr eng, zu wenig Bewegung für profitable Grid-Trades.';
    cls = 'bad';
  } else if (driftRatio > 0.65) {
    verdict = 'Eher ungeeignet: Starker Trend statt Seitwärtsbewegung – Grid-Bots laufen bei Trends Gefahr, gegen die Richtung zu handeln.';
    cls = 'bad';
  } else if (driftRatio > 0.4) {
    verdict = 'Bedingt geeignet: Moderater Trend vorhanden.';
    cls = 'warn';
  } else {
    verdict = 'Gut geeignet: Ausreichend Volatilität bei überwiegend seitwärts gerichteter Bewegung.';
    cls = 'good';
  }
  return { verdict, cls, rangePct, vol: vol * 100, netDrift, driftRatio, low, high };
}

function verdictLabel(cls) {
  return cls === 'good' ? 'Gut geeignet' : cls === 'warn' ? 'Bedingt geeignet' : 'Ungeeignet';
}

// ---------- Grid-Simulation (eine Engine für Backtest, Optimierung und Scanner) ----------

// Grid-Modi wie beim Binance Spot Grid. Ohne Angabe gilt überall 'geometric' (Scanner, alte Bots).
const GRID_MODES = { geometric: 'Geometrisch', arithmetic: 'Arithmetisch' };
function gridModeLabel(mode) {
  return GRID_MODES[mode] || GRID_MODES.geometric;
}

// Preisstufen wie beim Binance Spot Grid:
// - geometrisch: jede Stufe liegt um denselben Faktor über der vorherigen (gleicher prozentualer
//   Abstand), L_i = lower · (upper/lower)^(i/grids)
// - arithmetisch: jede Stufe liegt um denselben Betrag über der vorherigen (gleicher Preisabstand),
//   L_i = lower + i · (upper − lower)/grids
function gridLevels(lower, upper, grids, mode = 'geometric') {
  const levels = [lower];
  if (mode === 'arithmetic') {
    const step = (upper - lower) / grids;
    for (let i = 1; i < grids; i++) levels.push(lower + step * i);
  } else {
    const ratio = Math.pow(upper / lower, 1 / grids);
    for (let i = 1; i < grids; i++) levels.push(lower * Math.pow(ratio, i));
  }
  levels.push(upper);
  return levels;
}

// Gewinn pro Grid nach Gebühren, geometrisch (Binance-FAQ "Spot Grid Trading Parameters"):
// (1 − c) · (upper/lower)^(1/grids) − 1 − c
function gridProfitPerGridPct(lower, upper, grids) {
  return ((1 - FEE) * Math.pow(upper / lower, 1 / grids) - 1 - FEE) * 100;
}

// Gewinn pro Grid nach Gebühren als Spanne {min, max} (Binance-FAQ "Spot Grid Trading Parameters"):
// - geometrisch: für alle Grids gleich (siehe gridProfitPerGridPct)
// - arithmetisch: gleicher Preisabstand, daher prozentual unten am grössten, oben am kleinsten:
//   max = (1 − c) · (lower + step)/lower − 1 − c, min = (1 − c) · upper/(upper − step) − 1 − c
function gridProfitPerGridRange(lower, upper, grids, mode = 'geometric') {
  if (mode === 'arithmetic') {
    const step = (upper - lower) / grids;
    return {
      min: ((1 - FEE) * upper / (upper - step) - 1 - FEE) * 100,
      max: ((1 - FEE) * (lower + step) / lower - 1 - FEE) * 100,
    };
  }
  const p = gridProfitPerGridPct(lower, upper, grids);
  return { min: p, max: p };
}

// Anzahl Grids, damit der Abstand pro Grid (upper/lower)^(1/n) − 1 ungefähr `spacing` beträgt
function gridCountForSpacing(lower, upper, spacing) {
  return Math.log(upper / lower) / Math.log(1 + spacing);
}

// Zulässige Grid-Anzahl {lo, hi}, damit der prozentuale Abstand JEDES Grids im Band
// [minSpacing, maxSpacing] liegt. Geometrisch ist der Abstand überall gleich. Arithmetisch ist er
// unten am grössten (step/lower ≤ maxSpacing) und oben am kleinsten (step/(upper − step) ≥ minSpacing).
function gridCountBand(lower, upper, minSpacing, maxSpacing, mode = 'geometric') {
  if (mode === 'arithmetic') {
    return {
      lo: (upper - lower) / (lower * maxSpacing),
      hi: (upper - lower) * (1 + minSpacing) / (upper * minSpacing),
    };
  }
  return { lo: gridCountForSpacing(lower, upper, maxSpacing), hi: gridCountForSpacing(lower, upper, minSpacing) };
}

// Pfadbasierte Simulation eines Binance Spot Grids (geometrisch oder arithmetisch, siehe gridLevels):
// - Alle Orders haben dieselbe Menge q ("Qty Per Order").
// - Start: Die Stufe, die dem Startkurs am nächsten liegt, bleibt frei; darunter stehen
//   Kauforders, darüber Verkaufsorders. Die Base für die Verkaufsorders wird zum Startkurs
//   gekauft (startPrice, sonst Eröffnungskurs der ersten Kerze).
// - Jede Kerze wird als Pfad Open → Low → High → Close (grüne Kerze) bzw. Open → High → Low →
//   Close (rote Kerze) abgelaufen; eine Order wird ausgeführt, sobald der Pfad ihre Stufe erreicht.
// - Nach einem Kauf auf Stufe i steht die Verkaufsorder auf Stufe i+1 und umgekehrt. Ein
//   Verkauf schliesst ein Kauf-/Verkaufspaar ab (= "Trade" bei Binance) und realisiert den
//   Grid-Gewinn q · (L_i+1 − L_i) abzüglich beider Gebühren.
// - Stop-Loss / Take-Profit (Preise): bei Berührung wird der Bot beendet und der ganze
//   Bestand zum Auslösepreis verkauft.
function simulateGrid(candles, { lower, upper, grids, investment, stopLoss = null, takeProfit = null, startPrice = null, recordCurve = false, mode = 'geometric' }) {
  const levels = gridLevels(lower, upper, grids, mode);
  const p0 = startPrice || candles[0].o;

  let skip = 0;
  for (let j = 1; j <= grids; j++) if (Math.abs(levels[j] - p0) < Math.abs(levels[skip] - p0)) skip = j;
  // holding[i] = true: Grid i hält q Base, Verkaufsorder auf levels[i+1]; false: Kauforder auf levels[i]
  const holding = new Array(grids);
  let nSell = 0, buyCost = 0;
  for (let i = 0; i < grids; i++) {
    holding[i] = i >= skip;
    if (holding[i]) nSell++;
    else buyCost += levels[i];
  }

  const q = investment / ((nSell * p0 + buyCost) * (1 + FEE));

  let quote = investment;
  let base = 0;
  let fees = 0;
  let realized = 0;
  let buys = 0, sells = 0;
  let initialBuyCost = 0;

  if (nSell > 0) {
    const cost = nSell * q * p0;
    const fee = cost * FEE;
    quote -= cost + fee;
    base += nSell * q;
    fees += fee;
    initialBuyCost = cost;
  }
  const startBase = base; // Startbestand nach dem Startkauf (Basis für "Durch Kursbewegung")

  // Anzahl Stufen < x bzw. ≤ x (binäre Suche), damit pro Bewegung nur die gekreuzten Stufen geprüft werden
  const countBelow = (x, orEqual) => {
    let lo = 0, hi = levels.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (levels[mid] < x || (orEqual && levels[mid] === x)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  function move(from, to) {
    if (to < from) {
      // Kauforders auf Stufen mit to ≤ L < from, von oben nach unten
      for (let i = Math.min(grids - 1, countBelow(from, false) - 1); i >= 0 && levels[i] >= to; i--) {
        if (!holding[i]) {
          const cost = q * levels[i], fee = cost * FEE;
          quote -= cost + fee;
          base += q;
          fees += fee;
          buys++;
          holding[i] = true;
        }
      }
    } else if (to > from) {
      // Verkaufsorders auf Stufen mit from < L ≤ to, von unten nach oben
      for (let i = Math.max(0, countBelow(from, true) - 1); i < grids && levels[i + 1] <= to; i++) {
        if (holding[i]) {
          const L = levels[i + 1];
          const proceeds = q * L, fee = proceeds * FEE;
          quote += proceeds - fee;
          base -= q;
          fees += fee;
          sells++;
          realized += q * (L - levels[i]) - fee - q * levels[i] * FEE;
          holding[i] = false;
        }
      }
    }
  }

  let stopped = false, stopReason = null, stopPrice = null, stopTime = null, used = 0;
  let outOfRange = 0;
  let peakEquity = investment, maxDrawdownPct = 0;
  const curve = [];
  let prev = p0;
  for (const k of candles) {
    used++;
    const path = k.c >= k.o ? [k.o, k.l, k.h, k.c] : [k.o, k.h, k.l, k.c];
    for (const to of path) {
      let trigger = null;
      if (stopLoss && to <= stopLoss) trigger = ['Stop-Loss', Math.min(stopLoss, prev)];
      else if (takeProfit && to >= takeProfit) trigger = ['Take-Profit', Math.max(takeProfit, prev)];
      if (trigger) {
        move(prev, trigger[1]);
        stopped = true; stopReason = trigger[0]; stopPrice = trigger[1]; stopTime = k.t;
        break;
      }
      move(prev, to);
      prev = to;
    }
    if (stopped) break;
    if (k.c < lower || k.c > upper) outOfRange++;
    const equity = quote + base * k.c;
    if (equity > peakEquity) peakEquity = equity;
    const dd = (peakEquity - equity) / peakEquity * 100;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    if (recordCurve) curve.push({ time: k.t, profitPct: (equity - investment) / investment * 100 });
  }
  if (stopped && base > 0) {
    const proceeds = base * stopPrice, fee = proceeds * FEE;
    quote += proceeds - fee;
    fees += fee;
    base = 0;
  }
  if (stopped && recordCurve) curve.push({ time: stopTime, profitPct: (quote - investment) / investment * 100 });

  const last = stopped ? stopPrice : candles[candles.length - 1].c;
  const finalValue = quote + base * last;
  const total = finalValue - investment;
  // Aufteilung des Gesamtgewinns (exakt, die beiden Teile ergeben immer total):
  // - Kursbewegung: Wertänderung des Startbestands, als hätte der Bot nie gehandelt
  // - Grid-Trading: alles Übrige (Grid-Abstände, Wertänderung der vom Grid nachgekauften bzw.
  //   verkauften Coins, Gebühren) = Mehr-/Minderwert gegenüber dem Startbestand ohne Handel
  const marketPnl = startBase * (last - p0);
  const gridPnl = total - marketPnl;
  // Vergleich Buy & Hold: ganzes Investment zum Startpreis in Base (inkl. Kaufgebühr)
  const hodlPnl = investment * (1 - FEE) / p0 * last - investment;

  let minPrice = Infinity, maxPrice = -Infinity;
  for (let i = 0; i < used; i++) {
    if (candles[i].l < minPrice) minPrice = candles[i].l;
    if (candles[i].h > maxPrice) maxPrice = candles[i].h;
  }

  return {
    levels, skip, q, p0, last, quote, base, fees, realized, buys, sells, trades: sells, initialBuyCost,
    finalValue, total, unrealized: total - realized,
    startBase, marketPnl, gridPnl, hodlPnl,
    outOfRangePct: (outOfRange / used) * 100,
    minPrice, maxPrice, used, maxDrawdownPct, curve,
    stopped, stopReason, stopPrice, stopTime,
    priceChangePct: (candles[candles.length - 1].c - p0) / p0 * 100,
  };
}

// Kennzahlen für Optimierung und Scanner in Prozent des Investments.
// slPct/tpPct: Abstand in % unter der unteren bzw. über der oberen Grenze. Binance verlangt
// Stop-Loss < untere Grenze und Take-Profit > obere Grenze (Spot-Grid-FAQ).
// mode: 'geometric' (Standard, u. a. Scanner) oder 'arithmetic'
function optBacktest(candles, gridCount, low, high, slPct, tpPct, investment = 1000, recordCurve = false, mode = 'geometric') {
  const stopLossPrice = slPct ? low * (1 - slPct / 100) : null;
  const takeProfitPrice = tpPct ? high * (1 + tpPct / 100) : null;
  const r = simulateGrid(candles, {
    lower: low, upper: high, grids: gridCount, investment,
    stopLoss: stopLossPrice, takeProfit: takeProfitPrice, recordCurve, mode,
  });
  return {
    profitPct: r.total / investment * 100,
    stopped: r.stopped, stopReason: r.stopReason,
    gridProfitPct: r.realized / investment * 100,
    floatingPLPct: r.unrealized / investment * 100,
    maxDrawdownPct: r.maxDrawdownPct,
    bhProfitPct: (r.last - r.p0) / r.p0 * 100,
    stopLossPrice, takeProfitPrice,
    periodStart: candles[0].time, periodEnd: candles[r.used - 1].time,
    curve: r.curve, tradeCount: r.trades,
  };
}

// Walk-Forward-Optimierung: Parameter (Grid-Abstand, Range-Breite, SL/TP) werden über mehrere
// aufeinanderfolgende Zeitfenster (Folds) getestet statt nur auf einem einzigen Fenster.
// Echter Walk-Forward: Die Range für ein Test-Fenster wird nur aus den Kursen VOR dem Fenster
// berechnet (wachsendes Trainingsfenster, Anker = letzter bekannter Kurs) — genau wie bei der
// Live-Empfehlung, die nur die Vergangenheit kennt. Das erste Fenster dient nur als Training.
// Score je Kandidat = 0.6×Durchschnitt + 0.4×schlechtestes Fold-Ergebnis, damit nur Parameter
// gewinnen, die über mehrere Marktphasen hinweg konsistent funktionieren (statt nur im Gesamtfenster
// überangepasst zu sein). Grid-Grenzen werden aus dem tatsächlichen Kursverlauf (Support/
// Resistance per Perzentil, siehe computeSwingRange) abgeleitet statt symmetrisch um den
// aktuellen Kurs gespiegelt — robuster gegen einzelne Ausreißer-Kerzen und spiegelt reale,
// von Natur aus oft asymmetrische Kursverteilungen wider.
function walkForwardOptimize(candles, { useSL = true, useTP = true, investment = 1000, mode = 'geometric' } = {}) {
  const currentPrice = candles[candles.length - 1].close;
  // tailPcts: wie viel Prozent der Extremwerte je Seite als Ausreißer ignoriert werden, bevor
  // Support/Resistance aus dem Kursverlauf abgeleitet wird (siehe computeSwingRange). Kleiner
  // Wert = breitere Range (mehr Historie abgedeckt), großer Wert = engere, aggressivere Range.
  const tailPcts = [1, 2, 3, 5, 7, 10, 15, 20];
  // k-Faktoren für die ATR-Grenzen (siehe computeSwingRange): Kurs ± k × Tages-ATR
  const atrMults = [2, 3, 5];
  // SL: % unter der unteren Grenze, TP: % über der oberen Grenze (siehe optBacktest)
  const slOptions = useSL ? [null, 2, 3, 5, 8, 12] : [null];
  const tpOptions = useTP ? [null, 3, 5, 10, 15, 25] : [null];

  // Grid-Abstand wird auf das in der Literatur empfohlene Band begrenzt (Binance: 0.5–2% Gewinn
  // pro Grid; Bitget: mind. 0.5% Gewinn pro Grid NACH Gebühren; Gainium: 0.5–1%). Untergrenze =
  // 0.5% netto + Round-Trip-Fee, Obergrenze = 2%. Grund: Ein reiner Profit-Backtest bevorzugt
  // systematisch sehr wenige, weite Grids (wenige grosse Schwünge, kaum Gebühren) — das Ergebnis
  // hängt dann an sehr wenigen Trades und ist entsprechend fragil. Innerhalb des Bandes
  // entscheidet weiterhin der Walk-Forward-Test über den konkreten Abstand.
  const MIN_SPACING_PCT = 0.005 + FEE * 2;
  const MAX_SPACING_PCT = 0.02;
  const MAX_GRIDS = 149; // Binance-Limit für Spot-Grid
  // Kandidat ist eine Position im Abstands-Band (0 = weitester Abstand 2%, 1 = engster 0,7%),
  // nicht eine feste Grid-Anzahl: Jedes Test-Fenster hat seine eigene Range, und dieselbe
  // Grid-Anzahl ergäbe dort einen ganz anderen Abstand als bei der Live-Range. Deshalb wird die
  // Grid-Anzahl pro Range aus derselben Band-Position berechnet – getestet wird so genau der
  // Abstand, der später empfohlen wird. 6 Stützstellen, geometrisch über das Band verteilt.
  const BAND_STEPS = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const gridCountAt = (rlow, rhigh, t) => {
    const band = gridCountBand(rlow, rhigh, MIN_SPACING_PCT, MAX_SPACING_PCT, mode);
    const gcMin = Math.min(MAX_GRIDS, Math.max(2, Math.ceil(band.lo)));
    const gcMax = Math.min(MAX_GRIDS, Math.max(gcMin, Math.floor(band.hi)));
    return Math.round(gcMin * Math.pow(gcMax / gcMin, t));
  };

  // Fold-Anzahl und Mindest-Trades sind in 4h-Äquivalenten definiert, damit sie unabhängig
  // vom Kerzenintervall (Optimierung läuft auf 1h-Kerzen) dieselbe Zeitspanne bedeuten.
  const barMs = candles.length > 1 ? candles[1].time - candles[0].time : 4 * 3600000;
  const len4h = candles.length * barMs / (4 * 3600000);
  const foldCount = len4h >= 300 ? 4 : len4h >= 150 ? 3 : len4h >= 60 ? 2 : 1;
  // foldCount Test-Fenster + 1 vorangestelltes Trainingsfenster
  const segments = splitIntoFolds(candles, foldCount + 1);
  const folds = [];
  if (segments.length > 1) {
    let offset = segments[0].length;
    for (let i = 1; i < segments.length; i++) {
      folds.push({ train: candles.slice(0, offset), test: segments[i] });
      offset += segments[i].length;
    }
  } else {
    const half = Math.floor(candles.length / 2);
    folds.push({ train: candles.slice(0, half), test: candles.slice(half) });
  }
  folds.forEach((f) => { f.atr = dailyATR(f.train); f.anchor = f.train[f.train.length - 1].close; });
  const liveAtr = dailyATR(candles);
  // Mindest-Handelsaktivität je Fenster, sonst gewinnen zu breite/wenige Grids nur, weil sie
  // kaum traden und dadurch "robust" (wenig Drawdown/Varianz) aussehen, aber das Ziel
  // "viele Trades, gute Gewinne" verfehlen.
  // (abgeschlossene Kauf-/Verkaufspaare wie bei Binance, nicht Einzelorders)
  const minTradesPerFold = Math.max(2, Math.round(len4h / (folds.length + 1) / 80));

  const candidates = [];
  const seenRanges = new Set();
  for (const tpc of tailPcts) for (const k of atrMults) {
    const foldRanges = folds.map((f) => (f.train.length < 10 || f.test.length < 10 ? null
      : computeSwingRange(f.train, tpc, f.anchor, { atr: f.atr, atrMult: k })));
    const liveRange = computeSwingRange(candles, tpc, currentPrice, { atr: liveAtr, atrMult: k });
    // Verschiedene tailPct/k ergeben oft dieselben Grenzen (z. B. wenn die ATR-Grenze greift) – nur einmal testen
    const key = [liveRange, ...foldRanges].map((r) => (r ? r.rlow + '/' + r.rhigh : '-')).join('|');
    if (seenRanges.has(key)) continue;
    seenRanges.add(key);
    const seenGc = new Set();
    for (const t of BAND_STEPS) {
      const gc = gridCountAt(liveRange.rlow, liveRange.rhigh, t);
      // Enge Live-Range: mehrere Band-Positionen ergeben dieselbe Grid-Anzahl – nur einmal testen
      if (seenGc.has(gc)) continue;
      seenGc.add(gc);
      for (const sl of slOptions) {
        for (const tp of tpOptions) {
          const scores = [];
          const tradeCounts = [];
          let slHits = 0, tpHits = 0;
          for (let i = 0; i < folds.length; i++) {
            const fold = folds[i].test;
            const range = foldRanges[i];
            if (!range) continue;
            const { rlow, rhigh } = range;
            if (rlow <= 0) continue;
            const res = optBacktest(fold, gridCountAt(rlow, rhigh, t), rlow, rhigh, sl, tp, investment, false, mode);
            if (res.stopReason === 'Stop-Loss') slHits++;
            if (res.stopReason === 'Take-Profit') tpHits++;
            scores.push(res.profitPct - res.maxDrawdownPct * 0.3);
            tradeCounts.push(res.tradeCount);
          }
          if (!scores.length) continue;
          const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
          const worst = Math.min(...scores);
          const robustScore = scores.length > 1 ? mean * 0.6 + worst * 0.4 : mean;
          const avgTrades = tradeCounts.reduce((a, b) => a + b, 0) / tradeCounts.length;
          candidates.push({ gc, tpc, k, sl, tp, robustScore, mean, worst, avgTrades, validatedFolds: scores.length, slHits, tpHits });
        }
      }
    }
  }
  if (!candidates.length) return null;

  const active = candidates.filter((c) => c.avgTrades >= minTradesPerFold);
  const pool = active.length ? active : candidates;
  const best = pool.reduce((a, b) => (b.robustScore > a.robustScore ? b : a));

  const { rlow, rhigh, upperSource, lowerSource } = computeSwingRange(candles, best.tpc, currentPrice, { atr: liveAtr, atrMult: best.k });
  // Simulation über den Gesamtzeitraum; SL/TP-Preise hängen an den empfohlenen Grenzen
  const full = optBacktest(candles, best.gc, rlow, rhigh, best.sl, best.tp, investment, true, mode);
  return {
    ...full,
    mode,
    slHits: best.slHits, tpHits: best.tpHits,
    gc: best.gc, rlow, rhigh, sl: best.sl, tp: best.tp,
    tailPct: best.tpc, atrMult: best.k, atr: liveAtr, upperSource, lowerSource, robustScore: best.robustScore,
    foldMean: best.mean, foldWorst: best.worst, validatedFolds: best.validatedFolds,
    avgTradesPerFold: best.avgTrades, minTradesPerFold,
    currentPrice,
  };
}

// Order-Mindestvorgaben eines Symbols direkt bei Binance abfragen (NOTIONAL bzw. altes
// MIN_NOTIONAL = Mindest-Orderwert in Quote, LOT_SIZE = Mindestmenge + Mengenschritt).
async function fetchOrderLimits(symbol) {
  const info = await apiGet('/api/v3/exchangeInfo', { symbol });
  const f = info.symbols[0].filters;
  const notional = f.find((x) => x.filterType === 'NOTIONAL') || f.find((x) => x.filterType === 'MIN_NOTIONAL');
  const lot = f.find((x) => x.filterType === 'LOT_SIZE');
  return {
    minNotional: notional ? +notional.minNotional : 0,
    minQty: lot ? +lot.minQty : 0,
    stepSize: lot ? +lot.stepSize : 0,
  };
}

// Mindestinvest wie beim Binance Spot Grid (geometrisch oder arithmetisch, siehe gridLevels):
// - Binance setzt für alle Orders dieselbe Menge Q ("Qty Per Order"). Die Kauforder auf dem
//   untersten Level hat den kleinsten Orderwert, deshalb muss Q · rlow ≥ minNotional · 1,1 sein
//   (notional buffer 1,1), Q ≥ minQty, und Q wird auf stepSize aufgerundet.
// - Gebundenes Kapital (Binance FAQ "Spot Grid Trading Parameters"):
//   Quote = Summe der Kauf-Levelpreise · Q, Base = Anzahl Sell-Orders · Q (zum aktuellen Preis
//   gekauft). Auf dem Level, das dem aktuellen Preis am nächsten liegt, steht keine Order.
// - Plus Reserve für Gebühren und Rundung: / (1 − 0,05) (buffer1 aus der Binance-Formel
//   für Trailing Up).
// Nachgerechnet: HUMA 15 Grids 0,01928–0,02675 = 102,68 und BABY 16 Grids 0,01018–0,01350 =
// 106,14 USDT bei Binance werden im Kursband der letzten Stunden getroffen.
const MIN_INV_NOTIONAL_BUFFER = 1.1;
const MIN_INV_RESERVE = 0.05;
function computeMinInvestment(gc, rlow, rhigh, price, limits, mode = 'geometric') {
  const step = limits.stepSize || 0;
  let qty = Math.max(limits.minNotional * MIN_INV_NOTIONAL_BUFFER / rlow, limits.minQty);
  if (step > 0) qty = Math.ceil(qty / step - 1e-9) * step;
  const levels = gridLevels(rlow, rhigh, gc, mode);
  let skip = 0;
  levels.forEach((l, i) => { if (Math.abs(l - price) < Math.abs(levels[skip] - price)) skip = i; });
  let capital = 0;
  levels.forEach((l, i) => { if (i !== skip) capital += qty * Math.min(l, price); });
  const total = capital / (1 - MIN_INV_RESERVE);
  return { qty, perGrid: total / gc, total: Math.ceil(total) };
}

const OPT_SPAN_MS =1000 * 4 * 3600000; // Optimierungs-Zeitraum: ~166 Tage

// Empfehlung Grid-Modus (Arithmetisch vs. Geometrisch). Die Literatur nennt keine Formel, aber
// übereinstimmende Kriterien:
// - Range-Breite: Bei engen Ranges (< 10%) sind beide Modi praktisch identisch, ab ~30% Breite ist
//   Geometrisch vorzuziehen (Coinstream). Arithmetisch passt zu engen, Geometrisch zu breiten
//   Ranges (Gainium, Mobee, BigONE, TradingCopilot). Grund: Arithmetisch ist der Gewinn pro Grid in %
//   unten um den Faktor upper/lower grösser als oben; Geometrisch ist er überall gleich.
// - Marktphase: Arithmetisch für stabile/seitwärts laufende Märkte, Geometrisch für Trends und hohe
//   Volatilität (Gainium, Mobee, 3Commas). Gemessen mit denselben Schwellen wie im Coin Scanner:
//   ADX > 25 bzw. Efficiency Ratio > 0,4 = Trend, ATR > 8% pro Tag = sehr volatil.
// Arithmetisch nur, wenn beide Kriterien dafür sprechen; sonst Geometrisch (Binance-Standard).
const GRID_MODE_WIDE_RANGE = 0.30;
function recommendGridMode(rlow, rhigh, ev) {
  const width = rhigh / rlow - 1;
  const w = (width * 100).toFixed(1).replace('.', ',');
  if (width >= GRID_MODE_WIDE_RANGE) {
    return { mode: 'geometric', reason: `Breite Range (${w}% ≥ 30%): Geometrisch hält den Gewinn pro Grid in % über die ganze Range gleich. Arithmetisch wäre er an der unteren Grenze ${(rhigh / rlow).toFixed(2).replace('.', ',')}-mal so hoch wie an der oberen.` };
  }
  if (ev) {
    const trend = [];
    if (ev.adx > 25) trend.push(`ADX ${ev.adx.toFixed(0)} > 25`);
    if (ev.er > 0.4) trend.push(`Efficiency Ratio ${ev.er.toFixed(2).replace('.', ',')} > 0,4`);
    if (trend.length) return { mode: 'geometric', reason: `Trendmarkt (${trend.join(', ')}): Für trendende Märkte wird Geometrisch empfohlen, weil die Grids prozentual mitskalieren.` };
    if (ev.atrPct > 8) return { mode: 'geometric', reason: `Sehr volatil (ATR ${ev.atrPct.toFixed(1).replace('.', ',')}% pro Tag > 8%): Bei hoher Volatilität wird Geometrisch empfohlen.` };
    return { mode: 'arithmetic', reason: `Enge Range (${w}% < 30%) und Seitwärtsmarkt (ADX ${ev.adx.toFixed(0)} ≤ 25, Efficiency Ratio ${ev.er.toFixed(2).replace('.', ',')} ≤ 0,4, ATR ${ev.atrPct.toFixed(1).replace('.', ',')}% ≤ 8%): Arithmetisch passt zu engen Ranges in stabilen Märkten – jedes Grid bringt denselben Betrag.` };
  }
  return { mode: 'geometric', reason: `Marktphase nicht bestimmbar (zu wenig Historie) – Geometrisch als Binance-Standard.` };
}

// Walk-Forward-Optimierung im empfohlenen Grid-Modus. Die Range hängt von der Optimierung ab,
// deshalb zuerst geometrisch optimieren, dann den Modus anhand der gefundenen Range und der
// Marktphase (ev aus evaluateSuitability) bestimmen. Bei "Arithmetisch" wird arithmetisch neu
// optimiert und die Empfehlung mit der neuen Range bestätigt.
function optimizeWithMode(candles, ev, opts = {}) {
  const geo = walkForwardOptimize(candles, { ...opts, mode: 'geometric' });
  if (!geo) return null;
  const choice = recommendGridMode(geo.rlow, geo.rhigh, ev);
  if (choice.mode === 'arithmetic') {
    const ari = walkForwardOptimize(candles, { ...opts, mode: 'arithmetic' });
    if (ari) {
      const check = recommendGridMode(ari.rlow, ari.rhigh, ev);
      if (check.mode === 'arithmetic') return { ...ari, modeReason: check.reason };
    }
  }
  return { ...geo, modeReason: choice.reason };
}

function optRecommendGridParams(candles, ev, investment = 1000) {
  return optimizeWithMode(candles, ev, { useSL: true, useTP: true, investment });
}

// Herkunft der Grenzen: Support/Resistance aus dem Kursverlauf oder Kurs ± k × Tages-ATR
function anRangeSourceText(r) {
  const atrTxt = `${r.atrMult} × Tages-ATR`;
  const cover = (t) => `${(100 - t * 2).toFixed(0)}% der Kursbewegung abgedeckt`;
  const lower = {
    atr: `Kurs − ${atrTxt} (Support läge tiefer)`,
    outer: `Support am Tief des Zeitraums (${cover(RANGE_OUTER_TAIL_PCT)})`,
    headroom: 'Kurs − 2% (ein Grid-Abstand, kein Support unter dem Kurs)',
  }[r.lowerSource] || `Support (${cover(r.tailPct)})`;
  const upper = {
    atr: `Kurs + ${atrTxt} (kein Widerstand über dem Kurs)`,
    outer: `Resistance am Hoch des Zeitraums (${cover(RANGE_OUTER_TAIL_PCT)})`,
    headroom: 'Kurs + 2% (ein Grid-Abstand, kein Widerstand über dem Kurs)',
  }[r.upperSource] || `Resistance (${cover(r.tailPct)})`;
  return `Untere Grenze: ${lower}<br>Obere Grenze: ${upper}`;
}

// Tabellenzeile "Grid-Modus" für die Empfehlungen im Analyse-Tab
function anModeRow(label, rec) {
  return `<tr><td>${label}</td><td><b>${gridModeLabel(rec.mode)}</b></td></tr>`;
}

function anDrawProfitChart(curve) {
  if (!curve.length) return '';
  const w = 680, h = 200, pad = 30;
  const vals = curve.map((p) => p.profitPct);
  const minV = Math.min(0, ...vals), maxV = Math.max(0, ...vals);
  const range = (maxV - minV) || 1;
  const x = (i) => pad + i / (curve.length - 1 || 1) * (w - 2 * pad);
  const y = (v) => h - pad - (v - minV) / range * (h - 2 * pad);
  const path = curve.map((p, i) => (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ',' + y(p.profitPct).toFixed(1)).join(' ');
  const zeroY = y(0).toFixed(1);
  const last = vals[vals.length - 1];
  const color = last >= 0 ? '#3ecf8e' : '#ff6161';
  return `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;background:#0c0f13;border:1px solid #262c35;border-radius:10px;margin-top:8px">
      <line x1="${pad}" y1="${zeroY}" x2="${w - pad}" y2="${zeroY}" stroke="#3a4150" stroke-dasharray="4 4"/>
      <path d="${path}" fill="none" stroke="${color}" stroke-width="2"/>
      <text x="${pad}" y="16" fill="#9aa3af" font-size="11">${maxV.toFixed(1)}%</text>
      <text x="${pad}" y="${h - 8}" fill="#9aa3af" font-size="11">${minV.toFixed(1)}%</text>
    </svg>`;
}

function anFmtDate(ts) {
  return new Date(ts).toLocaleDateString('de-DE', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

// Datum + optionale Uhrzeit (lokale Zeit) -> Millisekunden.
// Ohne Uhrzeit wird exakt wie bisher gerechnet (fallbackTime bestimmt das bisherige Verhalten).
function dateTimeToMs(dateStr, timeStr, fallbackTime = 'T00:00:00') {
  if (!dateStr) return NaN;
  if (timeStr) return new Date(`${dateStr}T${timeStr}`).getTime();
  return new Date(fallbackTime == null ? dateStr : dateStr + fallbackTime).getTime();
}

// Startempfehlung eines Paares (Tab "Analyse & Optimierung", auch Spalte "Mindestinvest" im Coin Scanner):
// Eignung auf 500 4h-Kerzen, Grid-Empfehlung per Walk-Forward auf 1h-Kerzen, Mindestinvest aus den
// Binance-Ordervorgaben. rec.minInvest = null, wenn die Ordervorgaben nicht geladen werden konnten.
async function anComputeStartRec(symbol, onStatus = () => {}) {
  onStatus('Lade historische Daten …');
  const candles = await fetchKlines(symbol, '4h', { limit: 500 }); // ~83 Tage
  const a = evaluateSuitability(candles);
  onStatus('Suche verlässliche Startparameter …');
  // Grid-Empfehlung auf 1h-Kerzen über denselben Zeitraum: 4h-Kerzen unterschätzen die
  // Trades enger Grids stark (max. ein Fill je Level und Kerze).
  const opt1h = await loadKlinesRange(symbol, '1h', candles[0].time, Date.now(), () => {});
  const rec = optRecommendGridParams(opt1h, a.ev);
  let price = opt1h[opt1h.length - 1].close;
  try {
    const limits = await fetchOrderLimits(symbol);
    try { price = +(await apiGet('/api/v3/ticker/price', { symbol })).price || price; } catch (e) { /* letzte Kerze */ }
    rec.minInvest = computeMinInvestment(rec.gc, rec.rlow, rec.rhigh, price, limits, rec.mode);
  } catch (e) {
    rec.minInvest = null;
  }
  return { candles, a, opt1h, rec, price };
}

function initAnalyseTab() {
  const pairInput = $('an-pair');
  const checkBtn = $('an-checkBtn');
  const loadStatus = $('an-loadStatus');

  checkBtn.addEventListener('click', async () => {
    anChosenSymbol = pairInput.value.toUpperCase();
    checkBtn.disabled = true;
    loadStatus.textContent = 'Lade historische Daten …';
    try {
      const { candles, a, rec, price } = await anComputeStartRec(anChosenSymbol, (t) => { loadStatus.textContent = t; });
      anCandles500 = candles;
      anSuitEv = a.ev;
      const symDec = symbolMap.get(anChosenSymbol);
      const pd = symDec ? symDec.decimals : null;
      const quote = symDec ? symDec.quote : '';
      const minInvRow = rec.minInvest
        ? `<b>${fmt(rec.minInvest.total, 0)} ${quote}</b>`
        : 'Nicht verfügbar (Binance-Ordervorgaben konnten nicht geladen werden)';
      // Betrag pro Grid: Mindestinvest gleichmässig auf die Grids verteilt
      const perGridRow = rec.minInvest
        ? `${fmt(rec.minInvest.total / rec.gc, 2)} ${quote} <span class="status">(${fmt(rec.minInvest.total, 0)} ${quote} Mindestinvest ÷ ${rec.gc} Grids)</span>`
        : 'Nicht verfügbar (Mindestinvest unbekannt)';
      const spanRow = `${fmtPriceComma(rec.rhigh - rec.rlow, pd)} ${quote} <span class="status">(+${fmt((rec.rhigh / rec.rlow - 1) * 100, 1)} % von der unteren zur oberen Grenze)</span>`;
      const whyRow = a.ev ? { ...a.ev, symbol: anChosenSymbol, base: symDec ? symDec.base : anChosenSymbol, quote, ratedAt: Date.now() } : null;
      $('an-verdictBox').innerHTML = `<div class="verdict ${a.cls}${whyRow ? ' verdict-why' : ''}"><span>${a.verdict}</span>${whyRow ? '<button type="button" class="secondary small" id="an-whyBtn">Einstufung anzeigen</button>' : ''}</div>`;
      if (whyRow) $('an-whyBtn').addEventListener('click', () => scShowWhy(whyRow, { fromAnalyse: true }));
      const ev = a.ev;
      $('an-metricsBox').innerHTML = (ev ? `
        <div class="metric"><div class="k">Score (wie Coin Scanner)</div><div class="v">${ev.score} / 100</div></div>
        <div class="metric"><div class="k">ADX (Tage) · &lt;20 seitwärts, &gt;25 Trend</div><div class="v">${ev.adx.toFixed(0)}</div></div>
        <div class="metric"><div class="k">Choppiness · &gt;61.8 seitwärts</div><div class="v">${ev.chop.toFixed(0)}</div></div>
        <div class="metric"><div class="k">Efficiency Ratio · &gt;0.4 Trend</div><div class="v">${ev.er.toFixed(2)}</div></div>
        <div class="metric"><div class="k">ATR pro Tag</div><div class="v">${ev.atrPct.toFixed(1)}%</div></div>
        <div class="metric"><div class="k">Grid-Simulation (83 Tage)</div><div class="v">${ev.gridProfit.toFixed(1)}%</div></div>
      ` : '') + `
        <div class="metric"><div class="k">Preisspanne (83 Tage)</div><div class="v">${a.rangePct.toFixed(1)}%</div></div>
        <div class="metric"><div class="k">Volatilität</div><div class="v">${a.vol.toFixed(1)}%</div></div>
        <div class="metric"><div class="k">Netto-Drift</div><div class="v">${a.netDrift.toFixed(1)}%</div></div>
        <div class="metric"><div class="k">Trend-Anteil</div><div class="v">${(a.driftRatio * 100).toFixed(0)}%</div></div>
      `;
      $('an-recBox').innerHTML = `
        <h4 style="margin:16px 0 6px">Empfehlung für einen Start zum Zeitpunkt dieser Prüfung</h4>
        <p class="sub" style="margin:0 0 8px">Aktueller Kurs: ${fmtPrice(rec.currentPrice, pd)} — das Grid ist um diesen Kurs herum aufgespannt.</p>
        <table class="details">
          ${anModeRow('Empfohlener Grid-Modus', rec)}
          <tr><td>Empfohlene Grid-Anzahl</td><td><b>${rec.gc}</b></td></tr>
          <tr><td>Empfohlene untere Grenze</td><td>${fmtPriceComma(rec.rlow, pd)} ${anDistText(rec.rlow, rec.currentPrice)}</td></tr>
          <tr><td>Empfohlene obere Grenze</td><td>${fmtPriceComma(rec.rhigh, pd)} ${anDistText(rec.rhigh, rec.currentPrice)}</td></tr>
          <tr><td>Spannweite</td><td>${spanRow}</td></tr>
          <tr><td>Gewinn pro Grid (nach Gebühren)</td><td>${btProfitPerGridText(rec.rlow, rec.rhigh, rec.gc, rec.mode, quote, pd)}</td></tr>
          <tr><td>Empfohlener Mindestinvest</td><td>${minInvRow}</td></tr>
          <tr><td>Betrag pro Grid</td><td>${perGridRow}</td></tr>
          <tr><td>Stop-Loss empfohlen?</td><td>${rec.sl ? 'Ja, ' + anSlTpText(rec, 'sl', pd) + anStopPnlText(rec, 'sl', price, quote) : 'Nein, aufgrund der Analyse nicht nötig'}</td></tr>
          <tr><td>Take-Profit empfohlen?</td><td>${rec.tp ? 'Ja, ' + anSlTpText(rec, 'tp', pd) + anStopPnlText(rec, 'tp', price, quote) : 'Nein, aufgrund der Analyse nicht nötig'}</td></tr>
          <tr><td>Empfohlenes Prüfintervall</td><td>${recommendCheckInterval(a.vol)}</td></tr>
          <tr><td>Handelsaktivität (Walk-Forward)</td><td>Ø ${rec.avgTradesPerFold.toFixed(1)} abgeschlossene Trades je Zeitfenster (Mindestanforderung: ${rec.minTradesPerFold})</td></tr>
        </table>
        ${rec.sl || rec.tp ? anSlTpNote(rec) : ''}
      `;
      anQuickRec = rec;
      $('an-verdictCard').classList.remove('hidden');
      $('an-optCard').classList.add('hidden');
      $('an-resultCard').classList.add('hidden');
      loadStatus.textContent = '';
    } catch (e) {
      console.error(e);
      loadStatus.textContent = 'Fehler: ' + e.message;
    }
    checkBtn.disabled = false;
  });

  $('an-abortBtn').addEventListener('click', () => {
    $('an-verdictCard').classList.add('hidden');
  });

  $('an-continueBtn').addEventListener('click', () => {
    $('an-optCard').classList.remove('hidden');
  });

  $('an-monitorBtn').addEventListener('click', async () => {
    if (!anQuickRec || !anChosenSymbol) return;
    const sym = symbolMap.get(anChosenSymbol);
    if (!sym) return;
    document.querySelector('.tab-btn[data-tab="monitor"]').click();
    await moPrefillForm({
      symbol: anChosenSymbol, grids: anQuickRec.gc, lower: anQuickRec.rlow, upper: anQuickRec.rhigh, mode: anQuickRec.mode,
      stopLoss: anQuickRec.sl ? anQuickRec.stopLossPrice : null,
      takeProfit: anQuickRec.tp ? anQuickRec.takeProfitPrice : null,
    });
  });

  $('an-backtestBtn').addEventListener('click', async () => {
    if (!anQuickRec || !anChosenSymbol) return;
    const sym = symbolMap.get(anChosenSymbol);
    if (!sym) return;
    document.querySelector('.tab-btn[data-tab="backtest"]').click();
    $('bt-quote').value = sym.quote;
    btFillSymbolSelect();
    $('bt-symbol').value = anChosenSymbol;
    await btOnSymbolChange();
    $('bt-lower').value = priceToInput(anQuickRec.rlow, sym.decimals);
    $('bt-upper').value = priceToInput(anQuickRec.rhigh, sym.decimals);
    $('bt-grids').value = anQuickRec.gc;
    $('bt-mode').value = anQuickRec.mode || 'geometric';
    if (anQuickRec.minInvest) $('bt-investment').value = anQuickRec.minInvest.total;
    $('bt-sl').value = anQuickRec.sl && anQuickRec.stopLossPrice ? priceToInput(anQuickRec.stopLossPrice, sym.decimals) : '';
    $('bt-tp').value = anQuickRec.tp && anQuickRec.takeProfitPrice ? priceToInput(anQuickRec.takeProfitPrice, sym.decimals) : '';
    // Wie "Analysieren" im Coin Scanner: direkt starten
    $('bt-form').requestSubmit();
  });

  $('an-optimizeBtn').addEventListener('click', async () => {
    const optStatus = $('an-optStatus');
    optStatus.textContent = 'Lade Daten & simuliere …';
    $('an-optimizeBtn').disabled = true;

    const fromDate = $('an-fromDate').value;
    const fromTime = $('an-fromTime').value;
    let candles;
    try {
      if (fromDate) {
        // Ohne Uhrzeit: wie bisher new Date(fromDate) (UTC-Mitternacht)
        // Gleiche maximale Zeitspanne wie bisher (1000 × 4h ≈ 166 Tage), aber in 1h-Auflösung
        const start = dateTimeToMs(fromDate, fromTime, null);
        candles = await loadKlinesRange(anChosenSymbol, '1h', start, Math.min(Date.now(), start + OPT_SPAN_MS), () => {});
      } else {
        candles = await loadKlinesRange(anChosenSymbol, '1h', Date.now() - OPT_SPAN_MS, Date.now(), () => {}); // ~166 Tage
      }
    } catch (e) {
      optStatus.textContent = 'Fehler beim Laden der Daten';
      $('an-optimizeBtn').disabled = false; return;
    }

    const useSL = $('an-slToggle').checked;
    const useTP = $('an-tpToggle').checked;

    const best = optimizeWithMode(candles, anSuitEv, { useSL, useTP, investment: 1000 });
    const bestWithCurve = best;

    optStatus.textContent = '';
    $('an-optimizeBtn').disabled = false;
    const rb = $('an-resultBox');
    const col = (v) => (v >= 0 ? '#3ecf8e' : '#ff6161');

    const days = Math.round((best.periodEnd - best.periodStart) / 86400000);
    const periodText = fromDate
      ? (fromTime
        ? `${fmtDate(best.periodStart)} bis ${fmtDate(best.periodEnd)} (Startzeitpunkt ausgewählt)`
        : `${anFmtDate(best.periodStart)} bis ${anFmtDate(best.periodEnd)} (Startzeitpunkt ausgewählt)`)
      : `${anFmtDate(best.periodStart)} bis ${anFmtDate(best.periodEnd)} — Zeitspanne von ca. ${days} Tagen (kein Startzeitpunkt gewählt, es wurde eine ausreichend grosse Datenmenge verwendet)`;

    const optNowPrice = anCandles500 ? anCandles500[anCandles500.length - 1].close : candles[candles.length - 1].close;
    rb.innerHTML = `
      <table class="details">
        ${anModeRow('Grid-Modus', best)}
        <tr><td>Anzahl Grids</td><td><b>${best.gc}</b></td></tr>
        <tr><td>Untere Grenze</td><td>${fmtPriceComma(best.rlow, symbolMap.get(anChosenSymbol)?.decimals)} ${anDistText(best.rlow, optNowPrice)}</td></tr>
        <tr><td>Obere Grenze</td><td>${fmtPriceComma(best.rhigh, symbolMap.get(anChosenSymbol)?.decimals)} ${anDistText(best.rhigh, optNowPrice)}</td></tr>
        <tr><td>Stop-Loss</td><td>${best.sl ? anSlTpText({ ...best, currentPrice: optNowPrice }, 'sl', symbolMap.get(anChosenSymbol)?.decimals) : '–'}</td></tr>
        <tr><td>Take-Profit</td><td>${best.tp ? anSlTpText({ ...best, currentPrice: optNowPrice }, 'tp', symbolMap.get(anChosenSymbol)?.decimals) : '–'}</td></tr>
        <tr><td>Range-Quelle</td><td>${anRangeSourceText(best)}</td></tr>
        <tr><td>Walk-Forward-Fenster geprüft</td><td>${best.validatedFolds} (Ø ${best.foldMean.toFixed(2)}%, schlechtestes ${best.foldWorst.toFixed(2)}%)</td></tr>
        <tr><td>Handelsaktivität (Walk-Forward)</td><td>Ø ${best.avgTradesPerFold.toFixed(1)} abgeschlossene Trades je Zeitfenster (Mindestanforderung: ${best.minTradesPerFold})</td></tr>
      </table>
      ${best.sl || best.tp ? anSlTpNote(best) : ''}
      <h4 style="margin:16px 0 6px">Ergebnis${best.stopped ? ' (beendet durch ' + best.stopReason + ')' : ''}</h4>
      <p class="sub" style="margin:0 0 8px">Zeitraum: ${periodText}</p>
      <table class="details">
        <tr><td>Grid-Gewinn (realisiert)</td><td style="color:${col(best.gridProfitPct)}">${best.gridProfitPct.toFixed(2)}%</td></tr>
        <tr><td>Floating Gewinn/Verlust (offene Positionen)</td><td style="color:${col(best.floatingPLPct)}">${best.floatingPLPct.toFixed(2)}%</td></tr>
        <tr><td><b>Gesamt-Gewinn</b></td><td><b style="color:${col(best.profitPct)}">${best.profitPct.toFixed(2)}%</b></td></tr>
        <tr><td>Max. Drawdown</td><td style="color:var(--bad)">${best.maxDrawdownPct.toFixed(2)}%</td></tr>
        <tr><td>Buy &amp; Hold zum Vergleich</td><td style="color:${col(best.bhProfitPct)}">${best.bhProfitPct.toFixed(2)}%</td></tr>
        <tr><td>Grid-Bot vs. Buy &amp; Hold</td><td style="color:${col(best.profitPct - best.bhProfitPct)}">${(best.profitPct - best.bhProfitPct >= 0 ? '+' : '')}${(best.profitPct - best.bhProfitPct).toFixed(2)} Prozentpunkte</td></tr>
      </table>
      <p class="sub" style="margin-top:10px">Simulation eines ${best.mode === 'arithmetic' ? 'arithmetischen' : 'geometrischen'} Grids wie bei Binance (gleiche Menge pro Order, 0.1% Gebühr) auf historischen 1h-Kerzen. Keine Anlageberatung, keine Garantie für zukünftige Performance.</p>
      <h4 style="margin:16px 0 6px">Gewinnverlauf</h4>
      ${anDrawProfitChart(bestWithCurve.curve)}
    `;
    $('an-resultCard').classList.remove('hidden');

    anLastOptResult = { symbol: anChosenSymbol, mode: best.mode, gc: best.gc, rlow: best.rlow, rhigh: best.rhigh,
      stopLoss: best.sl ? best.stopLossPrice : null, takeProfit: best.tp ? best.takeProfitPrice : null, currentPrice: anCandles500 ? anCandles500[anCandles500.length - 1].close : best.rlow };
  });

  $('an-toMonitorBtn').addEventListener('click', () => {
    if (!anLastOptResult) return;
    const today = new Date().toISOString().slice(0, 10);
    addBot({
      symbol: anLastOptResult.symbol,
      grids: anLastOptResult.gc,
      mode: anLastOptResult.mode,
      lower: anLastOptResult.rlow,
      upper: anLastOptResult.rhigh,
      stopLoss: anLastOptResult.stopLoss,
      takeProfit: anLastOptResult.takeProfit,
      startPrice: anLastOptResult.currentPrice,
      startDate: today,
    });
    document.querySelector('.tab-btn[data-tab="monitor"]').click();
  });
}

// ============================================================
// TAB 2: BACKTEST
// ============================================================

function btFillSymbolSelect() {
  fillPairSelect($('bt-quote'), $('bt-symbol'));
  if ($('bt-symbol').value) btOnSymbolChange();
}

async function btOnSymbolChange() {
  const sym = symbolMap.get($('bt-symbol').value);
  if (!sym) return;
  $('bt-price').value = '…';
  try {
    const t = await apiGet('/api/v3/ticker/price', { symbol: sym.symbol });
    if ($('bt-symbol').value !== sym.symbol) return;
    const p = parseFloat(t.price);
    $('bt-price').value = priceToInput(p, sym.decimals);
    $('bt-lower').value = priceToInput(p * 0.9, sym.decimals);
    $('bt-upper').value = priceToInput(p * 1.1, sym.decimals);
  } catch (e) {
    $('bt-price').value = '–';
  }
}

const TREND = {
  up: { label: 'Aufwärtstrend', cls: 'pos' },
  down: { label: 'Abwärtstrend', cls: 'neg' },
  flat: { label: 'Seitwärtstrend', cls: 'flat' },
};

function linReg(ys) {
  const n = ys.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += ys[i]; sxx += i * i; sxy += i * ys[i]; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept, start: intercept, end: intercept + slope * (n - 1) };
}

function periodVolatility(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(r.length - 1, 1);
  return Math.sqrt(v) * Math.sqrt(r.length) * 100;
}

function classify(changePct, volPct) {
  const thr = Math.max(3, 0.5 * volPct);
  if (changePct > thr) return 'up';
  if (changePct < -thr) return 'down';
  return 'flat';
}

function pastTrend(candles) {
  const closes = candles.map((k) => k.c);
  const fit = linReg(closes);
  const regChange = ((fit.end - fit.start) / fit.start) * 100;
  const rawChange = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
  const vol = periodVolatility(closes);
  return { dir: classify(regChange, vol), regChange, rawChange, vol };
}

function futureTrend(context, startTime) {
  const closes = context.map((k) => k.c);
  const nSpan = context.filter((k) => k.t >= startTime).length;
  if (nSpan < 5 || closes.length < 5) return null;
  const last = closes[closes.length - 1];
  const vol = periodVolatility(closes.slice(-nSpan));
  const signals = [];

  const fitS = linReg(closes.slice(-nSpan));
  const projS = (fitS.slope * nSpan / last) * 100;
  signals.push({ name: `Regression kurz (${nSpan} Kerzen), fortgeschrieben`, value: projS, dir: classify(projS, vol) });

  const fitL = linReg(closes);
  const projL = (fitL.slope * nSpan / last) * 100;
  signals.push({ name: `Regression lang (${closes.length} Kerzen), fortgeschrieben`, value: projL, dir: classify(projL, vol) });

  const sma = (n) => closes.slice(-n).reduce((a, b) => a + b, 0) / Math.min(n, closes.length);
  const dS = ((last - sma(nSpan)) / sma(nSpan)) * 100;
  signals.push({ name: 'Preis vs. Durchschnitt (1× Zeitraum)', value: dS, dir: classify(dS, vol) });
  if (closes.length >= 2 * nSpan) {
    const dL = ((last - sma(2 * nSpan)) / sma(2 * nSpan)) * 100;
    signals.push({ name: 'Preis vs. Durchschnitt (2× Zeitraum)', value: dL, dir: classify(dL, vol) });
  }

  const half = Math.floor(nSpan / 2);
  const a = closes.slice(-nSpan, -half), b = closes.slice(-half);
  const mA = a.reduce((x, y) => x + y, 0) / a.length, mB = b.reduce((x, y) => x + y, 0) / b.length;
  const mom = ((mB - mA) / mA) * 100;
  signals.push({ name: 'Momentum (2. Hälfte vs. 1. Hälfte)', value: mom, dir: classify(mom, vol) });

  const score = signals.reduce((s, x) => s + (x.dir === 'up' ? 1 : x.dir === 'down' ? -1 : 0), 0);
  const need = Math.ceil(signals.length / 2);
  const dir = score >= need ? 'up' : score <= -need ? 'down' : 'flat';
  const projected = (projS + projL) / 4;
  return { dir, projected, score, signals, vol };
}

function spanLabel(ms) {
  const days = ms / 86400000;
  if (days < 2) return `${Math.round(days * 24)} Stunden`;
  if (days < 14) return `${Math.round(days)} Tage`;
  if (days < 60) return `${(days / 7).toFixed(1).replace(/\.0$/, '')} Wochen`;
  if (days < 730) return `${(days / 30.44).toFixed(1).replace(/\.0$/, '')} Monate`;
  return `${(days / 365.25).toFixed(1).replace(/\.0$/, '')} Jahre`;
}

function btSetTrend(id, dir) {
  const node = $(id);
  node.textContent = TREND[dir].label;
  node.classList.remove('pos', 'neg', 'flat');
  node.classList.add(TREND[dir].cls);
}

function btRenderTrend(past, future, span) {
  btSetTrend('bt-t-past', past.dir);
  $('bt-t-past-sub').textContent =
    `Regression ${signed(past.regChange)} % · Start→Ende ${signed(past.rawChange)} % · Volatilität ${fmt(past.vol, 1)} %`;

  $('bt-t-future-label').textContent = `Ausblick (nächste ${spanLabel(span)})`;
  if (!future) {
    $('bt-t-future').textContent = '–';
    $('bt-t-future').className = 'kpi-value';
    $('bt-t-future-sub').textContent = 'Zu wenig Kursdaten für einen Ausblick.';
    $('bt-t-signals').innerHTML = '';
    return;
  }
  btSetTrend('bt-t-future', future.dir);
  $('bt-t-future-sub').textContent =
    `Projizierte Veränderung ≈ ${signed(future.projected, 1)} % · Signal-Score ${future.score > 0 ? '+' : ''}${future.score} von ±${future.signals.length}`;
  $('bt-t-signals').innerHTML = future.signals
    .map((s) => `<tr><td>${s.name}</td><td><span class="${TREND[s.dir].cls}">${TREND[s.dir].label}</span> (${signed(s.value, 1)} %)</td></tr>`)
    .join('');
}

function btShowError(msg) {
  $('bt-error').textContent = msg;
  $('bt-error').hidden = !msg;
}
function btSetStatus(msg) {
  $('bt-status').textContent = msg;
}

// Geometrisch: ein Wert für alle Grids; Arithmetisch: Spanne von oberstem bis unterstem Grid
function btProfitPerGridText(lower, upper, grids, mode, q, d) {
  const p = gridProfitPerGridRange(lower, upper, grids, mode);
  if (mode === 'arithmetic') {
    return `${fmt(p.min, 2)} – ${fmt(p.max, 2)} % <span class="status">(Abstand ${fmtPrice((upper - lower) / grids, d)} ${q} pro Grid; oben am wenigsten, unten am meisten)</span>`;
  }
  return `${fmt(p.min, 2)} % <span class="status">(Abstand ${fmt((Math.pow(upper / lower, 1 / grids) - 1) * 100, 2)} % pro Grid)</span>`;
}

function btRenderResults(r, ctx) {
  const { sym, candles, interval, investment, lower, upper, grids, stopLoss, takeProfit, botStart, mode } = ctx;
  const q = sym.quote, b = sym.base, d = sym.decimals;
  // Bei Stop-Loss/Take-Profit läuft der Bot nur bis zum Auslösezeitpunkt
  const days = ((r.stopped ? r.stopTime : candles[candles.length - 1].t) - candles[0].t) / 86400000;
  const pct = (r.total / investment) * 100;

  $('bt-summary').textContent =
    `${b}/${q} · ${fmtDate(candles[0].t)} – ${fmtDate(candles[candles.length - 1].t)} · ` +
    `${candles.length} Kerzen (${interval}) · Range ${fmtPrice(lower, d)} – ${fmtPrice(upper, d)} · ${grids} Grids ${gridModeLabel(mode).toLowerCase()}`;

  $('bt-r-total').textContent = `${signed(r.total)} ${q}`;
  colorize($('bt-r-total'), r.total);
  $('bt-r-total-pct').textContent = `${signed(pct)} % auf ${fmt(investment)} ${q}`;
  $('bt-r-trades').textContent = r.trades;
  $('bt-r-trades-sub').textContent = `${r.buys} Käufe · ${r.sells} Verkäufe` + (r.initialBuyCost ? ' · + 1 Startkauf' : '');
  $('bt-r-realized').textContent = `${signed(r.realized)} ${q}`;
  colorize($('bt-r-realized'), r.realized);
  $('bt-r-unrealized').textContent = `${signed(r.unrealized)} ${q}`;
  colorize($('bt-r-unrealized'), r.unrealized);
  $('bt-r-fees').textContent = `${fmt(r.fees)} ${q}`;
  $('bt-r-perday').textContent = days > 0 ? `${signed(r.total / days)} ${q} (${signed(pct / days, 3)} %)` : '–';
  colorize($('bt-r-perday'), r.total);

  // Woher kommt der Gewinn?
  $('bt-r-market').textContent = `${signed(r.marketPnl)} ${q}`;
  colorize($('bt-r-market'), r.marketPnl);
  $('bt-r-market-sub').textContent =
    `${signed(r.marketPnl / investment * 100)} % · Startbestand ${fmt(r.startBase, 6)} ${b}, Kurs ${fmtPrice(r.p0, d)} → ${fmtPrice(r.last, d)}`;
  $('bt-r-grid').textContent = `${signed(r.gridPnl)} ${q}`;
  colorize($('bt-r-grid'), r.gridPnl);
  $('bt-r-grid-sub').textContent = `${signed(r.gridPnl / investment * 100)} % · Mehr-/Minderwert gegenüber Startbestand ohne Handel`;

  const vsHodl = r.total - r.hodlPnl;
  $('bt-r-vshodl').textContent = `${signed(vsHodl)} ${q}`;
  colorize($('bt-r-vshodl'), vsHodl);
  $('bt-r-vshodl-sub').textContent = `Buy & Hold: ${signed(r.hodlPnl)} ${q} (${signed(r.hodlPnl / investment * 100)} %)`;

  const rows = [
    ['Grid-Modus', gridModeLabel(mode)],
    ['Gewinn pro Grid (nach Gebühren)', btProfitPerGridText(lower, upper, grids, mode, q, d)],
    ['Menge pro Order', `${fmt(r.q, 6)} ${b}`],
    ['Startpreis', `${fmtPrice(r.p0, d)} ${q}${botStart ? ' <span class="status">(Startkurs des hinterlegten Bots)</span>' : ''}`],
    ['Stop-Loss / Take-Profit', `${stopLoss ? fmtPrice(stopLoss, d) : '–'} / ${takeProfit ? fmtPrice(takeProfit, d) : '–'} ${q}`],
    ['Bot beendet durch', r.stopped ? `<b>${r.stopReason}</b> am ${fmtDate(r.stopTime)} zu ${fmtPrice(r.stopPrice, d)} ${q} (Bestand verkauft)` : '–'],
    ['Endpreis', `${fmtPrice(r.last, d)} ${q}`],
    ['Tief / Hoch im Zeitraum', `${fmtPrice(r.minPrice, d)} / ${fmtPrice(r.maxPrice, d)} ${q}`],
    ['Kursveränderung im Zeitraum', `<span class="${r.priceChangePct >= 0 ? 'pos' : 'neg'}">${signed(r.priceChangePct)} %</span> <span class="status">(${fmtPrice(r.p0, d)} → ${fmtPrice(candles[candles.length - 1].c, d)} ${q})</span>`],
    ['Startkauf (Bestand für Sell-Orders)', r.initialBuyCost ? `${fmt(r.initialBuyCost)} ${q}` : '–'],
    ['Endbestand', `${fmt(r.quote)} ${q} + ${fmt(r.base, 6)} ${b}`],
    ['Endwert (zum Endpreis)', `${fmt(r.finalValue)} ${q}`],
    ['Kerzen ausserhalb der Range', `${fmt(r.outOfRangePct, 1)} %`],
    ['Zeitraum', `${fmt(days, 1)} Tage`],
  ];
  $('bt-details').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');

  btDrawChart(candles, r.levels, lower, upper, stopLoss, takeProfit);
  btDrawProfitChart([{ time: candles[0].t, profitPct: 0 }, ...r.curve]);
  $('bt-results').classList.remove('hidden');
  $('bt-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// stopLoss/takeProfit (optional): als gestrichelte Linien eingezeichnet
function btDrawChart(candles, levels, lower, upper, stopLoss = null, takeProfit = null) {
  const c = $('bt-chart');
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height, pad = { l: 70, r: 12, t: 12, b: 24 };
  ctx.clearRect(0, 0, W, H);

  const closes = candles.map((k) => k.c);
  let min = lower, max = upper;
  for (const p of closes) { if (p < min) min = p; if (p > max) max = p; }
  if (stopLoss && stopLoss < min) min = stopLoss;
  if (takeProfit && takeProfit > max) max = takeProfit;
  const rawMin = min, rawMax = max;
  const m = (max - min) * 0.05 || 1;
  min -= m; max += m;

  const x = (i) => pad.l + (i / (candles.length - 1)) * (W - pad.l - pad.r);
  const y = (p) => pad.t + (1 - (p - min) / (max - min)) * (H - pad.t - pad.b);

  ctx.fillStyle = 'rgba(79,157,255,0.10)';
  ctx.fillRect(pad.l, y(upper), W - pad.l - pad.r, y(lower) - y(upper));

  ctx.strokeStyle = 'rgba(79,157,255,0.35)';
  ctx.lineWidth = 1;
  for (const L of levels) {
    ctx.beginPath(); ctx.moveTo(pad.l, y(L)); ctx.lineTo(W - pad.r, y(L)); ctx.stroke();
  }

  // Stop-Loss / Take-Profit als gestrichelte Linien
  const stops = [[stopLoss, '#ff6161', 'SL'], [takeProfit, '#3ecf8e', 'TP']].filter(([p]) => p);
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  for (const [p, color] of stops) {
    ctx.strokeStyle = color;
    ctx.beginPath(); ctx.moveTo(pad.l, y(p)); ctx.lineTo(W - pad.r, y(p)); ctx.stroke();
  }
  ctx.setLineDash([]);

  ctx.strokeStyle = '#e7e9ec';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  closes.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p)) : ctx.moveTo(x(i), y(p))));
  ctx.stroke();

  ctx.fillStyle = '#9aa3af';
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'right';
  const d = max > 100 ? 0 : max > 1 ? 2 : 5;
  // Tiefst-/Höchstwert der Achse nur beschriften, wenn er nicht der SL/TP ist (die sind rechts beschriftet)
  const labelPrices = [lower, upper];
  if (!stopLoss || stopLoss > rawMin) labelPrices.push(rawMin);
  if (!takeProfit || takeProfit < rawMax) labelPrices.push(rawMax);
  for (const p of labelPrices) {
    ctx.fillText(p.toFixed(d).replace('.', ','), pad.l - 6, y(p) + 4);
  }
  // Beschriftung rechts über der Linie, z. B. "SL 103,46"
  ctx.textAlign = 'right';
  for (const [p, color, label] of stops) {
    ctx.fillStyle = color;
    ctx.fillText(`${label} ${p.toFixed(d).replace('.', ',')}`, W - pad.r - 4, y(p) - 5);
  }
  ctx.fillStyle = '#9aa3af';
  ctx.textAlign = 'left';
  ctx.fillText(new Date(candles[0].t).toLocaleDateString('de-CH'), pad.l, H - 6);
  ctx.textAlign = 'right';
  ctx.fillText(new Date(candles[candles.length - 1].t).toLocaleDateString('de-CH'), W - pad.r, H - 6);
}

// Gewinnverlauf des Grid-Bots in % des Investments
function btDrawProfitChart(curve) {
  const c = $('bt-profitChart');
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height, pad = { l: 70, r: 12, t: 14, b: 24 };
  ctx.clearRect(0, 0, W, H);
  if (curve.length < 2) return;

  let min = 0, max = 0;
  for (const p of curve) { if (p.profitPct < min) min = p.profitPct; if (p.profitPct > max) max = p.profitPct; }
  const m = (max - min) * 0.08 || 1;
  min -= m; max += m;

  const x = (i) => pad.l + (i / (curve.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);

  // Hilfslinien in "schönen" Schritten
  const raw = (max - min) / 5;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const step = (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * pow;
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#9aa3af';
  ctx.strokeStyle = '#262c35';
  ctx.lineWidth = 1;
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) {
    const val = Math.abs(v) < step / 1e6 ? 0 : v;
    ctx.beginPath(); ctx.moveTo(pad.l, y(val)); ctx.lineTo(W - pad.r, y(val)); ctx.stroke();
    ctx.fillText(`${signed(val, step < 1 ? 1 : 0)} %`, pad.l - 6, y(val) + 4);
  }
  ctx.strokeStyle = '#6b7380';
  ctx.beginPath(); ctx.moveTo(pad.l, y(0)); ctx.lineTo(W - pad.r, y(0)); ctx.stroke();

  ctx.strokeStyle = '#4f9dff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  curve.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.profitPct)) : ctx.moveTo(x(i), y(p.profitPct))));
  ctx.stroke();

  ctx.fillStyle = '#9aa3af';
  ctx.textAlign = 'left';
  ctx.fillText(new Date(curve[0].time).toLocaleDateString('de-CH'), pad.l, H - 6);
  ctx.textAlign = 'right';
  ctx.fillText(new Date(curve[curve.length - 1].time).toLocaleDateString('de-CH'), W - pad.r, H - 6);
}

async function btOnSubmit(ev) {
  ev.preventDefault();
  btShowError('');

  const sym = symbolMap.get($('bt-symbol').value);
  const lower = parseNum($('bt-lower').value);
  const upper = parseNum($('bt-upper').value);
  const grids = parseInt($('bt-grids').value, 10);
  const investment = parseNum($('bt-investment').value);
  const mode = $('bt-mode').value === 'arithmetic' ? 'arithmetic' : 'geometric';
  const startTime = dateTimeToMs($('bt-start').value, $('bt-startTime').value);
  const endTime = Date.now();
  const stopLoss = parseNum($('bt-sl').value) || null;
  const takeProfit = parseNum($('bt-tp').value) || null;

  if (!sym) return btShowError('Bitte ein Währungspaar wählen.');
  if (!(lower > 0) || !(upper > lower)) return btShowError('Obere Preisgrenze muss grösser als die untere sein.');
  if (!(grids >= 2)) return btShowError('Mindestens 2 Grids.');
  if (!(investment > 0)) return btShowError('Investment muss grösser als 0 sein.');
  if (!(startTime < endTime)) return btShowError('Startzeitpunkt muss in der Vergangenheit liegen.');
  // Binance-Regel (Spot-Grid-FAQ): SL unter der unteren, TP über der oberen Grenze
  if (stopLoss && !(stopLoss < lower)) return btShowError('Stop-Loss muss unter der unteren Preisgrenze liegen (Binance-Vorgabe).');
  if (takeProfit && !(takeProfit > upper)) return btShowError('Take-Profit muss über der oberen Preisgrenze liegen (Binance-Vorgabe).');

  const interval = pickInterval((endTime - startTime) / 1000);
  $('bt-run').disabled = true;
  $('bt-results').classList.add('hidden');
  try {
    btSetStatus(`Lade Kerzen (${interval}) …`);
    const candles = await loadKlinesRange(sym.symbol, interval, startTime, endTime, (n) => btSetStatus(`Lade Kerzen (${interval}) … ${n}`));
    if (candles.length < 2) throw new Error('Keine Kursdaten für diesen Zeitraum gefunden.');
    btSetStatus('Simuliere …');
    // Aus dem Monitoring übernommener Bot: echter Startkurs statt Eröffnungskurs der ersten Kerze
    const botStart = btBotStart && btBotStart.symbol === sym.symbol && btBotStart.startTime === startTime ? btBotStart.price : null;
    const result = simulateGrid(candles, { lower, upper, grids, investment, stopLoss, takeProfit, startPrice: botStart, mode, recordCurve: true });
    btRenderResults(result, { sym, candles, interval, investment, lower, upper, grids, stopLoss, takeProfit, botStart, mode });

    const span = endTime - startTime;
    const ctxInterval = pickInterval((3 * span) / 1000);
    btSetStatus(`Lade Trend-Daten (${ctxInterval}) …`);
    let future = null;
    try {
      const context = await loadKlinesRange(sym.symbol, ctxInterval, startTime - 2 * span, endTime, () => {});
      future = futureTrend(context, startTime);
    } catch (e) {
      future = null;
    }
    btRenderTrend(pastTrend(candles), future, span);
    btSetStatus(`Fertig – ${candles.length} Kerzen ausgewertet.`);
  } catch (e) {
    btShowError(`Fehler: ${e.message}`);
    btSetStatus('');
  } finally {
    $('bt-run').disabled = false;
  }
}

function initBacktestTab() {
  // Vorauswahl: genau 1 Kalendermonat vor heute (lokales Datum, z.B. 31.3. → 28./29.2.)
  const localIso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  d.setDate(Math.min(now.getDate(), new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  $('bt-start').value = localIso(d);
  $('bt-start').max = localIso(now);

  fillQuoteSelect($('bt-quote'));
  btFillSymbolSelect();

  $('bt-quote').addEventListener('change', btFillSymbolSelect);
  $('bt-symbol').addEventListener('change', btOnSymbolChange);
  $('bt-form').addEventListener('submit', btOnSubmit);
}

// ============================================================
// TAB 3: BOT-MONITORING (neu)
// ============================================================

const BOTS_KEY = 'gridbot-suite-bots';

function loadBots() {
  try {
    const raw = localStorage.getItem(BOTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}
function saveBots(arr) {
  localStorage.setItem(BOTS_KEY, JSON.stringify(arr));
  moMarkChanged();
}

// Investment wurde erst nachträglich Pflicht: bekannte Beträge der bereits laufenden Bots einmalig nachtragen.
const MO_LEGACY_INVESTMENTS = { GALAUSDT: 81, ASTERUSDT: 68, BONKUSDT: 50, CATIUSDT: 40, SHIBUSDT: 40 };
function moMigrateInvestments() {
  const bots = loadBots();
  let changed = false;
  for (const b of bots) {
    // Grid-Modus wurde erst nachträglich Pflicht: alle bis dahin hinterlegten Bots laufen geometrisch.
    if (!b.mode) { b.mode = 'geometric'; changed = true; }
    if (b.investment == null && MO_LEGACY_INVESTMENTS[b.symbol] != null) {
      b.investment = MO_LEGACY_INVESTMENTS[b.symbol];
      b.quote = 'USDT';
      changed = true;
    }
  }
  if (changed) saveBots(bots);
  const removed = loadRemovedBots();
  let removedChanged = false;
  for (const b of removed) {
    if (!b.mode) { b.mode = 'geometric'; removedChanged = true; }
    // "Anzahl Trades" wurde erst nachträglich Pflicht beim Stoppen: bekannte Werte einmalig nachtragen.
    if (b.trades == null && MO_LEGACY_TRADES[b.symbol] != null) { b.trades = MO_LEGACY_TRADES[b.symbol]; removedChanged = true; }
  }
  if (removedChanged) saveRemovedBots(removed);
}
const MO_LEGACY_TRADES = { GALAUSDT: 4 };

// Spot-Chart eines Paares auf Binance, z. B. BONKUSDT -> https://www.binance.com/en/trade/BONK_USDT?type=spot
// quote: Fallback, solange die Paarliste von Binance noch nicht geladen ist (z. B. gespeichertes Quote-Asset eines Bots)
function binanceTradeUrl(symbol, quote = '') {
  const q = symbolMap.get(symbol)?.quote || (quote && symbol.endsWith(quote) ? quote : '');
  const pair = q ? `${symbol.slice(0, -q.length)}_${q}` : symbol;
  return `https://www.binance.com/en/trade/${encodeURIComponent(pair)}?type=spot`;
}
// Paarname als Link, der den Binance-Chart in einem neuen Tab öffnet
function pairLink(symbol, label = symbol, quote = '') {
  return `<a class="pair-link" href="${binanceTradeUrl(symbol, quote)}" target="_blank" rel="noopener noreferrer" title="Chart auf Binance öffnen">${escapeHtml(label)}</a>`;
}

// Quote-Asset eines Bots (für Einheiten wie "81 USDT"); ältere Einträge haben es nicht gespeichert.
function moBotQuote(b) {
  return b.quote || symbolMap.get(b.symbol)?.quote || '';
}

// Betrag in Quote-Währung: ab 1 mit 2 Nachkommastellen, darunter 3 signifikante Stellen (z. B. 0,000123 BTC)
function moFmtAmount(n) {
  const a = Math.abs(n);
  const str = a >= 1 || a === 0 ? a.toFixed(2) : String(Number(a.toPrecision(3)));
  return str.replace('.', ',');
}

const REMOVED_BOTS_KEY = 'gridbot-suite-bots-removed';

function loadRemovedBots() {
  try {
    const raw = localStorage.getItem(REMOVED_BOTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}
function saveRemovedBots(arr) {
  localStorage.setItem(REMOVED_BOTS_KEY, JSON.stringify(arr));
  moMarkChanged();
}

// ---------- Ablage im App-Verzeichnis (data/bots.json über server.py) ----------
// localStorage bleibt der Arbeitsspeicher der Seite; jede Änderung wird zusätzlich an den lokalen
// Server geschickt, der sie in data/bots.json schreibt. Beim Start gewinnt der neuere Stand:
// Datei (savedAt) oder Browser (Zeitpunkt der letzten lokalen Änderung). Ohne server.py (z. B.
// python -m http.server oder index.html direkt geöffnet) wird nur im Browser gespeichert.
const MO_STORE_URL = 'api/bots';
const MO_LOCAL_SAVED_KEY = 'gridbot-suite-bots-savedAt';
let moStoreAvailable = false;
let moStoreTimer = null;

function moMarkChanged() {
  localStorage.setItem(MO_LOCAL_SAVED_KEY, new Date().toISOString());
  if (!moStoreAvailable) return;
  clearTimeout(moStoreTimer);
  moStoreTimer = setTimeout(moPersistNow, 300);
}

function moSetStoreStatus(text, isError = false) {
  const el = $('mo-storeStatus');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('store-error', isError);
}

function moStorePayload() {
  return JSON.stringify({ bots: loadBots(), removed: loadRemovedBots(), settings: { equityStart: eqLoadStart() } });
}

async function moPersistNow() {
  clearTimeout(moStoreTimer);
  moStoreTimer = null;
  try {
    const res = await fetch(MO_STORE_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: moStorePayload() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const at = new Date().toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    moSetStoreStatus(`Gespeichert im Browser und in data/bots.json (zuletzt ${at}).`);
  } catch (e) {
    moSetStoreStatus(`Speichern in data/bots.json fehlgeschlagen (${e.message}) – Änderungen sind nur im Browser gespeichert.`, true);
  }
}

async function moLoadFromStore() {
  let res;
  try {
    res = await fetch(MO_STORE_URL, { cache: 'no-store' });
  } catch (e) {
    res = null;
  }
  const isApi = res && (res.headers.get('content-type') || '').includes('application/json');
  if (!isApi) {
    moStoreAvailable = false;
    const isLocal = ['localhost', '127.0.0.1', ''].includes(location.hostname);
    moSetStoreStatus(isLocal
      ? 'Nur im Browser gespeichert – App über start.bat starten, damit die Liste auch in data/bots.json im App-Ordner gespeichert wird.'
      : 'Online-Version: Bot-Liste wird nur in diesem Browser gespeichert (nicht zwischen Geräten synchronisiert).', isLocal);
    return;
  }
  moStoreAvailable = true;
  if (res.status === 404) {
    // Noch keine Datei: bisherigen Browser-Stand als Ausgangspunkt ablegen
    await moPersistNow();
    return;
  }
  try {
    if (!res.ok) throw new Error((await res.json()).error || 'HTTP ' + res.status);
    const data = await res.json();
    const localSaved = localStorage.getItem(MO_LOCAL_SAVED_KEY);
    if (localSaved && data.savedAt && new Date(localSaved) > new Date(data.savedAt)) {
      // Browser hat neuere Änderungen (z. B. ohne server.py bearbeitet) -> Datei aktualisieren
      await moPersistNow();
      return;
    }
    localStorage.setItem(BOTS_KEY, JSON.stringify(Array.isArray(data.bots) ? data.bots : []));
    localStorage.setItem(REMOVED_BOTS_KEY, JSON.stringify(Array.isArray(data.removed) ? data.removed : []));
    // Ältere Dateien (oder ein noch nicht neu gestarteter server.py) haben kein Startkapital -> Browser-Wert behalten
    if (data.settings?.equityStart > 0) localStorage.setItem(EQ_START_KEY, String(data.settings.equityStart));
    if (data.savedAt) localStorage.setItem(MO_LOCAL_SAVED_KEY, data.savedAt);
    const at = data.savedAt ? new Date(data.savedAt).toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' }) : '–';
    moSetStoreStatus(`Geladen aus data/bots.json (Stand ${at}), Änderungen werden automatisch dort gespeichert.`);
  } catch (e) {
    moStoreAvailable = false;
    moSetStoreStatus(`data/bots.json konnte nicht gelesen werden (${e.message}) – es wird nur im Browser gespeichert.`, true);
  }
}

// Beim Schliessen noch ausstehende Änderungen sofort senden
window.addEventListener('pagehide', () => {
  if (!moStoreTimer) return;
  clearTimeout(moStoreTimer);
  fetch(MO_STORE_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: moStorePayload(), keepalive: true });
});

// Notizen sind Freitext des Users -> vor dem Einfügen ins HTML escapen.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function moNotePreview(note) {
  if (!note || !note.trim()) return '<span class="note-empty">–</span>';
  const oneLine = note.trim().replace(/\s+/g, ' ');
  return `<span class="note-preview" title="${escapeHtml(note.trim())}">${escapeHtml(oneLine)}</span>`;
}

// Notiz-Dialog: opts = { title, hint, value, required, saveLabel } -> Promise<string|null> (null = abgebrochen)
function moOpenNoteDialog(opts) {
  const dlg = $('mo-noteDialog');
  const text = $('mo-noteText');
  const err = $('mo-noteError');
  $('mo-noteTitle').textContent = opts.title;
  $('mo-noteHint').textContent = opts.hint || '';
  $('mo-noteHint').classList.toggle('hidden', !opts.hint);
  $('mo-noteSave').textContent = opts.saveLabel || 'Speichern';
  $('mo-noteSave').className = opts.danger ? 'danger small' : '';
  text.value = opts.value || '';
  err.classList.add('hidden');
  return new Promise((resolve) => {
    const form = $('mo-noteForm');
    const cleanup = (result) => {
      form.removeEventListener('submit', onSubmit);
      $('mo-noteCancel').removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onCancel);
      dlg.close();
      resolve(result);
    };
    const onSubmit = (e) => {
      e.preventDefault();
      const v = text.value.trim();
      if (opts.required && !v) {
        err.textContent = 'Bitte eine Notiz eingeben – ohne Notiz kann der Bot nicht entfernt werden.';
        err.classList.remove('hidden');
        text.focus();
        return;
      }
      cleanup(v);
    };
    const onCancel = (e) => { if (e) e.preventDefault(); cleanup(null); };
    form.addEventListener('submit', onSubmit);
    $('mo-noteCancel').addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
    text.focus();
  });
}

async function moEditNote(id) {
  const bot = loadBots().find((b) => String(b.id) === id);
  if (!bot) return;
  const note = await moOpenNoteDialog({ title: `Notiz · ${bot.symbol}`, value: bot.note || '' });
  if (note == null) return;
  const bots = loadBots();
  const b = bots.find((x) => String(x.id) === id);
  if (!b) return;
  b.note = note;
  saveBots(bots);
  renderBotList();
}

// Dialog "Bot stoppen": Gewinn/Verlust, Betrag, Anzahl Trades und Notiz sind Pflicht.
// -> Promise<{ removeNote, pnl, trades }|null> (pnl mit Vorzeichen; null = abgebrochen)
function moOpenStopDialog(bot) {
  const dlg = $('mo-stopDialog');
  const err = $('mo-stopError');
  const radios = [...document.querySelectorAll('input[name="mo-pnlSign"]')];
  $('mo-stopTitle').textContent = `${bot.symbol} · Bot stoppen`;
  $('mo-stopUnit').textContent = moBotQuote(bot) || 'Quote-Asset';
  radios.forEach((r) => { r.checked = false; });
  $('mo-stopAmount').value = '';
  $('mo-stopTrades').value = '';
  $('mo-stopNote').value = '';
  err.classList.add('hidden');
  return new Promise((resolve) => {
    const form = $('mo-stopForm');
    const cleanup = (result) => {
      form.removeEventListener('submit', onSubmit);
      $('mo-stopCancel').removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onCancel);
      dlg.close();
      resolve(result);
    };
    const fail = (msg, el) => { err.textContent = msg; err.classList.remove('hidden'); el.focus(); };
    const onSubmit = (e) => {
      e.preventDefault();
      const sign = radios.find((r) => r.checked);
      const amount = parseNum($('mo-stopAmount').value);
      const tradesRaw = $('mo-stopTrades').value.trim();
      const trades = /^\d+$/.test(tradesRaw) ? parseInt(tradesRaw, 10) : NaN;
      const removeNote = $('mo-stopNote').value.trim();
      if (!sign) return fail('Bitte wählen, ob Gewinn oder Verlust gemacht wurde.', radios[0]);
      if (!(amount >= 0)) return fail('Bitte den Betrag als Zahl angeben (z. B. 4,20).', $('mo-stopAmount'));
      if (!(trades >= 0)) return fail('Bitte die Anzahl Trades als ganze Zahl angeben (z. B. 12).', $('mo-stopTrades'));
      if (!removeNote) return fail('Bitte eine Notiz eingeben – ohne Notiz kann der Bot nicht gestoppt werden.', $('mo-stopNote'));
      cleanup({ removeNote, pnl: +sign.value * amount, trades });
    };
    const onCancel = (e) => { if (e) e.preventDefault(); cleanup(null); };
    form.addEventListener('submit', onSubmit);
    $('mo-stopCancel').addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
    radios[0].focus();
  });
}

async function moStopBot(id) {
  const bot = loadBots().find((b) => String(b.id) === id);
  if (!bot) return;
  const res = await moOpenStopDialog(bot);
  if (!res) return;
  saveBots(loadBots().filter((b) => String(b.id) !== id));
  const removed = loadRemovedBots();
  removed.unshift({ ...bot, quote: moBotQuote(bot), removedAt: new Date().toISOString(), removeNote: res.removeNote, pnl: res.pnl, trades: res.trades });
  saveRemovedBots(removed);
  renderBotList(); // rendert auch die entfernten Bots und ermittelt dabei die Eignung (moFillRemovedSuitability)
}

// Eignung (wie "Eignung bei Start" / "Eignung aktuell" in der Bot-Prüfung) zu einem Zeitpunkt:
// dieselbe Bewertung auf den 500 4h-Kerzen (~83 Tage) bis zu diesem Zeitpunkt.
async function moSuitabilityAt(symbol, endMs) {
  const candles = await fetchKlines(symbol, '4h', { limit: 500, endTime: endMs });
  if (candles.length < 10) return { cls: null, score: null };
  const v = evaluateSuitability(candles);
  return { cls: v.cls, score: v.score };
}

// Eignung beim Start und beim Stoppen für entfernte Bots ermitteln und speichern (einmalig je Eintrag,
// auch für ältere Einträge ohne diese Angabe). Fehlgeschlagene Abfragen werden in dieser Sitzung
// nicht wiederholt.
const moSuitPending = new Set();
const moSuitFailed = new Set();
async function moFillRemovedSuitability() {
  const todo = loadRemovedBots().filter((b) => (!b.suitStart || !b.suitEnd)
    && !moSuitPending.has(String(b.id)) && !moSuitFailed.has(String(b.id)));
  if (!todo.length) return;
  todo.forEach((b) => moSuitPending.add(String(b.id)));
  renderRemovedBots(false);
  for (const b of todo) {
    const id = String(b.id);
    let suitStart, suitEnd;
    try {
      [suitStart, suitEnd] = await Promise.all([
        moSuitabilityAt(b.symbol, dateTimeToMs(b.startDate, b.startTime)),
        moSuitabilityAt(b.symbol, new Date(b.removedAt).getTime()),
      ]);
    } catch (e) {
      console.warn(`Eignung für ${b.symbol} nicht ermittelbar:`, e.message);
      moSuitPending.delete(id);
      moSuitFailed.add(id);
      renderRemovedBots(false);
      continue;
    }
    const removed = loadRemovedBots();
    const entry = removed.find((x) => String(x.id) === id);
    moSuitPending.delete(id);
    if (!entry) continue;
    entry.suitStart = suitStart;
    entry.suitEnd = suitEnd;
    saveRemovedBots(removed);
    renderRemovedBots(false);
  }
}

function moSuitText(v) {
  if (!v || !v.cls) return '<span class="note-empty">nicht ermittelbar</span>';
  return `<span class="suit ${v.cls}">${verdictLabel(v.cls)}${v.score != null ? ' (' + v.score + ')' : ''}</span>`;
}

function moSuitCell(b) {
  if (!b.suitStart || !b.suitEnd) {
    const id = String(b.id);
    return `<span class="note-empty">${moSuitPending.has(id) ? 'wird ermittelt …' : moSuitFailed.has(id) ? 'nicht ermittelbar' : '–'}</span>`;
  }
  return `<span class="k">Beim Start</span>${moSuitText(b.suitStart)}<span class="k" style="margin-top:6px">Beim Stoppen</span>${moSuitText(b.suitEnd)}`;
}

function moFmtDateTime(iso) {
  return new Date(iso).toLocaleString('de-DE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Gewinn grün, Verlust rot; % nur wenn das Investment bekannt ist. Ältere Einträge ohne Angabe: "–".
function moPnlCell(b) {
  if (b.pnl == null) return '<span class="note-empty">–</span>';
  const q = escapeHtml(moBotQuote(b));
  const cls = b.pnl > 0 ? 'pos' : b.pnl < 0 ? 'neg' : 'flat';
  const sign = b.pnl > 0 ? '+' : b.pnl < 0 ? '−' : '';
  const pct = b.investment > 0 ? `<span class="pnl-sub">${sign}${moFmtPct(Math.abs(b.pnl) / b.investment * 100)} auf ${moFmtAmount(b.investment)} ${q}</span>` : '';
  return `<span class="pnl ${cls}">${sign}${moFmtAmount(b.pnl)} ${q}</span>${pct}`;
}

function renderRemovedBots(fillSuitability = true) {
  const removed = loadRemovedBots();
  const eq = eqCompute(removed);
  const afterById = new Map(eq.steps.map((s) => [String(s.id), s.after]));
  $('mo-removedCount').textContent = `(${removed.length})`;
  $('mo-removedEmpty').classList.toggle('hidden', removed.length > 0);
  $('mo-removedTable').classList.toggle('hidden', removed.length === 0);
  $('mo-removedList').innerHTML = removed.map((b) => `
    <tr>
      <td>${escapeHtml(b.symbol)}</td>
      <td>${b.grids}</td>
      <td>${fmt6(b.lower)} – ${fmt6(b.upper)}${moSlTpText(b)}</td>
      <td>${escapeHtml(b.startDate)}${b.startTime ? ' ' + escapeHtml(b.startTime) : ''}</td>
      <td>${moFmtDateTime(b.removedAt)}</td>
      <td>${moPnlCell(b)}</td>
      <td>${b.trades != null ? b.trades : '<span class="note-empty">–</span>'}</td>
      <td>${eqAfterCell(b, afterById, eq.start)}</td>
      <td class="note-full">${moSuitCell(b)}</td>
      <td class="note-full">
        <span class="k">Grund für Stopp</span>${escapeHtml(b.removeNote)}
        ${b.note ? `<span class="k" style="margin-top:6px">Notiz</span>${escapeHtml(b.note)}` : ''}
      </td>
      <td><button class="danger" data-rdel="${b.id}" type="button">Löschen</button></td>
    </tr>
  `).join('');
  $('mo-removedList').querySelectorAll('[data-rdel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-rdel');
      const b = loadRemovedBots().find((x) => String(x.id) === id);
      if (!b || !confirm(`Eintrag ${b.symbol} (entfernt am ${moFmtDateTime(b.removedAt)}) endgültig löschen?`)) return;
      saveRemovedBots(loadRemovedBots().filter((x) => String(x.id) !== id));
      renderRemovedBots(false);
    });
  });
  if (fillSuitability) moFillRemovedSuitability();
  renderEquity(eq);
}

// ---------- Equity: Startkapital + Gewinn/Verlust aller beendeten Bots ----------
// Das Kapital wird nicht separat gespeichert, sondern immer aus der Liste "Entfernte Bots" berechnet.
// Wird dort ein Eintrag gelöscht, fällt damit auch sein Einfluss aufs Kapital weg.
const EQ_START_KEY = 'gridbot-suite-equity-start';
const EQ_QUOTE = 'USDT';
const EQ_DAY = 86400000;
let eqChartPts = [];

function eqLoadStart() {
  const v = Number(localStorage.getItem(EQ_START_KEY));
  return v > 0 ? v : null;
}
function eqSaveStart(v) {
  localStorage.setItem(EQ_START_KEY, String(v));
  moMarkChanged();
}

function eqSigned(n) {
  return (n > 0 ? '+' : n < 0 ? '−' : '') + moFmtAmount(n);
}
function eqCls(n) {
  return n > 0 ? 'pos' : n < 0 ? 'neg' : 'flat';
}

// Gezählt werden nur Bots mit Gewinn/Verlust-Angabe in USDT, chronologisch nach Stoppzeitpunkt.
function eqCompute(removed = loadRemovedBots()) {
  const start = eqLoadStart();
  const counted = removed
    .filter((b) => b.pnl != null && moBotQuote(b) === EQ_QUOTE)
    .sort((a, b) => new Date(a.removedAt) - new Date(b.removedAt));
  let cap = start || 0;
  const steps = counted.map((b) => { cap += b.pnl; return { id: b.id, symbol: b.symbol, removedAt: b.removedAt, pnl: b.pnl, after: cap }; });
  return {
    start,
    steps,
    noPnl: removed.filter((b) => b.pnl == null),
    otherQuote: removed.filter((b) => b.pnl != null && moBotQuote(b) !== EQ_QUOTE),
    pnl: steps.reduce((sum, s) => sum + s.pnl, 0),
  };
}

function eqAfterCell(b, afterById, start) {
  if (!afterById.has(String(b.id))) return '<span class="note-empty">nicht gezählt</span>';
  return start ? `${moFmtAmount(afterById.get(String(b.id)))} ${EQ_QUOTE}` : '<span class="note-empty">–</span>';
}

function renderEquity(eq = eqCompute()) {
  const { start, steps, pnl } = eq;
  const now = (start || 0) + pnl;
  const pct = start ? pnl / start * 100 : null;
  const pctTxt = pct == null ? '' : ` (${pct > 0 ? '+' : pct < 0 ? '−' : ''}${moFmtPct(Math.abs(pct))})`;

  $('eq-summary').innerHTML = start
    ? `<span class="${eqCls(pnl)}">${moFmtAmount(now)} ${EQ_QUOTE}${pctTxt}</span> <span class="status">· Startkapital ${moFmtAmount(start)} ${EQ_QUOTE}</span>`
    : `<span class="${eqCls(pnl)}">${eqSigned(pnl)} ${EQ_QUOTE}</span> <span class="status">· Startkapital noch nicht festgelegt</span>`;

  if (document.activeElement !== $('eq-startInput')) $('eq-startInput').value = start ? moFmtAmount(start) : '';
  $('eq-now').textContent = start ? `${moFmtAmount(now)} ${EQ_QUOTE}` : '–';
  $('eq-now-sub').textContent = start ? `Startkapital ${moFmtAmount(start)} ${EQ_QUOTE}` : 'Startkapital festlegen';
  $('eq-pnl').textContent = `${eqSigned(pnl)} ${EQ_QUOTE}`;
  $('eq-pnl').className = 'kpi-value ' + eqCls(pnl);
  $('eq-pnl-sub').textContent = pct == null ? 'Summe aller beendeten Bots' : `${pctTxt.trim().slice(1, -1)} auf das Startkapital`;
  const wins = steps.filter((s) => s.pnl > 0).length, losses = steps.filter((s) => s.pnl < 0).length;
  $('eq-count').textContent = steps.length;
  $('eq-count-sub').textContent = steps.length
    ? `${wins} mit Gewinn · ${losses} mit Verlust · Trefferquote ${Math.round(wins / steps.length * 100)} %`
    : 'noch keine';

  const skip = [];
  if (eq.noPnl.length) skip.push(`ohne Angabe zu Gewinn/Verlust: ${eq.noPnl.map((b) => escapeHtml(b.symbol)).join(', ')}`);
  if (eq.otherQuote.length) skip.push(`nicht in ${EQ_QUOTE}: ${eq.otherQuote.map((b) => escapeHtml(b.symbol)).join(', ')}`);
  $('eq-skip').innerHTML = skip.length ? `Nicht berücksichtigt (${skip.join(' · ')})` : '';
  $('eq-skip').classList.toggle('hidden', !skip.length);

  eqDrawChart(eq);
}

// Stufenkurve des Kapitals über echte Zeitachse; ohne Startkapital Verlauf der G/V-Summe ab 0
function eqDrawChart({ start, steps }) {
  const c = $('eq-chart'), ctx = c.getContext('2d');
  const W = c.width, H = c.height, pad = { l: 70, r: 16, t: 14, b: 24 };
  ctx.clearRect(0, 0, W, H);
  const base = start || 0;
  const pts0 = steps.map((s) => ({ label: s.symbol, date: s.removedAt, t: new Date(s.removedAt).getTime(), value: s.after, pnl: s.pnl }));
  // Zeitachse vom ersten bis zum letzten Stopp; Startpunkt kurz vor dem ersten Stopp
  const tLast = pts0.length ? pts0[pts0.length - 1].t : Date.now();
  const tFirst = pts0.length ? pts0[0].t : tLast - 7 * EQ_DAY;
  const span = Math.max(tLast - tFirst, EQ_DAY);
  const t0 = tFirst - span * 0.03, t1 = pts0.length > 1 ? tLast : tFirst + span;
  const pts = [{ label: start ? 'Startkapital' : 'Start', t: t0, value: base, pnl: null }, ...pts0];

  let min = Math.min(...pts.map((p) => p.value)), max = Math.max(...pts.map((p) => p.value));
  const m = (max - min) * 0.15 || Math.abs(base) * 0.01 || 1;
  min -= m; max += m;
  const x = (t) => pad.l + (t - t0) / (t1 - t0) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);

  // Hilfslinien mit runden Schritten
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#9aa3af';
  ctx.strokeStyle = '#262c35';
  ctx.lineWidth = 1;
  const raw = (max - min) / 4, pw = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / pw;
  const step = (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * pw;
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) {
    const val = Math.abs(v) < step / 1e6 ? 0 : v;
    ctx.beginPath(); ctx.moveTo(pad.l, y(val)); ctx.lineTo(W - pad.r, y(val)); ctx.stroke();
    ctx.fillText(fmt(val, step < 1 ? 2 : 0), pad.l - 6, y(val) + 4);
  }

  // Datumsachse: runde Abstände (Tage/Wochen bzw. Monatsanfänge), ca. 6 Beschriftungen
  const days = (t1 - t0) / EQ_DAY;
  const ticks = [];
  const dStep = [1, 2, 7, 14].find((d) => days / d <= 7);
  const d = new Date(t0);
  d.setHours(0, 0, 0, 0);
  if (dStep) {
    for (d.setDate(d.getDate() + 1); d.getTime() <= t1; d.setDate(d.getDate() + dStep)) {
      ticks.push([d.getTime(), d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' })]);
    }
  } else {
    const mStep = [1, 2, 3, 6, 12].find((k) => days / 30.4 / k <= 7) || 12;
    d.setDate(1);
    for (d.setMonth(d.getMonth() + 1); d.getTime() <= t1; d.setMonth(d.getMonth() + mStep)) {
      ticks.push([d.getTime(), d.toLocaleDateString('de-CH', { month: 'short', year: '2-digit' })]);
    }
  }
  ctx.textAlign = 'center';
  ctx.strokeStyle = '#1e232b';
  for (const [t, label] of ticks) {
    const px = x(t);
    if (px < pad.l + 20 || px > W - pad.r - 20) continue;
    ctx.beginPath(); ctx.moveTo(px, pad.t); ctx.lineTo(px, H - pad.b); ctx.stroke();
    ctx.fillText(label, px, H - 6);
  }

  // Startkapital (bzw. 0) als gestrichelte Referenz
  ctx.strokeStyle = '#6b7380';
  ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(pad.l, y(base)); ctx.lineTo(W - pad.r, y(base)); ctx.stroke();
  ctx.setLineDash([]);

  // Stufenlinie: Kapital ändert sich nur beim Beenden eines Bots
  ctx.strokeStyle = '#4f9dff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((p, i) => {
    if (i === 0) ctx.moveTo(x(p.t), y(p.value));
    else { ctx.lineTo(x(p.t), y(pts[i - 1].value)); ctx.lineTo(x(p.t), y(p.value)); }
  });
  if (pts.length > 1) ctx.lineTo(W - pad.r, y(pts[pts.length - 1].value));
  ctx.stroke();
  // Punkte (grün = Gewinn, rot = Verlust) nur bei wenigen Stopps, sonst überlappen sie; Tooltip bleibt
  if (pts.length <= 50) {
    for (const p of pts) {
      ctx.beginPath(); ctx.arc(x(p.t), y(p.value), 4.5, 0, Math.PI * 2);
      ctx.fillStyle = p.pnl == null ? '#9aa3af' : p.pnl >= 0 ? '#3ecf8e' : '#ff6161';
      ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#0c0f13'; ctx.stroke();
    }
  }
  eqChartPts = pts.map((p) => ({ ...p, px: x(p.t), py: y(p.value) }));
}

function eqShowTip(ev) {
  const c = $('eq-chart'), r = c.getBoundingClientRect(), sx = c.width / r.width;
  const mx = (ev.clientX - r.left) * sx;
  let best = null, bd = Infinity;
  for (const p of eqChartPts) { const dist = Math.abs(p.px - mx); if (dist < bd) { bd = dist; best = p; } }
  const tip = $('eq-tip');
  if (!best || bd > 40 * sx) { tip.style.display = 'none'; return; }
  tip.innerHTML = best.pnl == null
    ? `<div class="k">${best.label}</div>${moFmtAmount(best.value)} ${EQ_QUOTE}`
    : `<div class="k">${moFmtDateTime(best.date)} · ${escapeHtml(best.label)}</div><span class="${eqCls(best.pnl)}">${eqSigned(best.pnl)} ${EQ_QUOTE}</span> → ${moFmtAmount(best.value)} ${EQ_QUOTE}`;
  tip.style.display = 'block';
  tip.style.left = Math.min(Math.max(0, best.px / sx - tip.offsetWidth / 2), r.width - tip.offsetWidth) + 'px';
  tip.style.top = Math.max(0, best.py / sx - tip.offsetHeight - 12) + 'px';
}

function initEquity() {
  $('eq-chart').addEventListener('mousemove', eqShowTip);
  $('eq-chart').addEventListener('mouseleave', () => { $('eq-tip').style.display = 'none'; });
  $('eq-startBtn').addEventListener('click', () => {
    const v = parseNum($('eq-startInput').value);
    if (!(v > 0)) { $('eq-startStatus').textContent = 'Bitte Betrag grösser als 0 eingeben.'; return; }
    eqSaveStart(v);
    $('eq-startStatus').textContent = 'Übernommen.';
    $('eq-startInput').blur();
    renderEquity();
  });
  $('eq-startInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('eq-startBtn').click(); });
}

function renderBotList() {
  const bots = loadBots();
  $('mo-emptyNote').classList.toggle('hidden', bots.length > 0);
  $('mo-list').innerHTML = bots.map((b) => `
    <tr>
      <td>${pairLink(b.symbol, b.symbol, b.quote)}</td>
      <td>${b.grids} <span class="status">${gridModeLabel(b.mode).toLowerCase()}</span></td>
      <td>${fmt6(b.lower)} – ${fmt6(b.upper)}${moSlTpText(b)}</td>
      <td>${fmt6(b.startPrice)}</td>
      <td>${b.startDate}${b.startTime ? ' ' + b.startTime : ''}</td>
      <td>${b.investment != null ? `${moFmtAmount(b.investment)} ${escapeHtml(moBotQuote(b))}` : '<span class="note-empty">fehlt</span>'}</td>
      <td>${moNotePreview(b.note)}</td>
      <td><div class="cell-actions">
        <button class="secondary small" data-bt="${b.id}" type="button">Backtesten</button>
        <button class="secondary small" data-edit="${b.id}" type="button">Anpassen</button>
        <button class="secondary small" data-note="${b.id}" type="button">Notiz</button>
        <button class="danger" data-del="${b.id}" type="button">Bot stoppen</button>
      </div></td>
    </tr>
  `).join('');
  $('mo-list').querySelectorAll('[data-bt]').forEach((btn) => {
    btn.addEventListener('click', () => moBacktestBot(btn.getAttribute('data-bt')));
  });
  $('mo-list').querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => moStartEdit(btn.getAttribute('data-edit')));
  });
  $('mo-list').querySelectorAll('[data-note]').forEach((btn) => {
    btn.addEventListener('click', () => moEditNote(btn.getAttribute('data-note')));
  });
  $('mo-list').querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', () => moStopBot(btn.getAttribute('data-del')));
  });
  renderRemovedBots();
}

// Übernimmt Paar, Range, Grids, Grid-Modus, Investment und Startzeitpunkt eines hinterlegten Bots ins Backtest-Formular.
// Startkurs des zuletzt aus dem Monitoring übernommenen Bots; gilt nur, solange Paar und
// Startzeitpunkt im Backtest-Formular unverändert sind (siehe btOnSubmit).
let btBotStart = null;

async function moBacktestBot(id) {
  const b = loadBots().find((x) => String(x.id) === String(id));
  if (!b) return;
  const sym = symbolMap.get(b.symbol);
  if (!sym) {
    alert(`${b.symbol} ist auf Binance nicht (mehr) handelbar – Backtest nicht möglich.`);
    return;
  }
  document.querySelector('.tab-btn[data-tab="backtest"]').click();
  $('bt-quote').value = sym.quote;
  btFillSymbolSelect();
  $('bt-symbol').value = b.symbol;
  // btOnSymbolChange setzt Standard-Grenzen (±10%) – danach mit den Bot-Werten überschreiben
  await btOnSymbolChange();
  $('bt-lower').value = priceToInput(b.lower, sym.decimals);
  $('bt-upper').value = priceToInput(b.upper, sym.decimals);
  $('bt-grids').value = b.grids;
  $('bt-mode').value = b.mode || 'geometric';
  if (b.investment > 0) $('bt-investment').value = b.investment;
  $('bt-start').value = b.startDate;
  $('bt-startTime').value = b.startTime || '';
  // SL/TP des Bots übernehmen; ohne Angabe leeren, damit Werte eines früheren Laufs nicht mitlaufen
  $('bt-sl').value = b.stopLoss > 0 ? priceToInput(b.stopLoss, sym.decimals) : '';
  $('bt-tp').value = b.takeProfit > 0 ? priceToInput(b.takeProfit, sym.decimals) : '';
  btBotStart = b.startPrice > 0
    ? { symbol: b.symbol, startTime: dateTimeToMs(b.startDate, b.startTime), price: b.startPrice }
    : null;
  // Wie "Backtesting" im Tab Analyse & Optimierung: direkt starten
  $('bt-form').requestSubmit();
}

function addBot({ symbol, grids, lower, upper, startPrice, startDate, startTime = '', investment, quote, mode = 'geometric', stopLoss = null, takeProfit = null }) {
  const bots = loadBots();
  bots.push({ id: Date.now(), symbol, grids, mode, lower, upper, stopLoss, takeProfit, startPrice, startDate, startTime, investment, quote });
  saveBots(bots);
  renderBotList();
}

// ---------- Bot anpassen: Formular "Bot hinterlegen" im Bearbeitungsmodus ----------
// Das Paar bleibt fest (anderes Paar = anderer Bot). ID, Notiz und übrige Felder bleiben erhalten.
let moEditId = null;

function moSetPairLocked(locked) {
  for (const id of ['mo-quote', 'mo-symbol']) {
    const sel = $(id);
    sel.disabled = locked;
    const trigger = sel.parentNode.querySelector('.ss-trigger');
    if (trigger) trigger.disabled = locked;
  }
}

function moStartEdit(id) {
  const b = loadBots().find((x) => String(x.id) === String(id));
  if (!b) return;
  const dec = symbolMap.get(b.symbol)?.decimals ?? null;
  moEditId = b.id;
  $('mo-addBox').open = true;
  selectPair($('mo-quote'), $('mo-symbol'), b.symbol);
  moSyncInvestUnit();
  moSetPairLocked(true);
  $('mo-grids').value = b.grids;
  $('mo-mode').value = b.mode || 'geometric';
  $('mo-investment').value = b.investment != null ? String(b.investment) : '';
  $('mo-lower').value = priceToInput(b.lower, dec);
  $('mo-upper').value = priceToInput(b.upper, dec);
  $('mo-startPrice').value = priceToInput(b.startPrice, dec);
  $('mo-sl').value = b.stopLoss > 0 ? priceToInput(b.stopLoss, dec) : '';
  $('mo-tp').value = b.takeProfit > 0 ? priceToInput(b.takeProfit, dec) : '';
  $('mo-startDate').value = b.startDate;
  $('mo-startTime').value = b.startTime || '';
  $('mo-addTitle').textContent = `Bot anpassen · ${b.symbol}`;
  $('mo-addBtn').textContent = 'Änderungen speichern';
  $('mo-cancelEditBtn').classList.remove('hidden');
  $('mo-addStatus').textContent = 'Werte ändern und mit „Änderungen speichern“ übernehmen.';
  $('mo-addBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function moEndEdit() {
  if (moEditId == null) return;
  moEditId = null;
  moSetPairLocked(false);
  $('mo-addTitle').textContent = 'Bot hinterlegen';
  $('mo-addBtn').textContent = 'Bot hinzufügen';
  $('mo-cancelEditBtn').classList.add('hidden');
}

function moClearForm() {
  $('mo-startTime').value = '';
  $('mo-lower').value = ''; $('mo-upper').value = ''; $('mo-sl').value = ''; $('mo-tp').value = ''; $('mo-startPrice').value = ''; $('mo-investment').value = ''; $('mo-mode').value = '';
}

// Optionaler Stop-Loss / Take-Profit eines Bots als Zusatzzeile unter der Range
function moSlTpText(b) {
  const parts = [];
  if (b.stopLoss > 0) parts.push(`SL ${fmt6(b.stopLoss)}`);
  if (b.takeProfit > 0) parts.push(`TP ${fmt6(b.takeProfit)}`);
  return parts.length ? `<br><span class="status">${parts.join(' · ')}</span>` : '';
}

// Abstand in % der jeweiligen Grenze (wie moOutsidePct); unter 1% mit zwei Nachkommastellen,
// damit "knapp an der Grenze" nicht zu 0 bzw. 100% gerundet wird.
function moFmtPct(p) {
  return p.toFixed(p < 1 ? 2 : 1).replace('.', ',') + '%';
}

// Kurs in der Tick-Genauigkeit des Paares (wie auf Binance), Fallback ohne Symbol-Info: 6 Stellen
function moFmtSymPrice(price, symbol) {
  const sym = symbolMap.get(symbol);
  return sym ? priceToInput(price, sym.decimals) : fmt6(price);
}

function moCurrentPriceText(bot, data) {
  const quote = symbolMap.get(bot.symbol)?.quote || '';
  const chg = bot.startPrice > 0 ? (data.currentPrice - bot.startPrice) / bot.startPrice * 100 : null;
  const chgTxt = chg == null ? ''
    : ` <span class="${chg >= 0 ? 'pos' : 'neg'}">(${chg >= 0 ? '+' : '−'}${Math.abs(chg).toFixed(1).replace('.', ',')}% seit Start)</span>`;
  const at = new Date(data.priceTime).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
  return `${moFmtSymPrice(data.currentPrice, bot.symbol)} ${quote}${chgTxt} <span class="status">· Stand ${at}</span>`;
}

function moPositionText(price, lower, upper) {
  if (price >= lower && price <= upper) {
    return `Innerhalb der Range · ${moFmtPct((upper - price) / upper * 100)} unter der oberen Grenze · ${moFmtPct((price - lower) / lower * 100)} über der unteren Grenze`;
  }
  if (price < lower) return `Ausserhalb der Range · ${moFmtPct((lower - price) / lower * 100)} unter der unteren Grenze`;
  return `Ausserhalb der Range · ${moFmtPct((price - upper) / upper * 100)} über der oberen Grenze`;
}

// Balken: Range nimmt die mittleren 80% ein, links/rechts je 10% Platz für Kurse ausserhalb.
// Liegt der Kurs noch weiter weg, bleibt die Markierung am Rand stehen (Pfeil zeigt die Richtung).
function moPositionBar(price, lower, upper, symbol) {
  const f = (v) => moFmtSymPrice(v, symbol);
  const raw = 10 + (price - lower) / (upper - lower) * 80;
  const x = Math.max(1, Math.min(99, raw));
  const inside = price >= lower && price <= upper;
  const arrow = raw < 1 ? '◀ ' : raw > 99 ? ' ▶' : '';
  const labelAlign = x < 20 ? 'left' : x > 80 ? 'right' : 'center';
  return `
    <div class="pos-bar" role="img" aria-label="Kurs ${fmt6(price)} in Range ${fmt6(lower)} bis ${fmt6(upper)}">
      <div class="pos-price ${labelAlign}" style="left:${x}%">${raw < 1 ? arrow : ''}${f(price)}${raw > 99 ? arrow : ''}</div>
      <div class="pos-track">
        <div class="pos-range"></div>
        <div class="pos-marker ${inside ? 'in' : 'out'}" style="left:${x}%"></div>
      </div>
      <div class="pos-labels"><span style="left:10%">${f(lower)}</span><span style="left:90%">${f(upper)}</span></div>
    </div>`;
}

function moOutsidePct(price, lower, upper) {
  if (price < lower) return (lower - price) / lower * 100;
  if (price > upper) return (price - upper) / upper * 100;
  return 0;
}

// Die Regeln werden in dieser Reihenfolge geprüft; die erste zutreffende bestimmt die Empfehlung.
// `rule` verweist auf den Eintrag in MO_RULES (für die Begründung "Warum?").
function moDecideRecommendation(verdictNow, verdictAtStart, outsidePct) {
  if (outsidePct > 10) {
    return { rule: 'farOutside', level: 'bad', text: 'Stoppen', reason: 'Der Kurs liegt mehr als 10% ausserhalb der Grid-Range – der Bot hält praktisch nur noch eine Position, statt zu traden.' };
  }
  if (outsidePct > 0) {
    return { rule: 'nearOutside', level: 'warn', text: 'Beobachten', reason: 'Der Kurs hat die Grid-Range verlassen, ist aber noch nahe dran.' };
  }
  const rank = { bad: 0, warn: 1, good: 2 };
  if (verdictNow.cls === 'bad') {
    return { rule: 'nowBad', level: 'bad', text: 'Stoppen', reason: `Die aktuelle Eignungsprüfung stuft das Paar als ungeeignet für Grid-Trading ein${verdictNow.ev && verdictNow.ev.reasons.length ? ' (' + verdictNow.ev.reasons.join(', ') + ')' : ''}.` };
  }
  if (rank[verdictNow.cls] < rank[verdictAtStart.cls]) {
    return { rule: 'worse', level: 'warn', text: 'Beobachten', reason: `Die Eignung hat sich seit dem Start verschlechtert (${verdictLabel(verdictAtStart.cls)} → ${verdictLabel(verdictNow.cls)}).` };
  }
  if (verdictNow.cls === 'warn') {
    return { rule: 'nowWarn', level: 'warn', text: 'Beobachten', reason: `Die aktuelle Einschätzung ist nur bedingt positiv${verdictNow.ev && verdictNow.ev.reasons.length ? ' (' + verdictNow.ev.reasons.join(', ') + ')' : ''}.` };
  }
  const since = verdictAtStart.cls === 'good' ? 'seit dem Start unverändert gut' : `aktuell gut (verbessert seit dem Start: ${verdictLabel(verdictAtStart.cls)})`;
  return { rule: 'ok', level: 'good', text: 'Weiter laufen lassen', reason: `Die Eignung ist ${since}, und der Kurs liegt innerhalb der Grid-Range.` };
}

const MO_RULES = [
  { id: 'farOutside', result: 'Stoppen', level: 'bad', q: 'Liegt der Kurs mehr als 10% ausserhalb der Grid-Range?' },
  { id: 'nearOutside', result: 'Beobachten', level: 'warn', q: 'Liegt der Kurs überhaupt ausserhalb der Grid-Range?' },
  { id: 'nowBad', result: 'Stoppen', level: 'bad', q: 'Ist das Paar aktuell „Ungeeignet“?' },
  { id: 'worse', result: 'Beobachten', level: 'warn', q: 'Ist die Eignung schlechter als beim Start?' },
  { id: 'nowWarn', result: 'Beobachten', level: 'warn', q: 'Ist das Paar aktuell nur „Bedingt geeignet“?' },
  { id: 'ok', result: 'Weiter laufen lassen', level: 'good', q: 'Keine der Warnregeln trifft zu' },
];

// ---------- Erklär-Modals "Warum?" (Coin Scanner + Bot-Monitoring): gemeinsame Bausteine ----------

const wyNf = (v, dec) => v.toLocaleString('de-CH', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const wyPct = (v, dec = 1) => (v > 0 ? '+' : v < 0 ? '−' : '') + wyNf(Math.abs(v), dec) + ' %';
const wyPlural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const wyDeltaTxt = (x) => Math.abs(x) < 0.5 ? '±0' : (x > 0 ? '+' : '−') + wyNf(Math.abs(x), 0);
const wyDeltaCls = (x) => Math.abs(x) < 0.5 ? 'wy-zero' : x > 0 ? 'wy-up' : 'wy-down';
const wyDate = (t) => new Date(t).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: '2-digit' });
const WY_STATE = { good: ['✓', 'passt'], mid: ['~', 'teils'], bad: ['✕', 'passt nicht'], skip: ['–', 'nicht geprüft'] };
const wyState = (st, txt) => `<span class="wy-state s-${st}"><i>${WY_STATE[st][0]}</i>${txt ?? WY_STATE[st][1]}</span>`;
const wyVolTxt = (v) => v >= 1e9 ? wyNf(v / 1e9, 2) + ' Mrd' : v >= 1e6 ? wyNf(v / 1e6, 1) + ' Mio' : wyNf(v / 1e3, 0) + ' Tsd';

// Die sechs Score-Kriterien mit Klartext-Frage, Messwert, Idealwert, Punkte-Regel und Fakt-Satz.
// ev: Kennzahlen aus scEvaluate (adx, chop, er, atrPct, gridProfit, gridTrades, gc, volume, points)
function wyCriteria(ev) {
  const p = ev.points;
  const trades = ev.gridTrades != null ? `${ev.gridTrades} Trades mit ${ev.gc} Grids. ` : '';
  return [
    { key: 'adx', name: 'Trendstärke', tech: 'ADX 14 T.', q: 'Läuft der Kurs klar in eine Richtung?', max: 25, value: wyNf(ev.adx, 1), ideal: '≤ 20',
      fact: ev.adx <= 20 ? 'Kein nennenswerter Trend – der Kurs pendelt.' : ev.adx <= 25 ? 'Leichter Trend.' : ev.adx >= 40 ? 'Starker Trend: ab 40 gibt es 0 Punkte.' : 'Deutlicher Trend – das Grid wird einseitig gefüllt.',
      rule: '≤ 20 volle Punkte · 25 → 15 P. · ab 40 → 0' },
    { key: 'chop', name: 'Zickzack', tech: 'CHOP 14 T.', q: 'Pendelt der Kurs hin und her?', max: 15, value: wyNf(ev.chop, 1), ideal: '≥ 61.8',
      fact: ev.chop >= 61.8 ? 'Stark hin und her – ideal für ein Grid.' : ev.chop > 38.2 ? 'Gemischt: teils Zickzack, teils gerichtet.' : 'Unter 38.2: gerichtete Bewegung, 0 Punkte.',
      rule: '≤ 38.2 → 0 · ≥ 61.8 volle Punkte' },
    { key: 'er', name: 'Umwege', tech: 'Efficiency Ratio 30 T.', q: 'Wie direkt kommt der Kurs ans Ziel?', max: 15, value: wyNf(ev.er, 2), ideal: '≤ 0.10',
      fact: ev.er <= 0.1 ? 'Viele Umwege – viele Kauf/Verkauf-Gelegenheiten.' : ev.er < 0.4 ? 'Mittlerer Anteil an Umwegen.' : 'Sehr direkte Bewegung (Trend), ab 0.40 → 0 Punkte.',
      rule: '≤ 0.10 volle Punkte · ≥ 0.40 → 0' },
    { key: 'atr', name: 'Tägliche Schwankung', tech: 'ATR % 14 T.', q: 'Bewegt sich der Kurs genug pro Tag?', max: 15, value: wyNf(ev.atrPct, 1) + ' %', ideal: '2–8 %',
      fact: ev.atrPct < 2 ? 'Zu wenig Bewegung – Grid-Stufen werden selten erreicht.' : ev.atrPct <= 8 ? 'Im idealen Bereich.' : 'Über 8 %: Risiko, dass der Kurs aus der Range fällt.',
      rule: '< 1 % → 0 · 2–8 % volle Punkte · darüber sinkend (min. 5)' },
    { key: 'sim', name: 'Grid-Test', tech: ev.gc ? `Simulation, ${ev.gc} Grids` : 'Simulation', q: 'Hätte ein Grid-Bot in 83 Tagen verdient?', max: 20, value: '+' + wyNf(ev.gridProfit, 1) + ' %', ideal: '≥ 15 %',
      fact: `${trades}${ev.gridProfit >= 15 ? 'Sehr guter Grid-Gewinn.' : ev.gridProfit >= 3 ? 'Etwas Grid-Gewinn.' : 'Kaum Grid-Gewinn.'} (nur Grid-Gewinn, ohne Kursgewinn/-verlust)`,
      rule: '0 % → 0 · ≥ 15 % volle Punkte' },
    { key: 'vol', name: 'Handelsvolumen', tech: '24h in Quote', q: 'Werden Orders zuverlässig ausgeführt?', max: 10, value: wyVolTxt(ev.volume), ideal: '≥ 100 Mio',
      fact: ev.volume >= 1e8 ? 'Sehr liquide.' : ev.volume >= 1e6 ? 'Ausreichend liquide, aber unter 100 Mio.' : 'Wenig Handel – Orders werden evtl. träge ausgeführt.',
      rule: '≤ 1 Mio → 0 · ≥ 100 Mio volle Punkte (logarithmisch)' },
  ].map((c) => {
    const pts = p[c.key];
    const r = pts / c.max;
    return { ...c, pts, lost: c.max - pts, st: r >= 0.85 ? 'good' : r >= 0.4 ? 'mid' : 'bad' };
  });
}

// Bewertung für die Anzeige: Score und Einstufung wie berechnet, dazu die 83-Tage-Prüfung
// (gleiche Schwellen wie assessSuitability; bei alten Scanner-Einträgen ohne Spanne unbekannt)
function wyRating(ev, score, cls, rangePct, driftRatio) {
  const gateFail = rangePct == null ? null : rangePct < 4 || driftRatio > 0.65;
  return { score, cls, rangePct, driftRatio, gateFail, downgraded: !!ev.downgraded, crit: wyCriteria(ev) };
}

// Score-Skala 0–100; mit `start` zusätzlich ein hohler Marker für den Wert beim Bot-Start
function wyScale(now, start = null) {
  const lbl = (v, txt) => `<span class="wy-mlabel" style="left:${Math.min(96, Math.max(4, v))}%">${txt}</span>`;
  const labels = start == null ? ''
    : Math.abs(now - start) < 9 ? lbl((now + start) / 2, `Start ${start} → Jetzt <b>${now}</b>`)
    : lbl(start, `Start ${start}`) + lbl(now, `<b>Jetzt ${now}</b>`);
  return `<div class="wy-scale${start != null ? ' two' : ''}">
    ${labels}
    <div class="wy-scale-track">
      <div class="wy-zones"><span class="wy-z-bad" style="flex:45"></span><span class="wy-z-warn" style="flex:20"></span><span class="wy-z-good" style="flex:35"></span></div>
      ${start != null ? `<div class="wy-marker start" style="left:${start}%"></div>` : ''}
      <div class="wy-marker" style="left:${now}%"></div>
    </div>
    <div class="wy-ticks"><span style="left:0;transform:none">0</span><span style="left:45%">45</span><span style="left:65%">65</span><span style="left:100%;transform:translateX(-100%)">100</span></div>
    <div class="wy-zlabels"><span style="flex:45">Ungeeignet</span><span style="flex:20">Bedingt</span><span style="flex:35">Gut geeignet</span></div>
  </div>`;
}

// Abstand zu den Stufengrenzen in Worten
function wyDistance(r) {
  const next = r.cls === 'bad' ? { at: 45, lbl: 'Bedingt geeignet' } : r.cls === 'warn' && !r.downgraded ? { at: 65, lbl: 'Gut geeignet' } : null;
  const lower = r.cls === 'good' ? { at: 65, lbl: 'Bedingt geeignet' } : r.cls === 'warn' && !r.downgraded ? { at: 45, lbl: 'Ungeeignet' } : null;
  const miss = next && next.at - r.score;
  const buf = lower && r.score - lower.at + 1;
  return [
    next ? `Bis „${next.lbl}“ (ab ${next.at}) fehl${miss === 1 ? 't' : 'en'} <b>${wyPlural(miss, 'Punkt', 'Punkte')}</b>.` : '',
    lower ? `Mit <b>${wyPlural(buf, 'Punkt', 'Punkten')} weniger</b> wäre es „${lower.lbl}“.` : '',
    r.downgraded ? 'Die Punkte reichen für „Gut“, aber die 83-Tage-Prüfung senkt auf „Bedingt“.' : '',
  ].filter(Boolean).join(' ');
}

// Punkte-Leiste: ein Block je Kriterium, Breite = Gewicht; mit `rStart` eine zweite (dünne) Zeile für den Start
function wyPointsBar(r, rStart = null) {
  const bar = (x, slim) => `<div class="wy-pbar${slim ? ' slim' : ''}">${x.crit.map((c) => `<div class="wy-pseg s-${c.st}" style="flex:${c.max}" title="${c.name}: ${wyNf(c.pts, 1)} von ${c.max} Punkten"><span style="width:${c.pts / c.max * 100}%"></span></div>`).join('')}</div>`;
  const legend = r.crit.map((c, i) => {
    const d = rStart ? c.pts - rStart.crit[i].pts : 0;
    return `<span style="flex:${c.max}" title="${c.name}">${c.name}<br><b>${wyNf(c.pts, 0)}/${c.max}</b>${rStart ? ` <span class="${wyDeltaCls(d)}">${wyDeltaTxt(d)}</span>` : ''}</span>`;
  }).join('');
  return `${rStart
    ? `<div class="wy-prow"><span class="wy-plab">Start</span>${bar(rStart, true)}</div><div class="wy-prow"><span class="wy-plab">Jetzt</span>${bar(r)}</div>`
    : bar(r)}
    <div class="wy-plegend${rStart ? ' indent' : ''}">${legend}</div>
    <p class="wy-hint">Jeder Block ist so breit wie sein Gewicht (max. Punkte). Gefüllt = erreicht, leer = verloren.</p>`;
}

// Kriterien-Tabelle; mit `rStart` zusätzlich die Messwerte beim Start und die Veränderung der Punkte
function wyCritTable(r, rStart = null) {
  const rows = r.crit.map((c, i) => {
    const s = rStart && rStart.crit[i];
    const change = s ? `<span class="wy-lost ${wyDeltaCls(c.pts - s.pts)}">${wyDeltaTxt(c.pts - s.pts)} seit Start</span>`
      : c.lost >= 0.05 ? `<span class="wy-lost">−${wyNf(c.lost, 1)}</span>` : '';
    return `<tr>
      <td><div class="wy-cname">${c.name} <span class="wy-cq">· ${c.tech}</span></div><div class="wy-cq">${c.q}</div><div class="wy-cfact">${c.fact}</div></td>
      ${s ? `<td class="wy-num wy-muted">${s.value}</td>` : ''}
      <td class="wy-num"><b>${c.value}</b></td>
      <td class="wy-num wy-muted">${c.ideal}</td>
      <td class="wy-num">${wyNf(c.pts, 1)} / ${c.max}<span class="wy-mini"><span class="s-${c.st}" style="width:${c.pts / c.max * 100}%"></span></span>${change}</td>
      <td>${wyState(c.st)}</td>
    </tr>`;
  }).join('');
  return `<table class="wy-crit">
    <thead><tr><th>Kriterium</th>${rStart ? '<th class="wy-num">Start</th><th class="wy-num">Jetzt</th>' : '<th class="wy-num">Messwert</th>'}<th class="wy-num">Ideal</th><th class="wy-num">Punkte</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// 83-Tage-Sicherheitsprüfung (zweite Stufe nach dem Score)
function wyGate(r) {
  if (r.gateFail == null) {
    return `<div class="wy-gate"><b>83-Tage-Sicherheitsprüfung</b><div class="wy-gate-res">Für diese ältere Bewertung nicht gespeichert – „Scan starten“ bewertet neu.${r.downgraded ? ' Sie hat „Gut geeignet“ auf „Bedingt geeignet“ gesenkt.' : ''}</div></div>`;
  }
  const res = !r.gateFail ? 'Bestanden – keine Auswirkung auf die Einstufung.'
    : r.downgraded ? '<b class="wy-warn-txt">Nicht bestanden – „Gut geeignet“ wurde auf „Bedingt geeignet“ gesenkt.</b>'
    : 'Nicht bestanden – ohne Auswirkung, weil der Score schon unter 65 liegt.';
  return `<div class="wy-gate">
    <b>83-Tage-Sicherheitsprüfung</b>
    <div class="wy-gate-row"><span>Hat sich der Kurs genug bewegt? Spanne ${wyNf(r.rangePct, 1)} % (mind. 4 %)</span>${wyState(r.rangePct >= 4 ? 'good' : 'bad')}</div>
    <div class="wy-gate-row"><span>Seitwärts statt Einbahnstrasse? Trend-Anteil ${wyNf(r.driftRatio * 100, 0)} % (max. 65 %)</span>${wyState(r.driftRatio <= 0.65 ? 'good' : 'bad')}</div>
    <div class="wy-gate-res">${res}</div>
  </div>`;
}

// Aufklappbare Rechenregeln; `extra` = zusätzliche Tabellenzeilen
function wyHow(r, extra = '') {
  return `<details class="wy-how"><summary>Wie wird gerechnet?</summary>
    <table>${r.crit.map((c) => `<tr><td>${c.name} (${c.max} P.)</td><td>${c.rule}</td></tr>`).join('')}
    <tr><td>Einstufung</td><td>ab 65 Gut geeignet · 45–64 Bedingt · unter 45 Ungeeignet. Schlägt die 83-Tage-Prüfung an (Spanne unter 4 % oder Trend-Anteil über 65 %), höchstens „Bedingt“. Basis: letzte 500 4h-Kerzen (~83 Tage).</td></tr>${extra}</table>
  </details>`;
}

const wyChartBox = (id) => `<div class="wy-chart" id="${id}"><svg></svg><div class="wy-tip"></div></div>`;
const wyFacts = (items) => `<div class="wy-facts">${items.map(([v, l, col]) => `<div class="wy-fact"><b${col ? ` class="wy-${col}-txt"` : ''}>${v}</b><span>${l}</span></div>`).join('')}</div>`;

// Kursverlauf als Linie mit Hover. hlines: waagrechte Linien mit Beschriftung rechts,
// band: hervorgehobene Range, trend: gestrichelte Linie Start → Ende, fmt: Preisformat
function wyLineChart(el, { series, t0, dt, fmt, hlines = [], band = null, trend = false, lastColor = 'var(--accent)', note = '' }) {
  const svg = el.querySelector('svg');
  const tip = el.querySelector('.wy-tip');
  const W = 720, H = 210, L = 8, R = 150, T = 12, B = 22;
  const n = series.length;
  const vals = [...series, ...hlines.map((h) => h.v), ...(band ? [band.lo, band.hi] : [])];
  let min = Math.min(...vals), max = Math.max(...vals);
  const pad = (max - min) * 0.06 || max * 0.01;
  min -= pad; max += pad;
  const x = (i) => L + i / Math.max(1, n - 1) * (W - L - R);
  const y = (v) => T + (1 - (v - min) / (max - min)) * (H - T - B);
  // Beschriftungen rechts: bei Überlappung nach unten schieben
  const labs = hlines.map((h) => ({ ...h, ly: y(h.v) })).sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < labs.length; i++) if (labs[i].ly - labs[i - 1].ly < 13) labs[i].ly = labs[i - 1].ly + 13;
  const path = series.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `
    ${band ? `<rect x="${L}" width="${W - L - R}" y="${y(band.hi)}" height="${Math.max(0, y(band.lo) - y(band.hi))}" fill="rgba(79,157,255,.10)"/>` : ''}
    ${labs.map((h) => `<line x1="${L}" x2="${W - R}" y1="${y(h.v)}" y2="${y(h.v)}" stroke="${h.color || '#3a424d'}" stroke-dasharray="${h.dash || '3 4'}"/>
      <text x="${W - R + 6}" y="${h.ly + 4}" fill="${h.tcolor || '#9aa3af'}" font-size="11">${h.label} ${fmt(h.v)}</text>`).join('')}
    ${trend ? `<line x1="${x(0)}" x2="${x(n - 1)}" y1="${y(series[0])}" y2="${y(series[n - 1])}" stroke="${series[n - 1] >= series[0] ? 'var(--good)' : 'var(--bad)'}" stroke-width="1.5" stroke-dasharray="6 4" opacity=".7"/>` : ''}
    <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${x(0)}" cy="${y(series[0])}" r="4" fill="var(--accent)" stroke="#12161b" stroke-width="2"/>
    <circle cx="${x(n - 1)}" cy="${y(series[n - 1])}" r="5" fill="${lastColor}" stroke="#12161b" stroke-width="2"/>
    <text x="${L}" y="${H - 5}" fill="#9aa3af" font-size="11">${wyDate(t0)}</text>
    <text x="${W - R}" y="${H - 5}" fill="#9aa3af" font-size="11" text-anchor="end">${wyDate(t0 + (n - 1) * dt)}</text>
    <text x="${(W - R) / 2}" y="${H - 5}" fill="#9aa3af" font-size="11" text-anchor="middle">${note}</text>
    <line class="xh" y1="${T}" y2="${H - B}" stroke="#9aa3af" visibility="hidden"/>
    <circle class="xd" r="4" fill="var(--accent)" stroke="#12161b" stroke-width="2" visibility="hidden"/>
    <rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent"/>`;
  const xh = svg.querySelector('.xh'), xd = svg.querySelector('.xd'), hit = svg.querySelector('.hit');
  hit.addEventListener('mousemove', (ev) => {
    const rc = svg.getBoundingClientRect();
    const sx = (ev.clientX - rc.left) / rc.width * W;
    const i = Math.max(0, Math.min(n - 1, Math.round((sx - L) / (W - L - R) * (n - 1))));
    xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.setAttribute('visibility', 'visible');
    xd.setAttribute('cx', x(i)); xd.setAttribute('cy', y(series[i])); xd.setAttribute('visibility', 'visible');
    const t = new Date(t0 + i * dt);
    tip.style.display = 'block';
    tip.innerHTML = `${wyDate(t)}${dt < 864e5 ? ' ' + t.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }) : ''} · <b>${fmt(series[i])}</b>`;
    tip.style.left = Math.max(0, Math.min(x(i) / W * rc.width + 10, rc.width - tip.offsetWidth - 4)) + 'px';
    tip.style.top = (y(series[i]) / H * rc.height - 30) + 'px';
  });
  hit.addEventListener('mouseleave', () => {
    tip.style.display = 'none';
    xh.setAttribute('visibility', 'hidden');
    xd.setAttribute('visibility', 'hidden');
  });
}

// Eignung eines Zeitpunkts für die Anzeige (null, wenn für den Punkte-Score zu wenig Historie da war)
function moWhyRating(v) {
  return v.ev ? wyRating(v.ev, v.score, v.cls, v.rangePct, v.driftRatio) : null;
}

// Kerzen seit dem Bot-Start (höchstens die geladenen ~83 Tage)
function moWhySince(bot, data) {
  const startMs = dateTimeToMs(bot.startDate, bot.startTime);
  const since = data.candlesNow.filter((c) => c.time >= startMs);
  return { startMs, candles: since.length >= 2 ? since : data.candlesNow.slice(-2), full: since.length >= 2 && data.candlesNow[0].time < startMs };
}

// Inhalt des Modals "Warum diese Beurteilung?" (Titel setzt moRenderBotCard)
function moRenderExplanation(bot, data) {
  const { rec, verdictNow, verdictAtStart, currentPrice: price } = data;
  const f = (v) => moFmtSymPrice(v, bot.symbol);
  const quote = moBotQuote(bot);
  const now = moWhyRating(verdictNow);
  const start = moWhyRating(verdictAtStart);
  const hitIdx = MO_RULES.findIndex((r) => r.id === rec.rule);
  const out = moOutsidePct(price, bot.lower, bot.upper);
  const below = price < bot.lower, above = price > bot.upper, inside = !below && !above;
  const stopLo = bot.lower * 0.9, stopHi = bot.upper * 1.1;
  const { startMs, candles } = moWhySince(bot, data);
  const closes = candles.map((c) => c.close);
  const chg = bot.startPrice > 0 ? (price - bot.startPrice) / bot.startPrice * 100 : null;
  const days = (Date.now() - startMs) / 864e5;

  // Wie lange liegt der Kurs schon ausserhalb? (4h-Kerzen vom Ende rückwärts)
  let outBars = 0;
  for (let k = closes.length - 1; k >= 0 && (closes[k] < bot.lower || closes[k] > bot.upper); k--) outBars++;
  const outTxt = !outBars ? '' : outBars * 4 >= 48 ? `seit ca. ${Math.round(outBars * 4 / 24)} Tagen` : `seit ca. ${outBars * 4} Stunden`;
  const posTxt = inside
    ? `innerhalb der Range (${wyNf((bot.upper - price) / price * 100, 1)} % bis zur Ober-, ${wyNf((price - bot.lower) / price * 100, 1)} % bis zur Untergrenze)`
    : `${wyNf(out, 1)} % ${below ? 'unter der Untergrenze' : 'über der Obergrenze'} ${f(below ? bot.lower : bot.upper)}`;
  const lbl = (v) => `„${verdictLabel(v.cls)}“${v.score != null ? ` (${v.score})` : ''}`;

  // Entscheidungsweg: Fakt je Regel
  const facts = {
    farOutside: inside ? 'Nein, Kurs innerhalb der Range.' : `${wyNf(out, 1)} % ausserhalb, Grenze für „Stoppen“: 10 %.`,
    nearOutside: inside ? `Nein, Kurs ${f(price)} liegt in ${f(bot.lower)}–${f(bot.upper)}.` : `Ja, ${wyNf(out, 1)} % ${below ? 'unter' : 'über'} der Range${outTxt ? ', ' + outTxt : ''}.`,
    nowBad: verdictNow.score != null ? `Score jetzt ${verdictNow.score} (Ungeeignet unter 45).` : `Jetzt: ${verdictLabel(verdictNow.cls)} (einfache Prüfung).`,
    worse: `Start: ${lbl(verdictAtStart)} → jetzt: ${lbl(verdictNow)}.`,
    nowWarn: verdictNow.score != null ? `Score jetzt ${verdictNow.score} (Gut ab 65${now?.downgraded ? ', aber 83-Tage-Prüfung nicht bestanden' : ''}).` : `Jetzt: ${verdictLabel(verdictNow.cls)}.`,
    ok: 'Kurs in der Range und Eignung „Gut“.',
  };
  const chain = MO_RULES.map((r, k) => {
    const state = k < hitIdx ? 'pass' : k === hitIdx ? 'hit' : 'skip';
    const res = state === 'pass' ? wyState('good', 'Nein') : state === 'hit' ? `<span class="badge ${r.level}">${r.result}</span>` : wyState('skip');
    return `<li class="${state} ${r.level}"><span class="wy-n">${k + 1}.</span><div>${r.q}${state !== 'skip' ? `<div class="wy-f">${facts[r.id]}</div>` : ''}</div><div>${res}</div></li>`;
  }).join('');

  // Grösste Punktverluste seit dem Start
  const worst = now && start
    ? now.crit.map((c, k) => ({ c, s: start.crit[k], d: c.pts - start.crit[k].pts })).filter((m) => m.d <= -2).sort((a, b) => a.d - b.d).slice(0, 2)
    : [];
  const worstTxt = worst.length ? ` Grösste Verluste: ${worst.map((m) => `${m.c.name} ${wyDeltaTxt(m.d)} (${m.s.value} → ${m.c.value})`).join(', ')}.` : '';

  const lead = {
    farOutside: `Der Kurs liegt ${posTxt}${outTxt ? ', ' + outTxt : ''} – mehr als die 10 %, ab denen „Stoppen“ gilt. ${above ? `Der Bot hat alle Coins verkauft, hält nur noch ${quote || 'Quote-Asset'}` : 'Der Bot hat alles in Coins angelegt'} und handelt nicht mehr.`,
    nearOutside: `Der Kurs liegt ${posTxt}${outTxt ? ', ' + outTxt : ''}. Der Bot handelt erst wieder, wenn der Kurs in die Range zurückkommt. „Stoppen“ ab 10 % (Kurs ${below ? 'unter ' + f(stopLo) : 'über ' + f(stopHi)}).`,
    nowBad: `Der Kurs liegt ${posTxt}, aber die Eignung ist jetzt ${lbl(verdictNow)}.${worstTxt}`,
    worse: `Der Kurs liegt ${posTxt}. Die Eignung ist aber von ${lbl(verdictAtStart)} auf ${lbl(verdictNow)} gefallen.${worstTxt}`,
    nowWarn: `Der Kurs liegt ${posTxt}. Die Eignung ist nur „Bedingt“${verdictNow.score != null ? ` (Score ${verdictNow.score}, Gut ab 65)` : ''}${verdictAtStart.cls === 'warn' ? ', wie schon beim Start' : ''}.`,
    ok: `Der Kurs liegt ${posTxt}, die Eignung ist „Gut“${verdictNow.score != null ? ` (Score ${verdictNow.score}${verdictAtStart.score != null && verdictAtStart.score !== verdictNow.score ? `, beim Start ${verdictAtStart.score}` : ''})` : ''}. Keine Warnregel trifft zu.`,
  }[rec.rule];

  // Nächste Schwellen in Kurs und Punkten, relativ zu jetzt
  const to = (v) => wyPct((v - price) / price * 100);
  const lv = [];
  if (inside) {
    lv.push([`„Beobachten“, wenn der Kurs die Range verlässt: unter ${f(bot.lower)} oder über ${f(bot.upper)}`, `${to(bot.lower)} / ${to(bot.upper)}`]);
    lv.push([`„Stoppen“, wenn der Kurs mehr als 10 % ausserhalb liegt: unter ${f(stopLo)} oder über ${f(stopHi)}`, `${to(stopLo)} / ${to(stopHi)}`]);
  } else if (out <= 10) {
    lv.push([`Zurück in der Range ab ${f(below ? bot.lower : bot.upper)}`, to(below ? bot.lower : bot.upper)]);
    lv.push([`„Stoppen“ ${below ? 'unter' : 'über'} ${f(below ? stopLo : stopHi)} (10 % ausserhalb)`, to(below ? stopLo : stopHi)]);
  } else {
    lv.push([`Nur noch „Beobachten“, sobald der Kurs ${below ? 'über' : 'unter'} ${f(below ? stopLo : stopHi)} liegt (weniger als 10 % ausserhalb)`, to(below ? stopLo : stopHi)]);
    lv.push([`Zurück in der Range: ${below ? 'über' : 'unter'} ${f(below ? bot.lower : bot.upper)}`, to(below ? bot.lower : bot.upper)]);
  }
  if (now) {
    if (now.cls === 'bad') lv.push(['Nicht mehr „Ungeeignet“ ab Score 45', `+${45 - now.score} P.`]);
    else lv.push(['„Stoppen“, wenn der Score unter 45 fällt', `−${now.score - 44} P.`]);
    if (now.cls !== 'good') lv.push([`Für „Weiter laufen lassen“ braucht es „Gut geeignet“ (Score ab 65${now.gateFail ? ' und bestandene 83-Tage-Prüfung' : ''})`, now.score >= 65 ? '83-Tage-Prüfung' : `+${65 - now.score} P.`]);
    else lv.push(['„Beobachten“, wenn der Score unter 65 fällt', `−${now.score - 64} P.`]);
  }

  // Eignung: mit Score-Details oder (zu wenig Historie) einfache Prüfung
  const simple = (label, v) => `<p class="wy-p"><b>${label}:</b> ${verdictLabel(v.cls)} – zu wenig Kurshistorie für den Punkte-Score, daher einfache Prüfung: Preisspanne ${wyNf(v.rangePct, 1)} %, Trend-Anteil ${wyNf(v.driftRatio * 100, 0)} % (unter 40 % = gut, über 65 % = ungeeignet).</p>`;
  const suit = now
    ? `<div class="wy-score-row"><span class="wy-score-big">${now.score}<small> / 100 · ${verdictLabel(now.cls)}</small></span><span class="wy-score-note">${start
        ? `Start: ${start.score} (${verdictLabel(start.cls)}), <span class="${wyDeltaCls(now.score - start.score)}">${wyDeltaTxt(now.score - start.score)} ${Math.abs(now.score - start.score) === 1 ? 'Punkt' : 'Punkte'}</span>`
        : `Start: ${verdictLabel(verdictAtStart.cls)} (ohne Score)`}</span></div>
      ${wyScale(now.score, start ? start.score : null)}
      <div class="wy-gap">${wyPointsBar(now, start)}</div>`
    : simple('Jetzt', verdictNow) + (start ? '' : simple('Start', verdictAtStart));
  const vol = verdictNow.vol;

  return `
    <div class="wy-sec"><div class="wy-lead ${rec.level}"><b>Kurz gesagt:</b> ${lead}</div></div>
    <div class="wy-sec">
      <h4 class="wy-h">Entscheidungsweg</h4>
      <ol class="wy-chain">${chain}</ol>
      <p class="wy-hint">Von oben nach unten geprüft; die erste zutreffende Regel entscheidet. Die Kursposition kommt zuerst, weil ein Bot ausserhalb seiner Range nicht mehr handelt.</p>
    </div>
    <div class="wy-sec">
      <h4 class="wy-h">Kurs seit Start (${wyDate(startMs)})</h4>
      ${wyChartBox('mo-whyChart')}
      ${wyFacts([
        [f(price), `Kurs jetzt${quote ? ` (${quote})` : ''}`, inside ? '' : 'bad'],
        [chg == null ? '–' : wyPct(chg), `seit Start ${f(bot.startPrice)}`, chg == null ? '' : chg >= 0 ? 'good' : 'bad'],
        [inside ? 'innerhalb' : wyPct(below ? -out : out), inside ? 'Kursposition' : 'ausserhalb der Range', inside ? 'good' : out > 10 ? 'bad' : 'warn'],
        [days < 1 ? '< 1 Tag' : wyPlural(Math.round(days), 'Tag', 'Tage'), 'Laufzeit'],
      ])}
    </div>
    <div class="wy-sec">
      <h4 class="wy-h">Eignung: Start → Jetzt</h4>
      ${suit}
    </div>
    ${now ? `<div class="wy-sec">
      <h4 class="wy-h">Messwerte und Punkte</h4>
      ${wyCritTable(now, start)}
      ${wyGate(now)}
    </div>` : ''}
    <div class="wy-sec">
      <h4 class="wy-h">Nächste Schwellen</h4>
      ${lv.map(([t, v]) => `<div class="wy-lever"><span>${t}</span><b>${v}</b></div>`).join('')}
      ${now ? wyHow(now, `<tr><td>Prüfintervall</td><td>aus der Schwankung der letzten ~83 Tage: über 40 % täglich, über 25 % alle 2–3 Tage, über 12 % wöchentlich, sonst alle 1–2 Wochen. Aktuell ${wyNf(vol, 0)} % → „${recommendCheckInterval(vol)}“.</td></tr>`) : ''}
    </div>
    <p class="wy-foot">Geprüft am ${new Date(data.priceTime).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' })} · Eignung jeweils aus 500 4h-Kerzen vor dem Start bzw. bis jetzt · Empfohlenes Prüfintervall: ${recommendCheckInterval(vol)}. Keine Anlageberatung.</p>
  `;
}

// Kursdiagramm im Modal: Range als Band, Startkurs, SL/TP und – ausserhalb – die Stoppen-Schwelle
function moDrawWhyChart(bot, data) {
  const el = $('mo-whyChart');
  if (!el) return;
  const price = data.currentPrice;
  const { candles, full } = moWhySince(bot, data);
  const out = moOutsidePct(price, bot.lower, bot.upper);
  const below = price < bot.lower, inside = out === 0;
  const hlines = [
    { v: bot.upper, label: 'Obergrenze', color: 'rgba(79,157,255,.7)', dash: '0', tcolor: '#c9d4e3' },
    { v: bot.lower, label: 'Untergrenze', color: 'rgba(79,157,255,.7)', dash: '0', tcolor: '#c9d4e3' },
  ];
  if (bot.startPrice > 0) hlines.push({ v: bot.startPrice, label: 'Start', color: '#6b7380' });
  if (bot.stopLoss > 0) hlines.push({ v: bot.stopLoss, label: 'SL', color: 'rgba(255,97,97,.5)', dash: '2 3' });
  if (bot.takeProfit > 0) hlines.push({ v: bot.takeProfit, label: 'TP', color: 'rgba(62,207,142,.5)', dash: '2 3' });
  if (!inside) hlines.push({ v: below ? bot.lower * 0.9 : bot.upper * 1.1, label: 'Stoppen ab', color: 'rgba(255,97,97,.8)', tcolor: '#ff8a8a' });
  wyLineChart(el, {
    series: candles.map((c) => c.close), t0: candles[0].time, dt: 4 * 3600e3,
    fmt: (v) => moFmtSymPrice(v, bot.symbol), band: { lo: bot.lower, hi: bot.upper }, hlines,
    lastColor: inside ? 'var(--good)' : out > 10 ? 'var(--bad)' : 'var(--warn)',
    note: full ? 'blau = Grid-Range' : 'blau = Grid-Range · nur letzte ~83 Tage geladen',
  });
}

function moRenderBotCard(bot, data) {
  const rec = data.rec;
  const card = document.createElement('div');
  card.className = 'bot-card';
  card.innerHTML = `
    <div class="head">
      <h4>${pairLink(bot.symbol, bot.symbol, bot.quote)} · ${bot.grids} Grids ${gridModeLabel(bot.mode).toLowerCase()} · ${fmt6(bot.lower)}–${fmt6(bot.upper)}</h4>
      <div class="row">
        <button type="button" class="badge badge-btn ${rec.level}" title="Warum diese Beurteilung?">${rec.text}</button>
      </div>
    </div>
    <p class="note" style="margin:0 0 10px">${rec.reason}</p>
    ${bot.note ? `<div class="bot-note"><span class="status">Notiz: </span>${escapeHtml(bot.note)}</div>` : ''}
    <div class="metrics">
      <div class="metric"><div class="k">Aktueller Kurs</div><div class="v">${moCurrentPriceText(bot, data)}</div></div>
      <div class="metric"><div class="k">Empfohlenes Prüfintervall</div><div class="v">${recommendCheckInterval(data.verdictNow.vol)}</div></div>
      <div class="metric metric-wide"><div class="k">Kursposition</div><div class="v">${data.positionText}</div>${moPositionBar(data.currentPrice, bot.lower, bot.upper, bot.symbol)}</div>
      <div class="metric"><div class="k">Eignung bei Start</div><div class="v">${verdictLabel(data.verdictAtStart.cls)}${data.verdictAtStart.score != null ? ' (' + data.verdictAtStart.score + ')' : ''}</div></div>
      <div class="metric"><div class="k">Eignung aktuell</div><div class="v">${verdictLabel(data.verdictNow.cls)}${data.verdictNow.score != null ? ' (' + data.verdictNow.score + ')' : ''}</div></div>
    </div>
    <table class="details">
      <tr><td>Start</td><td>${bot.startDate}${bot.startTime ? ' ' + bot.startTime : ''} · Startkurs ${fmt6(bot.startPrice)}</td></tr>
      <tr><td>Preisspanne bei Start (83 Tage davor)</td><td>${data.verdictAtStart.rangePct.toFixed(1)}% · Trend-Anteil ${(data.verdictAtStart.driftRatio * 100).toFixed(0)}%</td></tr>
      <tr><td>Preisspanne aktuell (letzte 83 Tage)</td><td>${data.verdictNow.rangePct.toFixed(1)}% · Trend-Anteil ${(data.verdictNow.driftRatio * 100).toFixed(0)}%</td></tr>
    </table>
  `;
  card.querySelector('.badge-btn').addEventListener('click', () => {
    const f = (v) => moFmtSymPrice(v, bot.symbol);
    const inv = bot.investment > 0 ? ` · ${moFmtAmount(bot.investment)} ${moBotQuote(bot)}` : '';
    $('mo-whyTitle').innerHTML = `${pairLink(bot.symbol, bot.symbol, bot.quote)} <span class="badge ${rec.level}">${rec.text}</span>
      <span class="wy-sub">${bot.grids} Grids ${gridModeLabel(bot.mode).toLowerCase()} · Range ${f(bot.lower)}–${f(bot.upper)}${inv}</span>`;
    $('mo-whyBody').innerHTML = moRenderExplanation(bot, data);
    $('mo-whyDialog').showModal();
    $('mo-whyDialog').scrollTop = 0;
    moDrawWhyChart(bot, data);
  });
  return card;
}

function moRenderErrorCard(bot, message) {
  const card = document.createElement('div');
  card.className = 'bot-card';
  card.innerHTML = `
    <div class="head">
      <h4>${pairLink(bot.symbol, bot.symbol, bot.quote)} · ${bot.grids} Grids</h4>
      <span class="badge warn">Fehler</span>
    </div>
    <p class="note">${message}</p>
  `;
  return card;
}

async function moCheckAllBots() {
  const bots = loadBots();
  const status = $('mo-checkStatus');
  const results = $('mo-results');
  results.innerHTML = '';
  if (!bots.length) { status.textContent = 'Keine Bots hinterlegt.'; return; }

  $('mo-checkAllBtn').disabled = true;
  for (let i = 0; i < bots.length; i++) {
    const bot = bots[i];
    status.textContent = `Prüfe ${bot.symbol} (${i + 1}/${bots.length}) …`;
    try {
      const startMs = dateTimeToMs(bot.startDate, bot.startTime);
      const [candlesAtStart, candlesNow] = await Promise.all([
        fetchKlines(bot.symbol, '4h', { limit: 500, endTime: startMs }),
        fetchKlines(bot.symbol, '4h', { limit: 500 }),
      ]);
      if (candlesAtStart.length < 10 || candlesNow.length < 10) {
        results.appendChild(moRenderErrorCard(bot, 'Zu wenig Kursdaten für eine verlässliche Prüfung.'));
        continue;
      }
      const verdictAtStart = evaluateSuitability(candlesAtStart);
      const verdictNow = evaluateSuitability(candlesNow);
      const currentPrice = candlesNow[candlesNow.length - 1].close; // Close der laufenden 4h-Kerze = letzter Handelspreis
      const priceTime = Date.now();
      const outsidePct = moOutsidePct(currentPrice, bot.lower, bot.upper);
      const rec = moDecideRecommendation(verdictNow, verdictAtStart, outsidePct);
      const positionText = moPositionText(currentPrice, bot.lower, bot.upper);
      results.appendChild(moRenderBotCard(bot, { verdictAtStart, verdictNow, currentPrice, priceTime, positionText, rec, candlesNow }));
    } catch (e) {
      console.error(e);
      results.appendChild(moRenderErrorCard(bot, 'Fehler beim Laden der Kursdaten: ' + e.message));
    }
  }
  status.textContent = `Fertig – ${bots.length} Bot(s) geprüft.`;
  $('mo-checkAllBtn').disabled = false;
}

// Formular "Bot hinterlegen" vorausfüllen: Paar, Grids, Grenzen, aktueller Kurs, jetziger
// Zeitpunkt. Gespeichert wird erst mit "Bot hinzufügen".
async function moPrefillForm({ symbol, grids, lower, upper, mode = '', stopLoss = null, takeProfit = null }) {
  const sym = symbolMap.get(symbol);
  const dec = sym ? sym.decimals : null;
  const now = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  moEndEdit(); // Übernahme einer Empfehlung legt immer einen neuen Bot an
  $('mo-addBox').open = true; // Formular ist standardmässig eingeklappt
  selectPair($('mo-quote'), $('mo-symbol'), symbol);
  moSyncInvestUnit();
  $('mo-grids').value = grids;
  $('mo-mode').value = mode;
  $('mo-lower').value = priceToInput(lower, dec);
  $('mo-upper').value = priceToInput(upper, dec);
  $('mo-sl').value = stopLoss > 0 ? priceToInput(stopLoss, dec) : '';
  $('mo-tp').value = takeProfit > 0 ? priceToInput(takeProfit, dec) : '';
  $('mo-startDate').value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  $('mo-startTime').value = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  $('mo-startPrice').value = '';
  $('mo-investment').value = '';
  const status = $('mo-addStatus');
  status.textContent = 'Lade aktuellen Kurs …';
  try {
    const t = await apiGet('/api/v3/ticker/price', { symbol });
    if ($('mo-symbol').value !== symbol) return;
    $('mo-startPrice').value = priceToInput(+t.price, dec);
    status.textContent = 'Empfehlung übernommen – prüfen und mit „Bot hinzufügen“ speichern.';
  } catch (e) {
    status.textContent = 'Aktueller Kurs konnte nicht geladen werden – bitte Startkurs eintragen.';
  }
  $('mo-symbol').closest('.card').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Einheit hinter "Investment" = gewähltes Quote-Asset
function moSyncInvestUnit() {
  $('mo-investUnit').textContent = $('mo-quote').value || 'Quote-Asset';
}

function initMonitorTab() {
  moMigrateInvestments();
  initEquity();
  renderBotList();
  initWhyDialog('mo-whyDialog', 'mo-whyClose');
  $('mo-quote').addEventListener('change', moSyncInvestUnit);

  $('mo-addBtn').addEventListener('click', () => {
    const status = $('mo-addStatus');
    const symbol = $('mo-symbol').value.toUpperCase();
    const grids = parseInt($('mo-grids').value, 10);
    const lower = parseNum($('mo-lower').value);
    const upper = parseNum($('mo-upper').value);
    const startPrice = parseNum($('mo-startPrice').value);
    const startDate = $('mo-startDate').value;
    const startTime = $('mo-startTime').value;
    const investment = parseNum($('mo-investment').value);
    const mode = $('mo-mode').value;
    // Optional: leer = kein Stop-Loss / Take-Profit
    const slRaw = $('mo-sl').value.trim(), tpRaw = $('mo-tp').value.trim();
    const stopLoss = slRaw ? parseNum(slRaw) : null;
    const takeProfit = tpRaw ? parseNum(tpRaw) : null;

    if (!symbols.includes(symbol)) { status.textContent = 'Unbekanntes Währungspaar.'; return; }
    if (!(grids >= 2)) { status.textContent = 'Mindestens 2 Grids.'; return; }
    if (!GRID_MODES[mode]) { status.textContent = 'Bitte Grid-Modus wählen (Arithmetisch oder Geometrisch).'; return; }
    if (!(investment > 0)) { status.textContent = 'Bitte Investment angeben (grösser als 0).'; return; }
    if (!(lower > 0) || !(upper > lower)) { status.textContent = 'Obere Grenze muss grösser als die untere sein.'; return; }
    // Binance-Regel (Spot-Grid-FAQ): SL unter der unteren, TP über der oberen Grenze
    if (stopLoss != null && !(stopLoss > 0 && stopLoss < lower)) { status.textContent = 'Stop-Loss muss unter der unteren Grenze liegen (Binance-Vorgabe).'; return; }
    if (takeProfit != null && !(takeProfit > upper)) { status.textContent = 'Take-Profit muss über der oberen Grenze liegen (Binance-Vorgabe).'; return; }
    if (!(startPrice > 0)) { status.textContent = 'Bitte Startkurs angeben.'; return; }
    if (!startDate) { status.textContent = 'Bitte Startdatum angeben.'; return; }
    if (!(dateTimeToMs(startDate, startTime) <= Date.now())) { status.textContent = 'Startzeitpunkt darf nicht in der Zukunft liegen.'; return; }

    if (moEditId != null) {
      const bots = loadBots();
      const b = bots.find((x) => x.id === moEditId);
      if (!b) { moEndEdit(); status.textContent = 'Bot ist nicht mehr hinterlegt (inzwischen gestoppt?).'; return; }
      Object.assign(b, { grids, mode, lower, upper, stopLoss, takeProfit, startPrice, startDate, startTime, investment });
      saveBots(bots);
      moEndEdit();
      renderBotList();
      status.textContent = `${symbol} angepasst.`;
      moClearForm();
      return;
    }

    addBot({ symbol, grids, lower, upper, stopLoss, takeProfit, startPrice, startDate, startTime, investment, quote: symbolMap.get(symbol).quote, mode });
    status.textContent = 'Bot hinzugefügt.';
    moClearForm();
  });

  $('mo-cancelEditBtn').addEventListener('click', () => {
    moEndEdit();
    moClearForm();
    $('mo-addStatus').textContent = 'Anpassen abgebrochen.';
  });

  $('mo-checkAllBtn').addEventListener('click', moCheckAllBots);

  const d = new Date();
  $('mo-startDate').max = d.toISOString().slice(0, 10);
}

// ============================================================
// TAB 0: COIN SCANNER
// ============================================================
// Bewertung, ob sich ein Coin aktuell für einen Spot-Grid-Bot eignet. Kriterien aus der Literatur:
// - Seitwärts statt Trend: ADX(14) <20 seitwärts / >25 Trend (Wilder; Gainium, Coinrule),
//   Choppiness Index(14) >61.8 seitwärts / <38.2 Trend, Kaufman Efficiency Ratio >0.3–0.4 = Trend (LuxAlgo)
// - Genug Bewegung, damit der Grid-Abstand (0.7–2%) regelmässig gekreuzt wird (ATR%)
// - Liquidität (24h-Volumen) gegen Slippage
// - Praxisnachweis per Grid-Simulation (Backtest als verlässlichste Methode laut Gainium/Bitsgap)

const SC_STABLES = new Set(['USDC', 'FDUSD', 'TUSD', 'DAI', 'USDP', 'BUSD', 'USDE', 'PYUSD', 'USD1', 'XUSD', 'BFUSD',
  'RLUSD', 'USDS', 'EUR', 'EURI', 'AEUR', 'GBP', 'UST', 'USTC', 'SUSD', 'FRAX', 'LUSD', 'GUSD', 'USDD', 'EURC', 'U']);
const SC_CACHE_KEY = 'gridbot.scanner.v3'; // v3: geometrische Grid-Simulation

let scRows = [];              // [{symbol, base, price, change, volume, ...metrics}]
let scSort = { key: 'volume', dir: -1 };
let scAbort = false;
let scInitDone = false;

function scToDaily(c4) {
  const days = new Map();
  for (const c of c4) {
    const d = Math.floor(c.time / 86400000);
    const x = days.get(d);
    if (!x) days.set(d, { time: d * 86400000, open: c.open, high: c.high, low: c.low, close: c.close });
    else { x.high = Math.max(x.high, c.high); x.low = Math.min(x.low, c.low); x.close = c.close; }
  }
  return [...days.values()];
}

function scTrueRanges(d) {
  const tr = [];
  for (let i = 1; i < d.length; i++) {
    tr.push(Math.max(d[i].high - d[i].low, Math.abs(d[i].high - d[i - 1].close), Math.abs(d[i].low - d[i - 1].close)));
  }
  return tr;
}

// ADX nach Wilder (Glättung 1/n)
function scADX(d, n = 14) {
  if (d.length < 2 * n + 1) return null;
  const tr = [], pdm = [], mdm = [];
  for (let i = 1; i < d.length; i++) {
    const up = d[i].high - d[i - 1].high, down = d[i - 1].low - d[i].low;
    pdm.push(up > down && up > 0 ? up : 0);
    mdm.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(d[i].high - d[i].low, Math.abs(d[i].high - d[i - 1].close), Math.abs(d[i].low - d[i - 1].close)));
  }
  let sTR = 0, sP = 0, sM = 0;
  for (let i = 0; i < n; i++) { sTR += tr[i]; sP += pdm[i]; sM += mdm[i]; }
  const dx = [];
  const pushDx = () => {
    const pdi = sTR ? 100 * sP / sTR : 0, mdi = sTR ? 100 * sM / sTR : 0;
    dx.push(pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0);
  };
  pushDx();
  for (let i = n; i < tr.length; i++) {
    sTR = sTR - sTR / n + tr[i]; sP = sP - sP / n + pdm[i]; sM = sM - sM / n + mdm[i];
    pushDx();
  }
  if (dx.length < n) return null;
  let adx = dx.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < dx.length; i++) adx = (adx * (n - 1) + dx[i]) / n;
  return adx;
}

// Choppiness Index: 100 · log10(ΣTR / (maxHigh − minLow)) / log10(n)
function scCHOP(d, n = 14) {
  if (d.length < n + 1) return null;
  const last = d.slice(-n);
  const sumTR = scTrueRanges(d.slice(-(n + 1))).reduce((a, b) => a + b, 0);
  const range = Math.max(...last.map((x) => x.high)) - Math.min(...last.map((x) => x.low));
  if (!(range > 0) || !(sumTR > 0)) return null;
  return 100 * Math.log10(sumTR / range) / Math.log10(n);
}

// Kaufman Efficiency Ratio: |Nettoänderung| / Summe der Einzelbewegungen
function scER(d, n = 30) {
  if (d.length < n + 1) return null;
  const c = d.slice(-(n + 1)).map((x) => x.close);
  let path = 0;
  for (let i = 1; i < c.length; i++) path += Math.abs(c[i] - c[i - 1]);
  return path > 0 ? Math.abs(c[c.length - 1] - c[0]) / path : 0;
}

function scATRPct(d, n = 14) {
  if (d.length < n + 1) return null;
  const tr = scTrueRanges(d.slice(-(n + 1)));
  return tr.reduce((a, b) => a + b, 0) / tr.length / d[d.length - 1].close * 100;
}

// Lineare Punktevergabe zwischen zwei Schwellen (a -> 0 Punkte, b -> max Punkte)
function scLin(v, a, b, max) {
  if (v == null || !isFinite(v)) return 0;
  const t = (v - a) / (b - a);
  return Math.max(0, Math.min(1, t)) * max;
}

// Gemeinsame Eignungsbewertung für Scanner, Analyse-Tab und Monitoring. Das 24h-Volumen wird aus
// den letzten 6 4h-Kerzen genommen, damit alle Tabs mit identischen Eingaben rechnen (und die
// Bewertung auch für historische Zeitpunkte im Monitoring funktioniert).
function scEvaluate(c4) {
  const volume = c4.slice(-6).reduce((s, c) => s + (c.qv || 0), 0);
  const daily = scToDaily(c4);
  const price = c4[c4.length - 1].close;
  const adx = scADX(daily);
  const chop = scCHOP(daily);
  const er = scER(daily);
  const atrPct = scATRPct(daily);
  if (adx == null || chop == null || er == null || atrPct == null) return { error: 'Zu wenig Historie' };

  // Grid-Simulation: Range wie bei der Empfehlung (Support/Resistance, 90% Abdeckung),
  // Grid-Anzahl so, dass der Abstand an der Obergrenze des Literatur-Bands (~2%) liegt.
  const { rlow, rhigh } = computeSwingRange(c4, 5, price);
  const gc = Math.min(149, Math.max(2, Math.ceil(gridCountForSpacing(rlow, rhigh, 0.02))));
  const sim = optBacktest(c4, gc, rlow, rhigh, null, null, 1000, false);

  const reasons = [];
  const points = scPoints({ adx, chop, er, atrPct, gridProfit: sim.gridProfitPct, volume });
  const score = Math.round(points.adx + points.chop + points.er + points.atr + points.sim + points.vol);

  if (adx > 25) reasons.push(`Trend (ADX ${adx.toFixed(0)})`);
  if (chop < 38.2) reasons.push('gerichtete Bewegung (CHOP niedrig)');
  if (er > 0.4) reasons.push('effizienter Trend (ER hoch)');
  if (atrPct < 2) reasons.push('wenig Bewegung');
  if (atrPct > 8) reasons.push('sehr volatil');
  if (sim.gridProfitPct < 3) reasons.push('schwache Grid-Simulation');

  let cls = score >= 65 ? 'good' : score >= 45 ? 'warn' : 'bad';
  // Konsistenz mit der Eignungsprüfung im Analyse-Tab (83-Tage-Trend / zu enge Spanne)
  const assess = assessSuitability(c4);
  let downgraded = false;
  if (assess.cls === 'bad' && cls === 'good') {
    cls = 'warn';
    downgraded = true;
    reasons.push('Eignungsprüfung negativ (83-Tage-Trend)');
  }
  const isStableLike = price > 0.97 && price < 1.03 && atrPct < 0.5;
  return {
    adx, chop, er, atrPct, gridProfit: sim.gridProfitPct, gridTrades: sim.tradeCount, gc, score, cls, reasons, isStableLike, points, volume, downgraded,
    rangePct: assess.rangePct, driftRatio: assess.driftRatio,
  };
}

// Punkte je Kriterium (Summe = Score, max. 100)
function scPoints({ adx, chop, er, atrPct, gridProfit, volume }) {
  let pAdx;
  if (adx <= 20) pAdx = 25;
  else if (adx <= 25) pAdx = 25 - (adx - 20) / 5 * 10;
  else pAdx = Math.max(0, 15 - (adx - 25) / 15 * 15);
  let pAtr;
  if (atrPct < 1) pAtr = 0;
  else if (atrPct < 2) pAtr = (atrPct - 1) * 15;
  else if (atrPct <= 8) pAtr = 15;
  else pAtr = Math.max(5, 15 - (atrPct - 8) / 7 * 10);
  return {
    adx: pAdx,
    chop: scLin(chop, 38.2, 61.8, 15),
    er: 15 - scLin(er, 0.1, 0.4, 15),
    atr: pAtr,
    sim: scLin(gridProfit, 0, 15, 20),
    vol: scLin(Math.log10(Math.max(1, volume)), 6, 8, 10),
  };
}

// Eignungsurteil für Analyse-Tab und Monitoring auf Basis derselben Bewertung wie der Scanner.
// Fallback auf die einfache Spannen/Drift-Prüfung, wenn für den Score zu wenig Historie da ist.
function evaluateSuitability(c4) {
  const assess = assessSuitability(c4);
  const ev = c4.length >= 60 ? scEvaluate(c4) : { error: 'Zu wenig Historie' };
  if (ev.error) return { ...assess, score: null, ev: null };
  const why = ev.reasons.length ? ` Einschränkungen: ${ev.reasons.join(', ')}.` : '';
  const text = {
    good: `Gut geeignet (Score ${ev.score}/100): Die Kriterien (Seitwärtsbewegung, Schwankung, Grid-Simulation, Liquidität) sprechen insgesamt für einen Grid-Bot.${why}`,
    warn: `Bedingt geeignet (Score ${ev.score}/100): Einige Kriterien sprechen gegen einen Grid-Bot.${why}`,
    bad: `Ungeeignet (Score ${ev.score}/100): Die Kursbewegung passt aktuell nicht zu einem Grid-Bot.${why}`,
  }[ev.cls];
  return { ...assess, cls: ev.cls, verdict: text, score: ev.score, ev };
}

function scFmtVol(v) {
  if (v >= 1e9) return fmt(v / 1e9, 2) + ' Mrd';
  if (v >= 1e6) return fmt(v / 1e6, 1) + ' Mio';
  if (v >= 1e3) return fmt(v / 1e3, 0) + ' Tsd';
  return fmt(v, 0);
}

function scVisibleRows() {
  const q = $('sc-search').value.trim().toUpperCase();
  const minVol = parseFloat($('sc-minVol').value) || 0;
  const cls = $('sc-class').value;
  return scRows.filter((r) => {
    if (r.isStableLike) return false;
    if (q && !r.base.includes(q) && !r.symbol.includes(q)) return false;
    if (r.volume < minVol) return false;
    if (cls === 'none') return r.cls == null;
    if (cls && r.cls !== cls) return false;
    return true;
  });
}

function scRender() {
  const rows = scVisibleRows();
  const { key, dir } = scSort;
  const clsRank = { good: 3, warn: 2, bad: 1 };
  const val = (r) => (key === 'cls' ? clsRank[r.cls] || 0 : r[key]);
  rows.sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1; // unbewertete immer ans Ende
    if (vb == null) return -1;
    if (typeof va === 'string') return va.localeCompare(vb) * dir;
    return (va - vb) * dir;
  });
  document.querySelectorAll('.scan-table th[data-sort]').forEach((th) => {
    const active = th.dataset.sort === key;
    th.classList.toggle('sorted', active);
    th.textContent = th.textContent.replace(/ [▲▼]$/, '') + (active ? (dir > 0 ? ' ▲' : ' ▼') : '');
  });
  const n = (v, d) => (v == null ? '–' : v.toFixed(d));
  $('sc-list').innerHTML = rows.map((r) => `
    <tr${r.reasons && r.reasons.length ? ` title="${r.reasons.join(', ')}"` : ''}>
      <td><b>${pairLink(r.symbol, r.base)}</b></td>
      <td class="num">${fmtPrice(r.price, symbolMap.get(r.symbol)?.decimals).replace(/0+$/, '').replace(/,$/, '')}</td>
      <td class="num ${r.change >= 0 ? 'pos' : 'neg'}">${r.change >= 0 ? '+' : ''}${r.change.toFixed(1)}%</td>
      <td class="num">${scFmtVol(r.volume)}</td>
      <td class="num"><b>${r.score ?? '–'}</b></td>
      <td>${r.cls ? `<button type="button" class="badge badge-btn ${r.cls}" data-why="${r.symbol}" title="Warum diese Einstufung?">${verdictLabel(r.cls)}</button>` : (r.error ? `<span class="status">${r.error}</span>` : '<span class="status">–</span>')}</td>
      <td class="num">${n(r.adx, 0)}</td>
      <td class="num">${n(r.chop, 0)}</td>
      <td class="num">${n(r.er, 2)}</td>
      <td class="num">${r.atrPct == null ? '–' : r.atrPct.toFixed(1) + '%'}</td>
      <td class="num">${r.gridProfit == null ? '–' : r.gridProfit.toFixed(1) + '%'}</td>
      <td class="num">${scMinInvestCell(r)}</td>
      <td><button type="button" class="secondary" data-analyse="${r.symbol}">Analysieren</button></td>
    </tr>`).join('');
  const rated = scRows.filter((r) => r.cls).length;
  $('sc-count').textContent = `${rows.length} Coins angezeigt · ${rated} bewertet`;
  scUpdateMinInvTitle();
}

// Spalte "Mindestinvest": Wert, "rechnet …" oder Button "berechnen" (auch nach einem Fehler, mit Grund im Tooltip)
function scMinInvestCell(r) {
  if (r.minInvest != null) {
    return `<span data-mininv-at="${r.minInvestAt || ''}" title="${escapeHtml(scMinInvestAgeTitle(r.minInvestAt))}">${fmt(r.minInvest, 0)} USDT</span>`;
  }
  if (r.minInvestBusy) return '<span class="status">rechnet …</span>';
  return `<button type="button" class="secondary" data-mininv="${r.symbol}"${r.minInvestErr ? ` title="${escapeHtml(r.minInvestErr)} – erneut versuchen"` : ''}>berechnen</button>`;
}

// Tooltip zum Mindestinvest: Berechnungszeitpunkt, Alter und Hinweis, sobald seit der Berechnung eine neue
// 1h-Kerze begonnen hat (die Empfehlung basiert auf 1h-Kerzen und kann sich dadurch ändern)
function scMinInvestAgeTitle(at) {
  if (!at) return 'Berechnungszeitpunkt unbekannt – Wert kann veraltet sein. Mit „Analysieren“ neu berechnen.';
  const d = new Date(at).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' });
  const min = Math.max(0, Math.floor((Date.now() - at) / 60000));
  const age = min < 1 ? 'gerade eben'
    : min < 60 ? `vor ${min} Min.`
    : min < 1440 ? `vor ${Math.floor(min / 60)} Std. ${min % 60} Min.`
    : `vor ${Math.floor(min / 1440)} ${Math.floor(min / 1440) === 1 ? 'Tag' : 'Tagen'}`;
  const stale = Math.floor(Date.now() / 3600000) > Math.floor(at / 3600000);
  return `Berechnet am ${d} (${age}).` + (stale
    ? '\nMöglicherweise veraltet: Seit der Berechnung sind neue 1h-Kerzen dazugekommen. Die Empfehlung (v. a. die Anzahl Grids) und damit der Mindestinvest können sich geändert haben. Aktueller Wert über „Analysieren“.'
    : '\nAktuell: seit der Berechnung noch keine neue 1h-Kerze.');
}

// Dauer einer Mindestinvest-Berechnung pro Coin (Laden + Optimierung): gleitender Mittelwert der
// tatsächlich gemessenen Zeiten, gespeichert im Browser. Startwert 4,5 s (gemessen: 4 Coins in 18 s
// inkl. Laden der Kerzen, Optimierung, Ordervorgaben und Kurs).
const SC_MININV_MS_KEY = 'gridbot.scanner.minInvestMs';
function scMinInvestMsPerCoin() {
  try { return +localStorage.getItem(SC_MININV_MS_KEY) || 4500; } catch (e) { return 4500; }
}
function scRecordMinInvestMs(ms) {
  try { localStorage.setItem(SC_MININV_MS_KEY, String(Math.round(scMinInvestMsPerCoin() * 0.7 + ms * 0.3))); } catch (e) { /* ohne Speicher weiter */ }
}
function scFmtDuration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} Sekunden`;
  const min = Math.round(s / 60);
  if (min < 60) return min === 1 ? '1 Minute' : `${min} Minuten`;
  return `${Math.floor(min / 60)} Std. ${min % 60} Min.`;
}

// Tooltip des Buttons "Mindestinvest für gut geeignete Coins berechnen": geschätzte Dauer für die angezeigten Coins
function scUpdateMinInvTitle() {
  const n = scVisibleRows().filter((r) => r.cls === 'good' && r.minInvest == null).length;
  $('sc-minInvBtn').title = n
    ? `Die Berechnung dauert ca. ${scFmtDuration(n * (scMinInvestMsPerCoin() + 30))} (${n} ${n === 1 ? 'Coin' : 'Coins'} à ca. ${fmt(scMinInvestMsPerCoin() / 1000, 1)} s).`
    : 'Keine angezeigten gut geeigneten Coins ohne Mindestinvest.';
}

// Mindestinvest eines Coins über dieselbe Startempfehlung wie im Tab "Analyse & Optimierung" berechnen
async function scCalcMinInvest(r) {
  if (r.minInvestBusy) return;
  r.minInvestBusy = true;
  r.minInvestErr = null;
  scRender();
  const t0 = performance.now();
  try {
    const { rec } = await anComputeStartRec(r.symbol);
    if (rec.minInvest) {
      r.minInvest = rec.minInvest.total;
      r.minInvestAt = Date.now();
      scRecordMinInvestMs(performance.now() - t0);
    } else {
      r.minInvestErr = 'Binance-Ordervorgaben konnten nicht geladen werden';
    }
  } catch (e) {
    r.minInvestErr = 'Berechnung fehlgeschlagen: ' + e.message;
  }
  r.minInvestBusy = false;
  scSaveCache();
  scRender();
}

// Button "Mindestinvest für gut geeignete Coins berechnen": alle angezeigten "Gut geeignet"-Coins ohne Wert
// nacheinander berechnen (nach einem Fehler erneut). Die Optimierung blockiert die Seite ~1 s
// pro Coin, deshalb einzeln mit kurzer Pause, damit Liste und Status aktualisiert werden.
let scMinInvRunning = false;
async function scMinInvestGood() {
  if (scMinInvRunning) return;
  // Nur die aktuell angezeigten Coins (Filter Suche / Min. Volumen / Einstufung)
  const visibleGood = scVisibleRows().filter((r) => r.cls === 'good');
  const todo = visibleGood.filter((r) => r.minInvest == null);
  if (!todo.length) {
    $('sc-status').textContent = visibleGood.length ? 'Alle angezeigten gut geeigneten Coins haben bereits einen Mindestinvest.' : 'Keine gut geeigneten Coins in der Anzeige – Filter prüfen oder zuerst „Alle bewerten“.';
    return;
  }
  scMinInvRunning = true;
  scAbort = false;
  $('sc-scanBtn').disabled = true;
  $('sc-minInvBtn').disabled = true;
  $('sc-stopBtn').classList.remove('hidden');
  let done = 0;
  for (const r of todo) {
    if (scAbort) break;
    $('sc-status').textContent = `Berechne Mindestinvest der gut geeigneten Coins … ${done + 1}/${todo.length} (${r.base})`;
    await new Promise((res) => setTimeout(res, 30));
    await scCalcMinInvest(r);
    done++;
  }
  const failed = todo.filter((r) => r.minInvestErr).length;
  $('sc-status').textContent = `${scAbort ? 'Abgebrochen' : 'Fertig'} – Mindestinvest für ${done - failed} von ${todo.length} gut geeigneten Coins berechnet${failed ? `, ${failed} Fehler` : ''} (${new Date().toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' })}).`;
  $('sc-scanBtn').disabled = false;
  $('sc-minInvBtn').disabled = false;
  $('sc-stopBtn').classList.add('hidden');
  scMinInvRunning = false;
}

function scSaveCache() {
  try {
    const metrics = scRows.filter((r) => r.cls || r.error || r.minInvest != null).map((r) => ({
      minInvest: r.minInvest, minInvestAt: r.minInvestAt,
      symbol: r.symbol, adx: r.adx, chop: r.chop, er: r.er, atrPct: r.atrPct, gridProfit: r.gridProfit,
      gridTrades: r.gridTrades, gc: r.gc, score: r.score, cls: r.cls, reasons: r.reasons, error: r.error, isStableLike: r.isStableLike,
      evVolume: r.evVolume, downgraded: r.downgraded, rangePct: r.rangePct, driftRatio: r.driftRatio, ratedAt: r.ratedAt,
    }));
    localStorage.setItem(SC_CACHE_KEY, JSON.stringify({ time: Date.now(), metrics }));
  } catch (e) { /* Speicher nicht verfügbar – ohne Cache weiter */ }
}

function scLoadCache() {
  try {
    const raw = localStorage.getItem(SC_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

async function scLoadMarket() {
  const tickers = await apiGet('/api/v3/ticker/24hr');
  const byS = new Map(tickers.map((t) => [t.symbol, t]));
  scRows = symbolMeta
    .filter((s) => s.quote === 'USDT' && !SC_STABLES.has(s.base) && byS.has(s.symbol))
    .map((s) => {
      const t = byS.get(s.symbol);
      return { symbol: s.symbol, base: s.base, price: +t.lastPrice, change: +t.priceChangePercent, volume: +t.quoteVolume };
    });
  const cache = scLoadCache();
  if (cache) {
    const m = new Map(cache.metrics.map((x) => [x.symbol, x]));
    for (const r of scRows) if (m.has(r.symbol)) Object.assign(r, { ratedAt: cache.time }, m.get(r.symbol));
    return cache.time;
  }
  return null;
}

async function scScanAll() {
  const targets = scVisibleRows();
  if (!targets.length) { $('sc-status').textContent = 'Keine Coins im Filter.'; return; }
  scAbort = false;
  $('sc-scanBtn').disabled = true;
  $('sc-minInvBtn').disabled = true;
  $('sc-stopBtn').classList.remove('hidden');
  let done = 0, failed = 0, next = 0;
  const worker = async () => {
    while (!scAbort && next < targets.length) {
      const r = targets[next++];
      try {
        const c4 = await fetchKlines(r.symbol, '4h', { limit: 500 });
        const res = c4.length >= 60 ? scEvaluate(c4) : { error: 'Zu wenig Historie' };
        for (const k of ['adx', 'chop', 'er', 'atrPct', 'gridProfit', 'gridTrades', 'gc', 'score', 'cls', 'reasons', 'error',
          'evVolume', 'downgraded', 'rangePct', 'driftRatio', 'points', 'minInvest', 'minInvestAt', 'minInvestErr']) r[k] = null;
        Object.assign(r, res, { ratedAt: Date.now() });
        if (res.volume != null) r.evVolume = res.volume;
      } catch (e) {
        failed++;
        r.error = 'Ladefehler';
      }
      done++;
      $('sc-status').textContent = `Bewerte … ${done}/${targets.length}${failed ? ` (${failed} Fehler)` : ''}`;
      if (done % 20 === 0) scRender();
    }
  };
  // 6 parallele Anfragen: schnell genug, aber weit unter dem Binance-Gewichtslimit
  await Promise.all(Array.from({ length: 6 }, worker));
  scSaveCache();
  if (scSort.key === 'volume') scSort = { key: 'score', dir: -1 };
  scRender();
  $('sc-status').textContent = `${scAbort ? 'Abgebrochen' : 'Fertig'} – ${done} Coins bewertet${failed ? `, ${failed} Fehler` : ''} (${new Date().toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' })}).`;
  $('sc-scanBtn').disabled = false;
  $('sc-minInvBtn').disabled = false;
  $('sc-stopBtn').classList.add('hidden');
}

async function scEnsureInit() {
  if (scInitDone || !symbolMeta.length) return;
  scInitDone = true;
  $('sc-status').textContent = 'Lade Marktdaten …';
  try {
    const cacheTime = await scLoadMarket();
    scRender();
    $('sc-status').textContent = cacheTime
      ? `Letzte Bewertung: ${new Date(cacheTime).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' })}`
      : '';
    $('sc-scanBtn').disabled = false;
    $('sc-minInvBtn').disabled = false;
  } catch (e) {
    scInitDone = false;
    $('sc-status').textContent = 'Marktdaten konnten nicht geladen werden: ' + e.message;
  }
}

// Scanner-Zeile → Analyse-Tab mit diesem Paar öffnen und prüfen
function scGoAnalyse(symbol) {
  document.querySelector('.tab-btn[data-tab="analyse"]').click();
  if (!selectPair($('an-quote'), $('an-pair'), symbol)) return;
  $('an-checkBtn').disabled = false;
  $('an-checkBtn').click();
}

// Modal "Warum diese Einstufung?": Score, Punkte je Kriterium mit Messwert und Fakt, Kursverlauf der bewerteten Tage
function scOpenWhy(symbol) {
  const r = scRows.find((x) => x.symbol === symbol);
  if (r) scShowWhy(r);
}

// Modal für ein Zeilenobjekt (Scanner-Zeile oder Analyse-Ergebnis); fromAnalyse blendet "Analysieren" aus
function scShowWhy(r, { fromAnalyse = false } = {}) {
  if (!r || !r.cls) return;
  const volume = r.evVolume ?? r.volume;
  // Ältere Cache-Einträge enthalten keine Einzelpunkte – aus den gespeicherten Kennzahlen neu berechnen
  const points = r.points || scPoints({ adx: r.adx, chop: r.chop, er: r.er, atrPct: r.atrPct, gridProfit: r.gridProfit, volume });
  const downgraded = r.downgraded ?? (r.reasons || []).some((x) => x.startsWith('Eignungsprüfung negativ'));
  const rt = wyRating({ ...r, volume, points, downgraded }, r.score, r.cls, r.rangePct, r.driftRatio);
  const { crit, score, cls } = rt;

  const losers = crit.filter((c) => c.lost >= 3).sort((a, b) => b.lost - a.lost);
  const winners = crit.filter((c) => c.st === 'good').sort((a, b) => b.pts - a.pts);
  const lostSum = Math.round(crit.reduce((s, c) => s + c.lost, 0));
  const top = losers.slice(0, 2);
  const topLost = Math.round(top.reduce((s, c) => s + c.lost, 0));
  const topNames = top.map((c) => c.name).join(' und ');
  const lead = {
    good: `${winners.length} von 6 Kriterien passen. ${losers.length ? `Punkte verloren vor allem bei ${topNames}.` : 'Kaum Punkte verloren.'}`,
    warn: rt.downgraded
      ? 'Nach Punkten „Gut geeignet“, aber die 83-Tage-Prüfung schlägt an – deshalb nur „Bedingt geeignet“.'
      : top.length ? `Gemischtes Bild: ${topNames} kost${top.length === 1 ? 'et' : 'en zusammen'} ${wyPlural(topLost, 'Punkt', 'Punkte')}.` : 'Gemischtes Bild: viele kleine Abzüge.',
    bad: top.length ? `${topNames} kost${top.length === 1 ? 'et' : 'en zusammen'} ${topLost} der ${lostSum} verlorenen Punkte.` : `${lostSum} Punkte verloren, verteilt auf mehrere Kriterien.`,
  }[cls] + (cls !== 'good' && winners.length ? ` Stark: ${winners.map((c) => c.name).join(', ')}.` : '');
  const levers = crit.filter((c) => c.lost >= 1).sort((a, b) => b.lost - a.lost).slice(0, 3);
  const f = (v) => moFmtSymPrice(v, r.symbol);

  $('sc-whyTitle').innerHTML = `${pairLink(r.symbol, `${r.base}/${r.quote || 'USDT'}`, r.quote || 'USDT')} <span class="badge ${cls}">${verdictLabel(cls)}</span>`;
  $('sc-whyBody').innerHTML = `
    <div class="wy-sec">
      <div class="wy-score-row"><span class="wy-score-big">${score}<small> / 100 Punkte</small></span><span class="wy-score-note">${wyDistance(rt)}</span></div>
      ${wyScale(score)}
      <div class="wy-lead ${cls}"><b>Kurz gesagt:</b> ${lead}</div>
    </div>
    <div class="wy-sec">
      <h4 class="wy-h">Wo die Punkte herkommen</h4>
      ${wyPointsBar(rt)}
    </div>
    <div class="wy-sec">
      <h4 class="wy-h">Messwerte und Punkte</h4>
      ${wyCritTable(rt)}
    </div>
    <div class="wy-sec">
      <h4 class="wy-h">Kursverlauf der bewerteten 83 Tage</h4>
      ${wyChartBox('sc-whyChart')}
      <div id="sc-whyFacts">${wyFacts([
        ['…', 'Veränderung Start → Ende'],
        [r.rangePct != null ? wyNf(r.rangePct, 1) + ' %' : '–', 'Spanne Tief → Hoch'],
        [r.driftRatio != null ? wyNf(r.driftRatio * 100, 0) + ' %' : '–', 'Trend-Anteil (Netto ÷ Spanne)'],
        ['…', 'Kurs bei Bewertung'],
      ])}</div>
      ${wyGate(rt)}
    </div>
    <div class="wy-sec">
      <h4 class="wy-h">${cls === 'good' ? 'Wo noch Punkte liegen' : 'Was müsste sich ändern?'}</h4>
      ${levers.length ? levers.map((c) => `<div class="wy-lever"><span>${c.name}: aktuell ${c.value}, voll bei ${c.ideal}</span><b class="wy-good-txt">bis +${wyNf(c.lost, 1)} P.</b></div>`).join('') : '<p class="wy-hint">Alle Kriterien voll erfüllt.</p>'}
      ${wyHow(rt)}
    </div>
    <div class="wy-foot">
      <span>Bewertet am ${r.ratedAt ? new Date(r.ratedAt).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' }) : '–'} · Basis: 500 4h-Kerzen (~83 Tage). Momentaufnahme, keine Anlageberatung.</span>
      ${fromAnalyse ? '' : '<button type="button" class="primary" id="sc-whyAnalyse">Analysieren</button>'}
    </div>
  `;
  if (!fromAnalyse) $('sc-whyAnalyse').addEventListener('click', () => { $('sc-whyDialog').close(); scGoAnalyse(r.symbol); });
  $('sc-whyDialog').showModal();
  $('sc-whyDialog').scrollTop = 0;
  scDrawWhyChart(r, f);
}

// Kursverlauf zur Bewertung nachladen (Kerzen werden im Scanner nicht gespeichert)
async function scDrawWhyChart(r, f) {
  const el = $('sc-whyChart');
  el.querySelector('svg').outerHTML = '<p class="wy-hint wy-chart-msg">Kursverlauf wird geladen …</p><svg></svg>';
  let c4;
  try {
    c4 = await fetchKlines(r.symbol, '4h', r.ratedAt ? { limit: 500, endTime: r.ratedAt } : { limit: 500 });
  } catch (e) {
    c4 = [];
  }
  // Modal inzwischen geschlossen oder für einen anderen Coin geöffnet?
  if ($('sc-whyChart') !== el || !$('sc-whyDialog').open) return;
  const msg = el.querySelector('.wy-chart-msg');
  const daily = scToDaily(c4);
  if (daily.length < 2) { msg.textContent = 'Kursverlauf konnte nicht geladen werden.'; return; }
  msg.remove();
  const closes = daily.map((d) => d.close);
  const first = c4[0].close, last = c4[c4.length - 1].close;
  const hi = Math.max(...c4.map((c) => c.high)), lo = Math.min(...c4.map((c) => c.low));
  const chg = (last - first) / first * 100;
  $('sc-whyFacts').innerHTML = wyFacts([
    [wyPct(chg), 'Veränderung Start → Ende', chg >= 0 ? 'good' : 'bad'],
    [r.rangePct != null ? wyNf(r.rangePct, 1) + ' %' : wyNf((hi - lo) / lo * 100, 1) + ' %', 'Spanne Tief → Hoch'],
    [r.driftRatio != null ? wyNf(r.driftRatio * 100, 0) + ' %' : '–', 'Trend-Anteil (Netto ÷ Spanne)'],
    [f(last), 'Kurs bei Bewertung'],
  ]);
  wyLineChart(el, {
    series: closes, t0: daily[0].time, dt: 864e5, fmt: f, trend: true,
    hlines: [{ v: hi, label: 'Hoch' }, { v: lo, label: 'Tief' }],
    note: 'gestrichelt = Netto-Richtung Start → Ende',
  });
}

// Erklär-Modal: "Schliessen", Esc (nativ) oder Klick auf den abgedunkelten Hintergrund schliesst es
function initWhyDialog(dialogId, closeId) {
  const dlg = $(dialogId);
  $(closeId).addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (ev) => {
    const d = dlg.getBoundingClientRect();
    if (ev.clientX < d.left || ev.clientX > d.right || ev.clientY < d.top || ev.clientY > d.bottom) dlg.close();
  });
}

function initScannerTab() {
  ['sc-search', 'sc-minVol', 'sc-class'].forEach((id) => $(id).addEventListener('input', scRender));
  document.querySelectorAll('.scan-table th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      scSort = scSort.key === key ? { key, dir: -scSort.dir } : { key, dir: key === 'base' ? 1 : -1 };
      scRender();
    });
  });
  $('sc-scanBtn').addEventListener('click', scScanAll);
  $('sc-minInvBtn').addEventListener('click', scMinInvestGood);
  // Schätzung erst beim Überfahren berechnen: Filter und Werte können sich seit dem letzten Rendern geändert haben
  $('sc-minInvBtn').addEventListener('mouseenter', scUpdateMinInvTitle);
  $('sc-stopBtn').addEventListener('click', () => { scAbort = true; });
  initWhyDialog('sc-whyDialog', 'sc-whyClose');
  // Alter beim Überfahren neu berechnen, damit der Tooltip auch ohne neues Rendern stimmt
  $('sc-list').addEventListener('mouseover', (ev) => {
    const el = ev.target.closest('[data-mininv-at]');
    if (el) el.title = scMinInvestAgeTitle(+el.dataset.mininvAt || null);
  });
  $('sc-list').addEventListener('click', (ev) => {
    const why = ev.target.closest('[data-why]');
    if (why) { scOpenWhy(why.dataset.why); return; }
    const inv = ev.target.closest('[data-mininv]');
    if (inv) {
      const r = scRows.find((x) => x.symbol === inv.dataset.mininv);
      if (r) scCalcMinInvest(r);
      return;
    }
    const btn = ev.target.closest('[data-analyse]');
    if (btn) scGoAnalyse(btn.dataset.analyse);
  });
  document.querySelector('.tab-btn[data-tab="scanner"]').addEventListener('click', scEnsureInit);
}

// ============================================================
// TABS + INIT
// ============================================================

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((p) => p.classList.add('hidden'));
      btn.classList.add('active');
      $('panel-' + btn.dataset.tab).classList.remove('hidden');
    });
  });
}

(async function init() {
  initTabs();
  ['an-quote', 'an-pair', 'bt-quote', 'bt-symbol', 'mo-quote', 'mo-symbol'].forEach((id) => makeSearchable($(id)));
  initAnalyseTab();
  await moLoadFromStore(); // vor initMonitorTab: Migrationen und Liste arbeiten mit dem Stand aus data/bots.json
  initMonitorTab();
  initScannerTab();

  $('an-loadStatus').textContent = 'Lade Handelspaare …';
  try {
    await loadAllSymbols();
    for (const [q, p] of [['an-quote', 'an-pair'], ['mo-quote', 'mo-symbol']]) {
      fillQuoteSelect($(q));
      fillPairSelect($(q), $(p));
      $(q).addEventListener('change', () => fillPairSelect($(q), $(p)));
    }
    initBacktestTab();
    moSyncInvestUnit();
    renderBotList(); // Quote-Einheiten älterer Einträge sind erst jetzt bekannt
    if (!$('panel-scanner').classList.contains('hidden')) scEnsureInit();
    $('an-loadStatus').textContent = '';
    $('an-checkBtn').disabled = false;
  } catch (e) {
    $('an-loadStatus').textContent = 'Handelspaare konnten nicht geladen werden: ' + e.message;
  }
})();
