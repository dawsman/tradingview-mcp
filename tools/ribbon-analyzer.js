#!/usr/bin/env node
/**
 * PhantomFlow TF Ribbon Analyzer
 *
 * Loads ribbon state + price data and runs pattern queries.
 * Palette indices: 0=GRN, 1=YEL, 2=MAG, 3=RED, 4=--- (gray/neutral)
 * TFs: 5m, 15m, 30m, 1h, 4h, 1D, 1W (indices 0-6)
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_NAMES = ['GRN', 'YEL', 'MAG', 'RED', '---'];
const TF_NAMES = ['5m', '15m', '30m', '1h', '4h', '1D', '1W'];

function loadData(csvPath) {
  const raw = readFileSync(csvPath, 'utf8').trim().split('\n');
  const rows = [];
  for (let i = 1; i < raw.length; i++) {
    const cols = raw[i].split(',');
    const row = {
      ts: parseInt(cols[0]),
      date: cols[1],
      open: parseFloat(cols[2]),
      high: parseFloat(cols[3]),
      low: parseFloat(cols[4]),
      close: parseFloat(cols[5]),
      states: [
        parseInt(cols[6]), parseInt(cols[7]), parseInt(cols[8]),
        parseInt(cols[9]), parseInt(cols[10]), parseInt(cols[11]), parseInt(cols[12])
      ],
    };
    rows.push(row);
  }
  // Compute derived fields
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    r.chg_pct = i > 0 ? round((r.close - rows[i - 1].close) / rows[i - 1].close * 100) : 0;
    r.prev_states = i > 0 ? rows[i - 1].states.slice() : [0, 0, 0, 0, 0, 0, 0];
    r.transitions = r.states.map((s, j) => s !== r.prev_states[j] ? { from: r.prev_states[j], to: s } : null);
    r.transition_count = r.transitions.filter(Boolean).length;
    // Forward returns
    r.fwd_1d = i + 1 < rows.length ? round((rows[i + 1].close - r.close) / r.close * 100) : null;
    r.fwd_3d = i + 3 < rows.length ? round((rows[i + 3].close - r.close) / r.close * 100) : null;
    r.fwd_5d = i + 5 < rows.length ? round((rows[i + 5].close - r.close) / r.close * 100) : null;
    r.fwd_10d = i + 10 < rows.length ? round((rows[i + 10].close - r.close) / r.close * 100) : null;
    // Convenience
    r.bullish_count = r.states.filter(s => s === 0 || s === 1).length;
    r.bearish_count = r.states.filter(s => s === 2 || s === 3).length;
    r.neutral_count = r.states.filter(s => s === 4).length;
    r.htf_states = r.states.slice(4); // 4h, 1D, 1W
    r.ltf_states = r.states.slice(0, 3); // 5m, 15m, 30m
  }
  return rows;
}

function round(n) { return Math.round(n * 100) / 100; }

function stateStr(states) {
  return states.map(s => STATE_NAMES[s].padStart(3)).join(' | ');
}

function stats(values) {
  if (!values.length) return { count: 0, mean: 0, median: 0, min: 0, max: 0, win_rate: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = round(values.reduce((a, b) => a + b, 0) / values.length);
  const median = round(sorted[Math.floor(sorted.length / 2)]);
  const wins = values.filter(v => v > 0).length;
  const avg_win = values.filter(v => v > 0).length ? round(values.filter(v => v > 0).reduce((a, b) => a + b, 0) / values.filter(v => v > 0).length) : 0;
  const avg_loss = values.filter(v => v <= 0).length ? round(values.filter(v => v <= 0).reduce((a, b) => a + b, 0) / values.filter(v => v <= 0).length) : 0;
  return {
    count: values.length,
    mean,
    median,
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    stdev: round(Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length)),
    win_rate: round(wins / values.length * 100),
    avg_win,
    avg_loss,
    expectancy: round(avg_win * (wins / values.length) + avg_loss * (1 - wins / values.length)),
  };
}

// ========== QUERY FUNCTIONS ==========

function query(data, filterFn, label) {
  const matches = data.filter(filterFn);
  if (!matches.length) {
    console.log(`\n[${label}] — 0 matches\n`);
    return matches;
  }

  const fwd1 = stats(matches.map(r => r.fwd_1d).filter(v => v !== null));
  const fwd3 = stats(matches.map(r => r.fwd_3d).filter(v => v !== null));
  const fwd5 = stats(matches.map(r => r.fwd_5d).filter(v => v !== null));
  const fwd10 = stats(matches.map(r => r.fwd_10d).filter(v => v !== null));

  console.log(`\n${'='.repeat(70)}`);
  console.log(`[${label}] — ${matches.length} matches`);
  console.log(`${'='.repeat(70)}`);
  console.log(`Forward returns:     +1d        +3d        +5d        +10d`);
  console.log(`  Mean:         ${pad(fwd1.mean)}   ${pad(fwd3.mean)}   ${pad(fwd5.mean)}   ${pad(fwd10.mean)}`);
  console.log(`  Median:       ${pad(fwd1.median)}   ${pad(fwd3.median)}   ${pad(fwd5.median)}   ${pad(fwd10.median)}`);
  console.log(`  Win rate:     ${pad(fwd1.win_rate)}%  ${pad(fwd3.win_rate)}%  ${pad(fwd5.win_rate)}%  ${pad(fwd10.win_rate)}%`);
  console.log(`  Expectancy:   ${pad(fwd1.expectancy)}   ${pad(fwd3.expectancy)}   ${pad(fwd5.expectancy)}   ${pad(fwd10.expectancy)}`);
  console.log(`  Min/Max:      ${fwd1.min}/${fwd1.max}  ${fwd3.min}/${fwd3.max}  ${fwd5.min}/${fwd5.max}  ${fwd10.min}/${fwd10.max}`);

  return matches;
}

function pad(n) { return String(n).padStart(7); }

function showSamples(matches, n = 5) {
  const sample = matches.slice(-n);
  console.log(`\nRecent ${Math.min(n, sample.length)} occurrences:`);
  console.log(`${'Date'.padEnd(12)} ${'Chg%'.padStart(7)} | ${TF_NAMES.map(t => t.padStart(3)).join(' | ')} | +1d    +3d    +5d`);
  console.log('-'.repeat(85));
  for (const r of sample) {
    const fwds = [r.fwd_1d, r.fwd_3d, r.fwd_5d].map(v => v !== null ? String(v).padStart(6) : '   n/a').join(' ');
    console.log(`${r.date}  ${String(r.chg_pct).padStart(6)}% | ${stateStr(r.states)} | ${fwds}`);
  }
}

// ========== BUILT-IN PATTERNS ==========

function runAllPatterns(data) {
  console.log(`\nDataset: ${data.length} bars, ${data[0].date} to ${data[data.length - 1].date}\n`);
  console.log(`Baseline (all bars):`);
  const baseline = stats(data.map(r => r.fwd_1d).filter(v => v !== null));
  console.log(`  +1d mean: ${baseline.mean}%, win rate: ${baseline.win_rate}%, n=${baseline.count}\n`);

  // P1: HTF MAG Wall — 4h + 1D + 1W all MAG (state 2)
  const p1 = query(data,
    r => r.htf_states.every(s => s === 2),
    'P1: HTF MAG Wall (4h+1D+1W all MAG)');
  showSamples(p1);

  // P2: HTF Shield / LTF Dip — HTFs (4h+1D+1W) bullish, LTFs (5m or 15m) bearish
  query(data,
    r => r.htf_states.filter(s => s === 0 || s === 1).length >= 2 &&
         r.ltf_states.filter(s => s === 2 || s === 3).length >= 2,
    'P2: HTF Shield + LTF Dip (2+ HTFs bull, 2+ LTFs bear)');

  // P3: Full Confluence — all 7 TFs same state
  for (const st of [0, 1, 2, 3, 4]) {
    query(data,
      r => r.states.every(s => s === st),
      `P3: Full ${STATE_NAMES[st]} (all 7 TFs = ${STATE_NAMES[st]})`);
  }

  // P4: LTF Clearing (---) while HTFs bearish — the bounce setup
  query(data,
    r => r.ltf_states.filter(s => s === 4).length >= 2 &&
         r.htf_states.filter(s => s === 2 || s === 3).length >= 2,
    'P4: LTF Clearing + HTF Bear (2+ LTFs ---, 2+ HTFs MAG/RED)');

  // P5: Extension Alignment — 3+ TFs in YEL
  query(data,
    r => r.states.filter(s => s === 1).length >= 3,
    'P5: Extension Alignment (3+ TFs YEL)');

  // P6: Bull Trap Setup — LTFs GRN while HTFs MAG
  query(data,
    r => r.ltf_states.filter(s => s === 0).length >= 2 &&
         r.htf_states.filter(s => s === 2).length >= 2,
    'P6: Bull Trap? (2+ LTFs GRN, 2+ HTFs MAG)');

  // P7: Bearish Cascade — LTFs flip bearish, HTFs follow
  query(data,
    r => r.bearish_count >= 5 && r.transition_count >= 2,
    'P7: Heavy Bear + Transitions (5+ TFs bear, 2+ just changed)');

  // P8: Strong Alignment Bull — 5+ TFs GRN
  query(data,
    r => r.states.filter(s => s === 0).length >= 5,
    'P8: Strong Bull Alignment (5+ TFs GRN)');

  // P9: Divergence — LTFs bull, HTFs bear
  query(data,
    r => r.ltf_states.filter(s => s === 0 || s === 1).length >= 2 &&
         r.htf_states.filter(s => s === 2 || s === 3).length >= 2,
    'P9: LTF Bull / HTF Bear Divergence');

  // P10: Big move days (>3%) — what did the matrix look like?
  const bigDrops = query(data, r => r.chg_pct <= -3, 'Big Drops (>= -3%)');
  showSamples(bigDrops, 10);

  const bigPumps = query(data, r => r.chg_pct >= 3, 'Big Pumps (>= +3%)');
  showSamples(bigPumps, 10);
}

// ========== CUSTOM QUERY CLI ==========

function customQuery(data, args) {
  const mode = args[0];

  if (mode === 'state') {
    // Usage: state 4h=MAG 1D=MAG 1W=MAG
    const filters = args.slice(1).map(a => {
      const [tf, st] = a.split('=');
      const tfIdx = TF_NAMES.indexOf(tf);
      const stIdx = STATE_NAMES.indexOf(st);
      if (tfIdx === -1 || stIdx === -1) throw new Error(`Invalid: ${a}. Use TF=STATE (e.g., 4h=MAG)`);
      return { tfIdx, stIdx };
    });
    const label = args.slice(1).join(' + ');
    const m = query(data, r => filters.every(f => r.states[f.tfIdx] === f.stIdx), label);
    showSamples(m, 10);
  }

  else if (mode === 'bear-count' || mode === 'bull-count') {
    const isBear = mode === 'bear-count';
    const minCount = parseInt(args[1] || '4');
    const label = `${isBear ? 'Bearish' : 'Bullish'} count >= ${minCount}`;
    const m = query(data,
      r => (isBear ? r.bearish_count : r.bullish_count) >= minCount,
      label);
    showSamples(m, 10);
  }

  else if (mode === 'date') {
    const date = args[1];
    const row = data.find(r => r.date === date);
    if (!row) { console.log('Date not found'); return; }
    console.log(`\n${row.date} | Close: ${row.close} | Chg: ${row.chg_pct}%`);
    console.log(`States: ${stateStr(row.states)}`);
    console.log(`TFs:    ${TF_NAMES.map(t => t.padStart(3)).join(' | ')}`);
    console.log(`Prev:   ${stateStr(row.prev_states)}`);
    console.log(`Transitions: ${row.transitions.map((t, i) => t ? `${TF_NAMES[i]}:${STATE_NAMES[t.from]}>${STATE_NAMES[t.to]}` : '').filter(Boolean).join(', ') || 'none'}`);
    console.log(`Forward: +1d=${row.fwd_1d}% +3d=${row.fwd_3d}% +5d=${row.fwd_5d}% +10d=${row.fwd_10d}%`);
    console.log(`Bull/Bear/Neutral: ${row.bullish_count}/${row.bearish_count}/${row.neutral_count}`);
  }

  else if (mode === 'transition') {
    // Find all days where a specific TF changed to a specific state
    const tf = args[1];
    const toState = args[2];
    const tfIdx = TF_NAMES.indexOf(tf);
    const stIdx = STATE_NAMES.indexOf(toState);
    if (tfIdx === -1 || stIdx === -1) throw new Error(`Usage: transition 1D MAG`);
    const label = `${tf} transitions to ${toState}`;
    const m = query(data, r => r.transitions[tfIdx] && r.transitions[tfIdx].to === stIdx, label);
    showSamples(m, 10);
  }

  else if (mode === 'scan') {
    // Scan for current state across the dataset — how often has this exact pattern appeared?
    const current = data[data.length - 1];
    console.log(`\nCurrent state (${current.date}): ${stateStr(current.states)}`);
    const exact = query(data, r => r.states.every((s, i) => s === current.states[i]), 'Exact match of current state');
    showSamples(exact, 10);
    // Relaxed: same bull/bear counts
    query(data, r => r.bearish_count === current.bearish_count && r.bullish_count === current.bullish_count,
      `Same bull/bear profile (${current.bullish_count}B/${current.bearish_count}b)`);
  }

  else {
    console.log(`
Usage:
  node ribbon-analyzer.js                    Run all built-in patterns
  node ribbon-analyzer.js state 4h=MAG 1D=GRN   Custom state filter
  node ribbon-analyzer.js bear-count 5       Days with 5+ bearish TFs
  node ribbon-analyzer.js bull-count 4       Days with 4+ bullish TFs
  node ribbon-analyzer.js date 2026-02-05    Inspect a specific date
  node ribbon-analyzer.js transition 1D MAG  Find all 1D→MAG transitions
  node ribbon-analyzer.js scan               Match current state historically
    `);
  }
}

// ========== MAIN ==========

const csvPath = resolve(__dirname, '../logs/ribbon_full_dataset.csv');
const data = loadData(csvPath);
const args = process.argv.slice(2);

if (args.length === 0) {
  runAllPatterns(data);
} else {
  customQuery(data, args);
}
