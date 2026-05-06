/**
 * Core data access logic.
 */
import { evaluate, evaluateAsync, KNOWN_PATHS, safeString } from '../connection.js';
import { waitForChartReady } from '../wait.js';

const MAX_OHLCV_BARS = 500;
const MAX_TRADES = 20;
const CHART_API = KNOWN_PATHS.chartApi;
const BARS_PATH = KNOWN_PATHS.mainSeriesBars;

// Serializes getQuote() calls that mutate chart symbol so concurrent callers
// can't race over the shared chart state. JS is single-threaded but our
// awaits interleave; without this every parallel quote_get(symbol) would
// read whichever symbol the chart happened to be on at evaluate() time.
let _quoteLock = Promise.resolve();

function buildGraphicsJS(collectionName, mapKey, filter) {
  return `
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      var filter = ${safeString(filter || '')};
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          if (filter && name.indexOf(filter) === -1) continue;
          var g = s._graphics;
          if (!g || !g._primitivesCollection) continue;
          var pc = g._primitivesCollection;
          var items = [];
          try {
            var outer = pc.${collectionName};
            if (outer) {
              var inner = outer.get('${mapKey}');
              if (inner) {
                var coll = inner.get(false);
                if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                  coll._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            }
          } catch(e) {}
          if (items.length === 0 && '${collectionName}' === 'dwgtablecells') {
            try {
              var tcOuter = pc.dwgtablecells;
              if (tcOuter) {
                var tcColl = tcOuter.get('tableCells');
                if (tcColl && tcColl._primitivesDataById && tcColl._primitivesDataById.size > 0) {
                  tcColl._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            } catch(e) {}
          }
          if (items.length > 0) results.push({name: name, count: items.length, items: items});
        } catch(e) {}
      }
      return results;
    })()
  `;
}

export async function getOhlcv({ count, summary } = {}) {
  const limit = Math.min(count || 100, MAX_OHLCV_BARS);
  let data;
  try {
    data = await evaluate(`
      (function() {
        var bars = ${BARS_PATH};
        if (!bars || typeof bars.lastIndex !== 'function') return null;
        var result = [];
        var end = bars.lastIndex();
        var start = Math.max(bars.firstIndex(), end - ${limit} + 1);
        for (var i = start; i <= end; i++) {
          var v = bars.valueAt(i);
          if (v) result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
        }
        return {bars: result, total_bars: bars.size(), source: 'direct_bars'};
      })()
    `);
  } catch { data = null; }

  if (!data || !data.bars || data.bars.length === 0) {
    throw new Error('Could not extract OHLCV data. The chart may still be loading.');
  }

  if (summary) {
    const bars = data.bars;
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const volumes = bars.map(b => b.volume);
    const first = bars[0];
    const last = bars[bars.length - 1];
    return {
      success: true, bar_count: bars.length,
      period: { from: first.time, to: last.time },
      open: first.open, close: last.close,
      high: Math.max(...highs), low: Math.min(...lows),
      range: Math.round((Math.max(...highs) - Math.min(...lows)) * 100) / 100,
      change: Math.round((last.close - first.open) * 100) / 100,
      change_pct: Math.round(((last.close - first.open) / first.open) * 10000) / 100 + '%',
      avg_volume: Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length),
      last_5_bars: bars.slice(-5),
    };
  }

  return { success: true, bar_count: data.bars.length, total_available: data.total_bars, source: data.source, bars: data.bars };
}

export async function getIndicator({ entity_id }) {
  const data = await evaluate(`
    (function() {
      var api = ${CHART_API};
      var study = api.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var result = { name: null, inputs: null, visible: null };
      try { result.visible = study.isVisible(); } catch(e) {}
      try { result.inputs = study.getInputValues(); } catch(e) { result.inputs_error = e.message; }
      return result;
    })()
  `);

  if (data?.error) throw new Error(data.error);

  let inputs = data?.inputs;
  if (Array.isArray(inputs)) {
    inputs = inputs.filter(inp => {
      if (inp.id === 'text' && typeof inp.value === 'string' && inp.value.length > 200) return false;
      if (typeof inp.value === 'string' && inp.value.length > 500) return false;
      return true;
    });
  }
  return { success: true, entity_id, visible: data?.visible, inputs };
}

