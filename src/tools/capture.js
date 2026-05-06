import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/capture.js';

export function registerCaptureTools(server) {
  server.tool('capture_screenshot', 'Take a screenshot of the TradingView chart', {
    region: z.string().optional().describe('Region to capture: full, chart, strategy_tester (default full)'),
    filename: z.string().optional().describe('Custom filename (without extension)'),
    method: z.string().optional().describe('Capture method: cdp (Page.captureScreenshot) or api (chartWidgetCollection.takeScreenshot) (default cdp)'),
    output_dir: z.string().optional().describe('Absolute path to save directory (default: screenshots/ in project root)'),
    path: z.string().optional().describe('Optional full path (absolute or relative) for the output file. Wins over output_dir+filename if provided. Auto-appends .png if no extension.'),
  }, async ({ region, filename, method, output_dir, path }) => {
    try { return jsonResult(await core.captureScreenshot({ region, filename, method, output_dir, path })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
