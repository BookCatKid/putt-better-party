import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * The capture downloader's retry classification.
 *
 * The rules the probe pins: transient network faults and 5xx/429 responses are
 * retried within a bound; a definitive refusal (4xx) is not; a successful
 * response whose body is wrong (empty, or HTML where an asset was asked for)
 * fails on the first attempt because retrying a wrong answer does not make it
 * right. The scenarios run inside the real script with only `subprocess.run`
 * and `time.sleep` faked, so what is exercised is the shipped code path.
 */

const root = path.resolve(import.meta.dir, '..');

/**
 * Run one scenario inside capture-client.py with `subprocess.run` scripted.
 * `responses` is a list of [returncode, stdout, stderr] triples the fake
 * returns in order; the scenario prints the observed call count.
 */
function scenario(responses, fetchPath = '/assets/x-12345678.js') {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location(
    'capture', ${JSON.stringify(path.join(root, 'scripts/capture-client.py'))}
)
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)
responses = iter(${JSON.stringify(responses)})
calls = {'n': 0}
def fake_run(args, capture_output):
    calls['n'] += 1
    code, out, err = next(responses)
    class Result: pass
    result = Result()
    result.returncode = code
    result.stdout = out.encode()
    result.stderr = err.encode()
    return result
capture.subprocess.run = fake_run
capture.time.sleep = lambda _seconds: None
try:
    body = capture.fetch(${JSON.stringify(fetchPath)})
    print(json.dumps({'ok': body.decode(), 'calls': calls['n']}))
except Exception as error:
    print(json.dumps({'error': type(error).__name__, 'text': str(error), 'calls': calls['n']}))
`;
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error('scenario failed: ' + result.stderr);
  }
  return JSON.parse(result.stdout.trim());
}

const curlFail = (code) => [code, '', 'curl: (' + code + ') failed'];
const httpFail = (status) => [22, '', 'curl: (22) The requested URL returned error: ' + status];
const ok = (body) => [0, body + '\n200', ''];

test('a transient network fault is retried until the fetch succeeds', () => {
  const outcome = scenario([curlFail(7), ok('asset-bytes')]);
  expect(outcome).toEqual({ ok: 'asset-bytes', calls: 2 });
});

test('a 5xx is retried and then given up at the attempt bound', () => {
  const outcome = scenario([httpFail(503), httpFail(503), httpFail(503)]);
  expect(outcome.error).toBe('TransientError');
  expect(outcome.calls).toBe(3);
});

test('a definitive refusal is not retried', () => {
  for (const status of [400, 403, 404]) {
    const outcome = scenario([httpFail(status)]);
    expect(outcome.error).toBe('RuntimeError');
    expect(outcome.calls).toBe(1);
  }
});

test('a nonempty wrong answer is never retried or accepted as the asset', () => {
  // An HTML shell where a JS bundle was asked for is a partial-page answer,
  // not the file: it fails on the first attempt.
  const outcome = scenario([ok('<!doctype html><html><body>oops</body></html>')]);
  expect(outcome.error).toBe('RuntimeError');
  expect(outcome.calls).toBe(1);
  const empty = scenario([ok('')]);
  expect(empty.error).toBe('RuntimeError');
  expect(empty.calls).toBe(1);
});

test('paths outside the static allowlist never reach the network', () => {
  // `safe()` runs before any attempt: the fetch raises without a curl call.
  const outcome = scenario([], '/api/leaderboard');
  expect(outcome.error).toBe('ValueError');
  expect(outcome.calls).toBe(0);
});