const FIND_STRATEGY_SRC = `
  function __findStrategy(sources) {
    // Pass 0 (TV 3.1.0+): metaInfo().id starts with "StrategyScript"
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      try {
        var id = s.metaInfo && (s.metaInfo() || {}).id;
        if (id && /^StrategyScript/.test(String(id))) return s;
      } catch(e) {}
    }
    // Pass 1: ordersData is the definitive marker (only strategies have it)
    for (var j = 0; j < sources.length; j++) {
      if (sources[j].ordersData) return sources[j];
    }
    // Pass 2: metaInfo strategy markers
    var skip = ['volume','dividends','splits','earnings','dates calculator'];
    for (var k = 0; k < sources.length; k++) {
      var t = sources[k];
      try {
        if (!t.metaInfo) continue;
        var mi = t.metaInfo();
        var desc = (mi.description || mi.shortDescription || '').toLowerCase();
        var isBuiltIn = false;
        for (var sk = 0; sk < skip.length; sk++) { if (desc.indexOf(skip[sk]) !== -1) { isBuiltIn = true; break; } }
        if (isBuiltIn) continue;
        if (mi.pine && mi.pine.scriptType === 'strategy') return t;
        if (mi.scriptType === 'strategy') return t;
        if (mi.is_price_study === false && (t.ordersData || t.reportData || t._reportData)) return t;
      } catch(e) {}
    }
    return null;
  }
`;

// DOM-scrape fallback for strategy report (upstream #96).
// Used when internal-API paths return empty — TV virtualizes both panels,
// so this only scrapes currently-rendered rows.
const DOM_SCRAPE_STRATEGY_REPORT = `
  (function() {
    try {
      var lines = document.body.innerText.split('\\n').map(function(l){return l.trim();}).filter(Boolean);
      var startIdx = lines.indexOf('Strategy Report');
      if (startIdx < 0) return { metrics: {}, error: 'Strategy Tester panel not open (no "Strategy Report" heading found).' };
      var window = lines.slice(startIdx, startIdx + 120);
      function findAfter(label) {
        var idx = window.indexOf(label);
        if (idx < 0) return null;
        return window.slice(idx + 1, idx + 5);
      }
      var stripMarks = function(s) { return (s||'').replace(/[\\u202a-\\u202e\\u2066-\\u2069\\u200e\\u200f]/g,''); };
      var out = {};
      ['Total P&L','Max equity drawdown','Max contracts held'].forEach(function(lbl){
        var after = findAfter(lbl);
        if (!after) return;
        out[lbl] = { value: stripMarks(after[0]), unit: stripMarks(after[1]), pct: /%/.test(stripMarks(after[2])) ? stripMarks(after[2]) : null };
      });
      ['Total trades','Profitable trades','Profit factor'].forEach(function(lbl){
        var after = findAfter(lbl);
        if (!after) return;
        var v1 = (after[0]||'').trim();
        var v2 = (after[1]||'').trim();
        out[lbl] = /%/.test(v1) ? { value: v1, ratio: v2 } : { value: v1 };
      });
      if (window[1]) out['Strategy'] = window[1];
      if (window[2]) out['Date range'] = window[2];
      return { metrics: out };
    } catch (e) { return { metrics: {}, error: e.message }; }
  })()
`;

const DOM_SCRAPE_TRADES = `
  (function() {
    try {
      var rows = Array.from(document.querySelectorAll('[class*="listOfTrades"] [role="row"], [class*="strategyReport"] [role="row"], [class*="backtesting"] [role="row"]'));
      if (rows.length === 0) {
        var list = document.querySelectorAll('div[role="row"]');
        if (list.length > 0) rows = Array.from(list);
      }
      if (rows.length === 0) return { trades: [], error: 'List of trades table not rendered — open Strategy Tester and select the "List of trades" tab.' };
      var header = Array.from(rows[0].querySelectorAll('[role="columnheader"], [role="cell"]')).map(function(c){return (c.textContent||'').trim();});
      var out = [];
      for (var r = 1; r < rows.length; r++) {
        var cells = Array.from(rows[r].querySelectorAll('[role="cell"]')).map(function(c){return (c.textContent||'').trim();});
        if (cells.length === 0) continue;
        var row = {};
        for (var c = 0; c < cells.length; c++) row[header[c] || ('col_' + c)] = cells[c];
        out.push(row);
      }
      return { trades: out, note: 'DOM-scrape returns only the visible (virtualized) rows. Use TV UI "Download .csv" for full history.' };
    } catch (e) { return { trades: [], error: e.message }; }
  })()
`;

