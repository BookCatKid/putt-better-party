/**
 * The leaderboard page: hole-count tabs, search, and paged results.
 *
 * A standalone script, so it is ordinary strict TypeScript rather than a snippet
 * inside the pinned client's scope. Two details are worth noting: the request
 * generation counter keeps a slow, superseded search from overwriting newer
 * results, and typing is debounced rather than aborted.
 */

/** One scored row as the server returns it. */
interface LeaderboardRow {
  rank: number;
  name: string;
  strokes: number;
  timeMs: number;
  achievedAt: number;
}

/** A page of results. `nextOffset` is null on the last page. */
interface LeaderboardPage {
  rows: LeaderboardRow[];
  nextOffset: number | null;
}

interface ApiError {
  error?: string;
}

const HOLE_CHOICES = 9;
const DEBOUNCE_MS = 200;

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`The leaderboard page is missing its #${id} element.`);
  }
  return element as T;
}

const counts = required<HTMLDivElement>('counts');
const search = required<HTMLInputElement>('search');
const scores = required<HTMLTableSectionElement>('scores');
const status = required<HTMLParagraphElement>('status');
const more = required<HTMLButtonElement>('more');

let holes = 3;
let nextOffset: number | null = null;
let generation = 0;
let debounce: ReturnType<typeof setTimeout> | undefined;

/** `m:ss.mmm`, which is how a run time reads at a glance. */
function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  const millis = String(ms % 1000).padStart(3, '0');
  return `${minutes}:${seconds}.${millis}`;
}

function row(values: Array<string | number>): HTMLTableRowElement {
  const element = document.createElement('tr');
  for (const value of values) {
    const cell = document.createElement('td');
    cell.textContent = String(value);
    element.append(cell);
  }
  return element;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Could not load the leaderboard.';
}

async function load(append = false): Promise<void> {
  // Only the newest request may write to the page. A search typed while an
  // earlier one is in flight can otherwise land out of order.
  const request = ++generation;
  more.hidden = true;
  status.textContent = 'Loading…';
  if (!append) {
    scores.replaceChildren();
  }
  try {
    const params = new URLSearchParams({
      holes: String(holes),
      search: search.value,
      offset: String(append ? (nextOffset ?? 0) : 0),
    });
    const response = await fetch('/api/leaderboard?' + params.toString());
    const result = (await response.json()) as LeaderboardPage & ApiError;
    if (!response.ok) {
      throw new Error(result.error ?? 'Could not load the leaderboard.');
    }
    if (request !== generation) {
      return;
    }
    for (const score of result.rows) {
      scores.append(
        row([
          score.rank,
          score.name,
          score.strokes,
          duration(score.timeMs),
          new Date(score.achievedAt).toLocaleDateString(),
        ]),
      );
    }
    nextOffset = result.nextOffset;
    more.hidden = nextOffset === null;
    status.textContent = scores.children.length ? '' : 'No records yet.';
  } catch (error) {
    if (request === generation) {
      status.textContent = describe(error);
    }
  }
}

for (let count = 1; count <= HOLE_CHOICES; count++) {
  const button = document.createElement('button');
  button.textContent = String(count);
  button.type = 'button';
  button.setAttribute('aria-label', count + (count === 1 ? ' hole' : ' holes'));
  button.setAttribute('aria-pressed', String(holes === count));
  button.onclick = () => {
    holes = count;
    for (const tab of counts.children) {
      tab.setAttribute('aria-pressed', String(tab === button));
    }
    void load();
  };
  counts.append(button);
}

search.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => void load(), DEBOUNCE_MS);
});
more.onclick = () => void load(true);
void load();

export {};
