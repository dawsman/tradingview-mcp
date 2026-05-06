/**
 * Core screenshot/capture logic.
 */
import { getClient, evaluate, getChartCollection } from '../connection.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, isAbsolute, resolve as pathResolve, parse as pathParse, dirname } from 'path';
import { resolveScreenshotDir } from './paths.js';

// Resolution order: `path` (full path, wins outright) > `output_dir` + filename > legacy SCREENSHOT_DIR (upstream #117 + our #43)
export async function captureScreenshot({ region, filename, method, output_dir, path: outPath } = {}) {
  let filePath;
  if (outPath) {
    filePath = isAbsolute(outPath) ? outPath : pathResolve(process.cwd(), outPath);
    if (!pathParse(filePath).ext) filePath += '.png';
    mkdirSync(dirname(filePath), { recursive: true });
  } else {
    const targetDir = resolveScreenshotDir(output_dir);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const fname = (filename || `tv_${region}_${ts}`).replace(/[\/\\]/g, '_');
    filePath = join(targetDir, `${fname}.png`);
  }

  // Note: method === 'api' returns the screenshot inline without writing to disk.
  // The `path` and `output_dir` parameters are ignored on this code path; only
  // the default CDP capture (below) writes a file.
  if (method === 'api') {
    try {
      const colPath = await getChartCollection();
      await evaluate(`${colPath}.takeScreenshot()`);
      return {
        success: true, method: 'api',
        note: 'takeScreenshot() triggered — TradingView will save/show the screenshot via its own UI',
      };
    } catch {
      // Fall through to CDP method
    }
  }

  const client = await getClient();
  let clip = undefined;

  if (region === 'chart') {
    const bounds = await evaluate(`
      (function() {
        var el = document.querySelector('[data-name="pane-canvas"]')
          || document.querySelector('[class*="chart-container"]')
          || document.querySelector('canvas');
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
    `);
    if (bounds) clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 };
  } else if (region === 'strategy_tester') {
    const bounds = await evaluate(`
      (function() {
        var el = document.querySelector('[data-name="backtesting"]')
          || document.querySelector('[class*="strategyReport"]');
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
    `);
    if (bounds) clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 };
  }

  const params = { format: 'png' };
  if (clip) params.clip = clip;

  const { data } = await client.Page.captureScreenshot(params);
  writeFileSync(filePath, Buffer.from(data, 'base64'));

  return {
    success: true, method: 'cdp', file_path: filePath, region,
    size_bytes: Buffer.from(data, 'base64').length,
  };
}