export async function getStrategyResults() {
  // Phase 1: find strategy source and inspect its properties
  const inspection = await evaluate(`
    (function() {
      try {
        ${FIND_STRATEGY_SRC}
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = __findStrategy(sources);
        if (!strat) return { found: false, error: 'No strategy found on chart.' };

        var has = {};
        var check = ['reportData','_reportData','performance','strategyReport','_strategyReport','_report','reportManager'];
        for (var c = 0; c < check.length; c++) {
          if (strat[check[c]] !== undefined) has[check[c]] = typeof strat[check[c]];
        }
        var state = { completed: false, failed: false, loading: false };
        try { state.completed = strat.isCompleted(); } catch(e) {}
        try { state.failed = strat.isFailed(); } catch(e) {}
        try { state.loading = strat.isLoading(); } catch(e) {}
        return { found: true, has: has, state: state, source_count: sources.length };
      } catch(e) { return { found: false, error: e.message }; }
    })()
  `);

  if (!inspection || !inspection.found) {
    // Empty state, not an error — chart simply has no strategy loaded.
    return { success: true, metric_count: 0, source: 'internal_api', metrics: {}, note: inspection?.error || 'No strategy found on chart.' };
  }

  const state = inspection.state || {};
  if (state.failed) {
    return { success: false, metric_count: 0, source: 'internal_api', metrics: {}, error: 'Strategy is in failed state (compilation error or runtime error). Recompile the strategy.', state };
  }
  if (state.loading) {
    // Retry signal, not an error — caller should wait and call again.
    return { success: true, metric_count: 0, source: 'internal_api', metrics: {}, note: 'Strategy is still loading/computing. Wait and retry.', state };
  }

  // Phase 2: extract metrics via reportData()
  let metrics = {};
  const tried = [];

  try {
    tried.push('reportData');
    const data = await evaluate(`
      (function() {
        ${FIND_STRATEGY_SRC}
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = __findStrategy(sources);
        if (!strat) return null;
        // TV 3.1.0+: _reportData.performance
        if (strat._reportData && strat._reportData.performance) {
          var perf1 = strat._reportData.performance;
          var out1 = {};
          for (var k1 in perf1) {
            var v1 = perf1[k1];
            if (v1 === null || v1 === undefined) continue;
            if (typeof v1 === 'object') {
              for (var k2 in v1) {
                var v2 = v1[k2];
                if (v2 !== null && v2 !== undefined && typeof v2 !== 'object' && typeof v2 !== 'function')
                  out1[k1 + '.' + k2] = v2;
              }
            } else if (typeof v1 !== 'function') out1[k1] = v1;
          }
          try { var mi = strat.metaInfo(); out1.strategyName = mi.description || mi.shortDescription || ''; } catch(e) {}
          if (Object.keys(out1).length > 0) return out1;
        }
        // Legacy: reportData()
        if (typeof strat.reportData !== 'function') return null;
        var rd = strat.reportData();
        if (!rd || !rd.performance) return null;
        var perf = rd.performance;
        var out = {};
        var topKeys = ['maxStrategyDrawDown','maxStrategyDrawDownPercent','maxStrategyRunUp','maxStrategyRunUpPercent',
                       'sharpeRatio','sortinoRatio','openPL','openPLPercent','buyHoldReturn','buyHoldReturnPercent'];
        for (var t = 0; t < topKeys.length; t++) {
          if (perf[topKeys[t]] !== undefined) out[topKeys[t]] = perf[topKeys[t]];
        }
        if (perf.all && typeof perf.all === 'object') {
          var ak = Object.keys(perf.all);
          for (var a = 0; a < ak.length; a++) {
            var v = perf.all[ak[a]];
            if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'object') out[ak[a]] = v;
          }
        }
        if (rd.settings && rd.settings.dateRange) out._dateRange = JSON.stringify(rd.settings.dateRange);
        out._currency = rd.currency || '';
        out._tradeCount = rd.trades ? (Array.isArray(rd.trades) ? rd.trades.length : 0) : 0;
        try {
          var mi = strat.metaInfo();
          out.strategyName = mi.description || mi.shortDescription || '';
        } catch(e) {}
        return out;
      })()
    `);
    if (data && typeof data === 'object' && Object.keys(data).length > 0) metrics = data;
  } catch (e) {
    tried.push('reportData error: ' + (e.message || '').substring(0, 100));
  }

  // Phase 3: debug info if metrics empty
  let debug;
  if (Object.keys(metrics).length === 0) {
    try {
      debug = await evaluate(`
        (function() {
          ${FIND_STRATEGY_SRC}
          var chart = ${CHART_API}._chartWidget;
          var sources = chart.model().model().dataSources();
          var strat = __findStrategy(sources);
          if (!strat) return null;
          var own = Object.getOwnPropertyNames(strat).slice(0, 50);
          var proto = Object.getPrototypeOf(strat);
          var protoNames = proto ? Object.getOwnPropertyNames(proto).filter(function(n) { return /report|perf|strat|result|metric|stat/i.test(n); }) : [];
          return { own_props: own, report_proto_methods: protoNames };
        })()
      `);
    } catch (e) { debug = { error: e.message }; }
    if (debug) debug.tried = tried;
  }

  const metricCount = Object.keys(metrics).length;
  if (metricCount > 0) {
    return { success: true, metric_count: metricCount, source: 'internal_api', metrics };
  }

  // Fallback: DOM-scrape Strategy Report (upstream #96).
  try {
    const dom = await evaluate(DOM_SCRAPE_STRATEGY_REPORT);
    const domCount = Object.keys(dom?.metrics || {}).length;
    if (domCount > 0) {
      return { success: true, metric_count: domCount, source: 'dom_fallback', metrics: dom.metrics, debug };
    }
    return { success: false, metric_count: 0, source: 'dom_fallback', metrics: {}, error: dom?.error || 'Strategy found but metrics extraction failed (both API and DOM-scrape returned empty).', debug };
  } catch (e) {
    return { success: false, metric_count: 0, source: 'internal_api', metrics, error: 'Strategy found but metrics extraction failed; DOM-scrape also failed: ' + e.message, debug };
  }
}

