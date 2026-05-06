import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, '..', 'logs');

mkdirSync(LOG_DIR, { recursive: true });

function ts() { return new Date().toISOString(); }

function currentLogFile() {
  const day = new Date().toISOString().slice(0, 10);
  return join(LOG_DIR, `mcp-${day}.jsonl`);
}

function write(entry) {
  appendFileSync(currentLogFile(), JSON.stringify(entry) + '\n');
}

export function logToolCall(tool, args) {
  write({ ts: ts(), type: 'call', tool, args });
}

export function logToolResult(tool, result, durationMs) {
  let data, truncated = false;
  let innerError;
  let innerFailure = false;
  try {
    const text = result?.content?.[0]?.text;
    if (text) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          // Hard failure: success:false
          // Soft failure: success:true but non-empty error field (legacy anti-pattern
          // in some tools that signal problems without flipping success — see
          // data_get_strategy_results, alert_list, layout_list, etc.)
          if (parsed.success === false || (parsed.error != null && parsed.error !== '')) {
            innerFailure = true;
            innerError = parsed.error;
          }
        }
      } catch {}
      if (text.length > 4000) {
        data = text.slice(0, 4000) + `...[truncated ${text.length} total chars]`;
        truncated = true;
      } else {
        data = text;
      }
    }
  } catch {}

  const isError = !!result?.isError || innerFailure;

  const entry = {
    ts: ts(),
    type: isError ? 'error' : 'result',
    tool,
    ok: !isError,
    durationMs,
    ...(isError && innerError ? { error: innerError } : {}),
    ...(truncated ? { truncated } : {}),
    ...(data ? { data } : {}),
  };
  write(entry);
}

export function logError(tool, error, durationMs) {
  write({
    ts: ts(),
    type: 'error',
    tool,
    ok: false,
    error: error?.message || String(error),
    stack: error?.stack?.split('\n').slice(0, 3).join(' | '),
    durationMs,
  });
}
