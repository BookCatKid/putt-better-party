import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

// Private, bounded, newline-delimited JSON. Never pass raw requests, tokens,
// full snapshots, course specifications, headers, or position packets here.
const filename = process.env.BP_EVENT_LOG;
const maxBytes = 8 * 1024 * 1024;
const archives = 6;
let bytes: number | undefined;
let lastWarning = 0;
let second = 0;
let count = 0;
let dropped = 0;

function rotate(file: string) {
  const oldest = file + '.' + archives;
  if (existsSync(oldest)) {
    unlinkSync(oldest);
  }
  for (let index = archives - 1; index >= 1; index--) {
    const previous = file + '.' + index;
    if (existsSync(previous)) {
      renameSync(previous, file + '.' + (index + 1));
    }
  }
  if (existsSync(file)) {
    renameSync(file, file + '.1');
  }
  bytes = 0;
}

export function logEvent(event: string, fields: Record<string, unknown> = {}) {
  if (!filename) {
    return;
  }
  const now = Date.now();
  const window = Math.floor(now / 1000);
  if (window !== second) {
    second = window;
    count = 0;
  }
  // Bound writes even if a malicious client floods accepted or invalid events.
  if (++count > 250) {
    dropped++;
    return;
  }
  try {
    if (bytes === undefined) {
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
      bytes = existsSync(filename) ? statSync(filename).size : 0;
    }
    let line =
      JSON.stringify({
        timestamp: new Date(now).toISOString(),
        event,
        ...fields,
        ...(dropped ? { precedingDroppedEvents: dropped } : {}),
      }) + '\n';
    if (Buffer.byteLength(line) > 512 * 1024) {
      line =
        JSON.stringify({
          timestamp: new Date(now).toISOString(),
          event,
          room: fields.room,
          matchId: fields.matchId,
          oversizedRecord: true,
        }) + '\n';
    }
    const length = Buffer.byteLength(line);
    if (bytes + length > maxBytes) {
      rotate(filename);
    }
    appendFileSync(filename, line, { encoding: 'utf8', mode: 0o600 });
    bytes += length;
    dropped = 0;
  } catch {
    bytes = undefined;
    if (now - lastWarning >= 60_000) {
      lastWarning = now;
      console.error('Gameplay event log write failed');
    }
  }
}