export async function getTrades({ max_trades } = {}) {
  const limit = Math.min(max_trades || 20, MAX_TRADES);
  const trades = await evaluate(`
    (function() {
      try {
        ${FIND_STRATEGY_SRC}
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = __findStrategy(sources);
        if (!strat) return {trades: [], source: 'internal_api', error: 'No strategy found on chart.'};

        // TV 3.1.0+: _reportData.trades
        if (strat._reportData && Array.isArray(strat._reportData.trades)) {
          var rtrades = strat._reportData.trades;
          var flat = [];
          var cap = Math.min(rtrades.length, ${limit});
          for (var t = 0; t < cap; t++) {
            var tr = rtrades[t];
            if (!tr) continue;
            var e = tr.e || {}, x = tr.x || {};
            flat.push({
              entry_order_id: e.c || null,
              entry_price: e.p,
              entry_time_ms: e.tm,
              entry_type: e.tp,
              exit_order_id: x.c || null,
              exit_price: x.p,
              exit_time_ms: x.tm,
              exit_type: x.tp,
              quantity: tr.q,
              pnl: tr.tp ? tr.tp.v : null,
              pnl_pct: tr.tp ? tr.tp.p : null,
              cum_pnl: tr.cp ? tr.cp.v : null,
              cum_pnl_pct: tr.cp ? tr.cp.p : null,
              runup: tr.rn ? tr.rn.v : null,
              runup_pct: tr.rn ? tr.rn.p : null,
              drawdown: tr.dd ? tr.dd.v : null,
              drawdown_pct: tr.dd ? tr.dd.p : null
            });
          }
          return {trades: flat, source: 'internal_api', total_trade_count: rtrades.length};
        }

        // Legacy fallback
        var orders = null;
        if (strat.ordersData) { orders = typeof strat.ordersData === 'function' ? strat.ordersData() : strat.ordersData; if (orders && typeof orders.value === 'function') orders = orders.value(); }
        if (!orders || !Array.isArray(orders)) {
          if (strat._orders) orders = strat._orders;
          else if (strat.tradesData) { orders = typeof strat.tradesData === 'function' ? strat.tradesData() : strat.tradesData; if (orders && typeof orders.value === 'function') orders = orders.value(); }
        }
        if (!orders || !Array.isArray(orders)) return {trades: [], source: 'internal_api', error: 'no trade data (_reportData.trades or ordersData).'};
        var result = [];
        for (var t2 = 0; t2 < Math.min(orders.length, ${limit}); t2++) {
          var o = orders[t2];
          if (typeof o === 'object' && o !== null) {
            var trade = {};
            var okeys = Object.keys(o);
            for (var k = 0; k < okeys.length; k++) { var v = o[okeys[k]]; if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'object') trade[okeys[k]] = v; }
            result.push(trade);
          }
        }
        return {trades: result, source: 'internal_api'};
      } catch(e) { return {trades: [], source: 'internal_api', error: e.message}; }
    })()
  `);
  if ((trades?.trades?.length || 0) > 0) {
    return { success: true, trade_count: trades.trades.length, source: trades.source || 'internal_api', trades: trades.trades, error: trades?.error };
  }

  // Fallback: DOM-scrape List of trades (upstream #96). Returns only visible rows.
  try {
    const dom = await evaluate(DOM_SCRAPE_TRADES);
    const limit = Math.min(max_trades || 20, MAX_TRADES);
    const rows = (dom?.trades || []).slice(0, limit);
    if (rows.length > 0) {
      return { success: true, trade_count: rows.length, source: 'dom_fallback', trades: rows, note: dom?.note };
    }
    return { success: false, trade_count: 0, source: 'dom_fallback', trades: [], error: dom?.error || trades?.error || 'No trades available from API or DOM-scrape.' };
  } catch (e) {
    return { success: false, trade_count: 0, source: 'internal_api', trades: [], error: (trades?.error || '') + '; DOM-scrape also failed: ' + e.message };
  }
}

