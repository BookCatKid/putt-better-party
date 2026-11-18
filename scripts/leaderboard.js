const counts = document.getElementById('counts');
const search = document.getElementById('search');
const scores = document.getElementById('scores');
const status = document.getElementById('status');
const more = document.getElementById('more');
let holes = 3;
let nextOffset = null;
let generation = 0;
let debounce;

function duration(ms) {
  return (
    Math.floor(ms / 60000) +
    ':' +
    String(Math.floor(ms / 1000) % 60).padStart(2, '0') +
    '.' +
    String(ms % 1000).padStart(3, '0')
  );
}
function row(values) {
  const element = document.createElement('tr');
  for (const value of values) {
    const cell = document.createElement('td');
    cell.textContent = String(value);
    element.append(cell);
  }
  return element;
}
async function load(append = false) {
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
      offset: String(append ? nextOffset : 0),
    });
    const response = await fetch('/api/leaderboard?' + params);
    const result = await response.json();
    if (!response.ok) {
      throw Error(result.error || 'Could not load leaderboard');
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
      status.textContent = error.message;
    }
  }
}
for (let count = 1; count <= 9; count++) {
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
    load();
  };
  counts.append(button);
}
search.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => load(), 200);
});
more.onclick = () => load(true);
load();