export async function getEquity() {
  const equity = await evaluate(`
    (function() {
      try {
        ${FIND_STRATEGY_SRC}
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = __findStrategy(sources);
        if (!strat) return {data: [], source: 'internal_api', error: 'No strategy found on chart.'};
        var data = [];
        // TV 3.1.0+: _reportData.buyHold
        if (strat._reportData && Array.isArray(strat._reportData.buyHold)) {
          var bh = strat._reportData.buyHold;
          for (var bi = 0; bi < bh.length; bi++) {
            var bv = bh[bi];
            if (typeof bv === 'number') data.push({index: bi, value: bv});
            else if (bv && typeof bv === 'object') data.push(Object.assign({index: bi}, bv));
          }
          if (data.length) return {data: data, source: 'internal_api'};
        }
        if (strat.equityData) {
          var eq = typeof strat.equityData === 'function' ? strat.equityData() : strat.equityData;
          if (eq && typeof eq.value === 'function') eq = eq.value();
          if (Array.isArray(eq)) data = eq;
        }
        if (data.length === 0 && strat.bars) {
          var bars = typeof strat.bars === 'function' ? strat.bars() : strat.bars;
          if (bars && typeof bars.lastIndex === 'function') {
            var end = bars.lastIndex(); var start = bars.firstIndex();
            for (var i = start; i <= end; i++) { var v = bars.valueAt(i); if (v) data.push({time: v[0], equity: v[1], drawdown: v[2] || null}); }
          }
        }
        if (data.length === 0) {
          var perfData = {};
          if (strat.performance) {
            var perf = strat.performance();
            if (perf && typeof perf.value === 'function') perf = perf.value();
            if (perf && typeof perf === 'object') { var pkeys = Object.keys(perf); for (var p = 0; p < pkeys.length; p++) { if (/equity|drawdown|profit|net/i.test(pkeys[p])) perfData[pkeys[p]] = perf[pkeys[p]]; } }
          }
          if (Object.keys(perfData).length > 0) return {data: [], equity_summary: perfData, source: 'internal_api', note: 'Full equity curve not available via API; equity summary metrics returned instead.'};
        }
        return {data: data, source: 'internal_api'};
      } catch(e) { return {data: [], source: 'internal_api', error: e.message}; }
    })()
  `);
  return { success: !equity?.error, data_points: equity?.data?.length || 0, source: equity?.source, data: equity?.data || [], equity_summary: equity?.equity_summary, note: equity?.note, error: equity?.error };
}

export async function getQuote({ symbol } = {}) {
  // Serialize: chained on _quoteLock so parallel callers run one after another.
  // Catch on the lock chain prevents a single failure from poisoning the chain.
  const run = _quoteLock.then(() => _getQuoteInternal({ symbol }));
  _quoteLock = run.then(() => {}, () => {});
  return run;
}

async function _getQuoteInternal({ symbol } = {}) {
  const requested = (symbol || '').toString().trim();
  let originalSymbol = null;
  let needsRestore = false;

  if (requested) {
    try { originalSymbol = await evaluate(`${CHART_API}.symbol()`); } catch (e) {}
    const bare = (s) => (s || '').toString().split(':').pop().toUpperCase();
    if (bare(originalSymbol) !== bare(requested)) {
      needsRestore = true;
      await evaluateAsync(`
        (function() {
          var chart = ${CHART_API};
          return new Promise(function(resolve) {
            chart.setSymbol(${safeString(requested)}, {});
            setTimeout(resolve, 500);
          });
        })()
      `);
      await waitForChartReady(requested);
    }
  }

  try {
    const data = await evaluate(`
      (function() {
        var api = ${CHART_API};
        var sym = '';
        try { sym = api.symbol(); } catch(e) {}
        if (!sym) { try { sym = api.symbolExt().symbol; } catch(e) {} }
        var ext = {};
        try { ext = api.symbolExt() || {}; } catch(e) {}
        var bars = ${BARS_PATH};
        var quote = { symbol: sym };
        if (bars && typeof bars.lastIndex === 'function') {
          var last = bars.valueAt(bars.lastIndex());
          if (last) { quote.time = last[0]; quote.open = last[1]; quote.high = last[2]; quote.low = last[3]; quote.close = last[4]; quote.last = last[4]; quote.volume = last[5] || 0; }
        }
        try {
          var bidEl = document.querySelector('[class*="bid"] [class*="price"], [class*="dom-"] [class*="bid"]');
          var askEl = document.querySelector('[class*="ask"] [class*="price"], [class*="dom-"] [class*="ask"]');
          if (bidEl) quote.bid = parseFloat(bidEl.textContent.replace(/[^0-9.\\-]/g, ''));
          if (askEl) quote.ask = parseFloat(askEl.textContent.replace(/[^0-9.\\-]/g, ''));
        } catch(e) {}
        try {
          var hdr = document.querySelector('[class*="headerRow"] [class*="last-"]');
          if (hdr) { var hdrPrice = parseFloat(hdr.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(hdrPrice)) quote.header_price = hdrPrice; }
        } catch(e) {}
        if (ext.description) quote.description = ext.description;
        if (ext.exchange) quote.exchange = ext.exchange;
        if (ext.type) quote.type = ext.type;
        return quote;
      })()
    `);
    if (!data || (!data.last && !data.close)) throw new Error('Could not retrieve quote. The chart may still be loading.');
    return { success: true, ...data };
  } finally {
    if (needsRestore && originalSymbol) {
      try {
        await evaluateAsync(`
          (function() {
            var chart = ${CHART_API};
            return new Promise(function(resolve) {
              chart.setSymbol(${safeString(originalSymbol)}, {});
              setTimeout(resolve, 500);
            });
          })()
        `);
        await waitForChartReady(originalSymbol);
      } catch (e) {}
    }
  }
}

export async function getDepth() {
  const data = await evaluate(`
    (function() {
      var domPanel = document.querySelector('[class*="depth"]')
        || document.querySelector('[class*="orderBook"]')
        || document.querySelector('[class*="dom-"]')
        || document.querySelector('[class*="DOM"]')
        || document.querySelector('[data-name="dom"]');
      if (!domPanel) return { found: false, error: 'DOM / Depth of Market panel not found.' };
      var bids = [], asks = [];
      var rows = domPanel.querySelectorAll('[class*="row"], tr');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var priceEl = row.querySelector('[class*="price"]');
        var sizeEl = row.querySelector('[class*="size"], [class*="volume"], [class*="qty"]');
        if (!priceEl) continue;
        var price = parseFloat(priceEl.textContent.replace(/[^0-9.\\-]/g, ''));
        var size = sizeEl ? parseFloat(sizeEl.textContent.replace(/[^0-9.\\-]/g, '')) : 0;
        if (isNaN(price)) continue;
        var rowClass = row.className || '';
        var rowHTML = row.innerHTML || '';
        if (/bid|buy/i.test(rowClass) || /bid|buy/i.test(rowHTML)) bids.push({ price, size });
        else if (/ask|sell/i.test(rowClass) || /ask|sell/i.test(rowHTML)) asks.push({ price, size });
        else if (i < rows.length / 2) asks.push({ price, size });
        else bids.push({ price, size });
      }
      if (bids.length === 0 && asks.length === 0) {
        var cells = domPanel.querySelectorAll('[class*="cell"], td');
        var prices = [];
        cells.forEach(function(c) { var val = parseFloat(c.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(val) && val > 0) prices.push(val); });
        if (prices.length > 0) return { found: true, raw_values: prices.slice(0, 50), bids: [], asks: [], note: 'Could not classify bid/ask levels.' };
      }
      bids.sort(function(a, b) { return b.price - a.price; });
      asks.sort(function(a, b) { return a.price - b.price; });
      var spread = null;
      if (asks.length > 0 && bids.length > 0) spread = +(asks[0].price - bids[0].price).toFixed(6);
      return { found: true, bids: bids, asks: asks, spread: spread };
    })()
  `);

  if (!data || !data.found) throw new Error(data?.error || 'DOM panel not found.');
  return { success: true, bid_levels: data.bids?.length || 0, ask_levels: data.asks?.length || 0, spread: data.spread, bids: data.bids || [], asks: data.asks || [], raw_values: data.raw_values, note: data.note };
}

export async function getStudyValues() {
  const data = await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          var values = {};
          try {
            var dwv = s.dataWindowView();
            if (dwv) {
              var items = dwv.items();
              if (items) {
                for (var i = 0; i < items.length; i++) {
                  var item = items[i];
                  if (item._value && item._value !== '∅' && item._title) values[item._title] = item._value;
                }
              }
            }
          } catch(e) {}
          if (Object.keys(values).length > 0) results.push({ name: name, values: values });
        } catch(e) {}
      }
      return results;
    })()
  `);
  return { success: true, study_count: data?.length || 0, studies: data || [] };
}

export async function getPineLines({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglines', 'lines', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const hLevels = [];
    const seen = {};
    const allLines = [];
    for (const item of s.items) {
      const v = item.raw;
      const y1 = v.y1 != null ? Math.round(v.y1 * 100) / 100 : null;
      const y2 = v.y2 != null ? Math.round(v.y2 * 100) / 100 : null;
      if (verbose) allLines.push({ id: item.id, y1, y2, x1: v.x1, x2: v.x2, horizontal: v.y1 === v.y2, style: v.st, width: v.w, color: v.ci });
      if (y1 != null && v.y1 === v.y2 && !seen[y1]) { hLevels.push(y1); seen[y1] = true; }
    }
    hLevels.sort((a, b) => b - a);
    const result = { name: s.name, total_lines: s.count, horizontal_levels: hLevels };
    if (verbose) result.all_lines = allLines;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineLabels({ study_filter, max_labels, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglabels', 'labels', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const limit = max_labels || 50;
  const studies = raw.map(s => {
    let labels = s.items.map(item => {
      const v = item.raw;
      const text = v.t || '';
      const price = v.y != null ? Math.round(v.y * 100) / 100 : null;
      if (verbose) return { id: item.id, text, price, x: v.x, yloc: v.yl, size: v.sz, textColor: v.tci, color: v.ci };
      return { text, price };
    }).filter(l => l.text || l.price != null);
    if (labels.length > limit) labels = labels.slice(-limit);
    return { name: s.name, total_labels: s.count, showing: labels.length, labels };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineTables({ study_filter } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgtablecells', 'tableCells', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const tables = {};
    for (const item of s.items) {
      const v = item.raw;
      const tid = v.tid || 0;
      if (!tables[tid]) tables[tid] = {};
      if (!tables[tid][v.row]) tables[tid][v.row] = {};
      tables[tid][v.row][v.col] = v.t || '';
    }
    const tableList = Object.entries(tables).map(([tid, rows]) => {
      const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
      const formatted = rowNums.map(rn => {
        const cols = rows[rn];
        const colNums = Object.keys(cols).map(Number).sort((a, b) => a - b);
        return colNums.map(cn => cols[cn]).filter(Boolean).join(' | ');
      }).filter(Boolean);
      return { rows: formatted };
    });
    return { name: s.name, tables: tableList };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function evaluateJs({ expression }) {
  if (!expression) {
    return { success: false, error: 'expression is required' };
  }
  try {
    const result = await evaluate(expression);
    return { success: true, result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function getStrategyMetricsFromDom() {
  try {
    await evaluate(`
      (function() {
        var bottom = document.querySelector('.layout__area--bottom');
        if (!bottom) return;
        var buttons = bottom.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
          var t = buttons[i].textContent.trim();
          if (t === 'Performance Summary' || t === 'Overview' || t === 'Metrics') {
            buttons[i].click();
            break;
          }
        }
      })()
    `);
    await new Promise(r => setTimeout(r, 500));

    const raw = await evaluate(`
      (function() {
        var bottom = document.querySelector('.layout__area--bottom');
        if (!bottom) return { error: 'Strategy tester panel not found. Open it via the bottom panel.' };
        var bRect = bottom.getBoundingClientRect();
        var yMin = bRect.top;
        var yMax = bRect.bottom;
        var all = bottom.querySelectorAll('*');
        var m = {};
        var prev = '';
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (el.children.length !== 0) continue;
          var rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          if (rect.y < yMin || rect.y > yMax) continue;
          var t = el.textContent.trim();
          if (!t) continue;
          if (t === 'Net Profit' || t === 'Total P&L') prev = 'np';
          else if (t === 'Max Drawdown' || t === 'Max equity drawdown') prev = 'dd';
          else if (t === 'Total Closed Trades' || t === 'Total trades') prev = 'tr';
          else if (t === 'Percent Profitable' || t === 'Profitable trades') prev = 'wr';
          else if (t === 'Profit Factor' || t === 'Profit factor') prev = 'pf';
          else if (t === 'Sharpe Ratio') prev = 'sharpe';
          else if (t === 'Sortino Ratio') prev = 'sortino';
          else if (t === 'Max Run-up') prev = 'runup';
          else if (t === 'Avg Trade') prev = 'avg_trade';
          else if (prev && /[\d.+\-,]+%/.test(t)) {
            if (prev === 'np') m.net_profit_pct = t;
            else if (prev === 'dd') m.max_dd_pct = t;
            else if (prev === 'wr') m.win_rate = t;
            else if (prev === 'avg_trade' && !m.avg_trade_pct) m.avg_trade_pct = t;
            prev = '';
          }
          else if (prev === 'tr' && /^[\d,]+$/.test(t)) { m.trades = t.replace(/,/g, ''); prev = ''; }
          else if (prev === 'pf' && /^[\d.]+$/.test(t)) { m.profit_factor = t; prev = ''; }
          else if (prev === 'sharpe' && /^[\-\d.]+$/.test(t)) { m.sharpe_ratio = t; prev = ''; }
          else if (prev === 'sortino' && /^[\-\d.]+$/.test(t)) { m.sortino_ratio = t; prev = ''; }
          else if (prev === 'np' && /^[+\-][\d,]/.test(t)) m.net_profit_usdt = t;
          else if (prev === 'dd' && /^[\d,]/.test(t)) m.max_dd_usdt = t;
          else if (prev === 'runup' && /^[+\-]?[\d,]/.test(t)) { m.max_runup = t; prev = ''; }
          else if (prev === 'avg_trade' && /^[+\-]?[\d,.]/.test(t)) { m.avg_trade = t; }
        }
        return m;
      })()
    `);

    if (raw?.error) return { success: false, error: raw.error };
    const metricCount = Object.keys(raw || {}).length;
    if (metricCount === 0) return { success: false, error: 'No strategy metrics found in DOM. Make sure the Strategy Tester panel is open and a strategy is loaded.' };
    return { success: true, source: 'dom', metric_count: metricCount, metrics: raw };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Read plotshape/plotchar markers from Pine Script indicators.
 */
export async function getPineShapes({ study_filter, last_n_bars } = {}) {
  const filter = study_filter || '';
  const maxBars = last_n_bars || 100;
  const raw = await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var mainSeries = model.mainSeries();
      var mainBars = mainSeries.bars();
      var filter = ${safeString(filter)};
      var maxBars = ${maxBars};
      var results = [];

      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          if (filter && name.indexOf(filter) === -1) continue;
          if (!meta.plots) continue;

          var shapePlots = [];
          for (var pi = 0; pi < meta.plots.length; pi++) {
            var plot = meta.plots[pi];
            if (plot.type !== 'shapes') continue;
            var style = meta.styles && meta.styles[plot.id] ? meta.styles[plot.id] : {};
            var defaults = meta.defaults && meta.defaults.styles && meta.defaults.styles[plot.id]
              ? meta.defaults.styles[plot.id] : {};
            shapePlots.push({
              plotIndex: pi,
              dataIndex: pi + 1,
              id: plot.id,
              title: style.title || plot.id,
              shape: defaults.plottype || 'unknown',
              location: defaults.location || 'AboveBar',
              color: defaults.color || null,
              size: style.size || 'auto'
            });
          }
          if (shapePlots.length === 0) continue;

          var data = s._data;
          if (!data) continue;
          var lastIdx = data.lastIndex();
          var firstIdx = Math.max(data.firstIndex(), lastIdx - maxBars + 1);

          var signals = [];
          for (var b = lastIdx; b >= firstIdx; b--) {
            var row = data.valueAt(b);
            if (!row) continue;
            for (var sp = 0; sp < shapePlots.length; sp++) {
              var di = shapePlots[sp].dataIndex;
              var val = row[di];
              if (val && val !== 0 && !isNaN(val)) {
                var mainRow = mainBars.valueAt(b);
                var ohlc = null;
                if (mainRow) {
                  ohlc = {
                    time: new Date(mainRow[0] * 1000).toISOString(),
                    timestamp: mainRow[0],
                    open: mainRow[1],
                    high: mainRow[2],
                    low: mainRow[3],
                    close: mainRow[4]
                  };
                }
                signals.push({
                  plot: shapePlots[sp].title,
                  shape: shapePlots[sp].shape,
                  location: shapePlots[sp].location,
                  color: shapePlots[sp].color,
                  barIndex: b,
                  value: val,
                  ohlc: ohlc
                });
              }
            }
          }

          if (shapePlots.length > 0) {
            results.push({
              name: name,
              shapePlots: shapePlots,
              signals: signals,
              signalCount: signals.length,
              barsScanned: lastIdx - firstIdx + 1
            });
          }
        } catch(e) {}
      }
      return results;
    })()
  `);

  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => ({
    name: s.name,
    shape_plots: s.shapePlots,
    signal_count: s.signalCount,
    bars_scanned: s.barsScanned,
    signals: s.signals,
  }));

  return { success: true, study_count: studies.length, studies };
}

export async function getPineBoxes({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgboxes', 'boxes', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const zones = [];
    const seen = {};
    const allBoxes = [];
    for (const item of s.items) {
      const v = item.raw;
      const high = v.y1 != null && v.y2 != null ? Math.round(Math.max(v.y1, v.y2) * 100) / 100 : null;
      const low = v.y1 != null && v.y2 != null ? Math.round(Math.min(v.y1, v.y2) * 100) / 100 : null;
      if (verbose) allBoxes.push({ id: item.id, high, low, x1: v.x1, x2: v.x2, borderColor: v.c, bgColor: v.bc });
      if (high != null && low != null) { const key = high + ':' + low; if (!seen[key]) { zones.push({ high, low }); seen[key] = true; } }
    }
    zones.sort((a, b) => b.high - a.high);
    const result = { name: s.name, total_boxes: s.count, zones };
    if (verbose) result.all_boxes = allBoxes;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}
