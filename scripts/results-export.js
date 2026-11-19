/**
 * Shareable results.
 *
 * Two exports: the current match as a CSV scorecard, and the party's completed
 * matches as JSON. Both are built by explicit projection from the display data, not
 * by serialising the store, so nothing private can ride along: no uid, session, host
 * token, connection id, ball cosmetic or course specification. That property is
 * tested directly.
 */

/** Escape one CSV field. Course names may contain commas or quotes. */
function bpCsvField(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) {
    return '"' + text.replaceAll('"', '""') + '"';
  }
  return text;
}

/**
 * One scorecard cell, matching the on-screen table.
 *
 * `-` is used for a hole with no score and no named state, so a shared file says the
 * same thing the screen did rather than inventing a zero.
 */
function bpCsvCell(round, score) {
  if (round.status === 'skipped') {
    return 'Skip';
  }
  if (score?.status === 'eliminated') {
    return 'DNF';
  }
  if (score?.status === 'ended') {
    return 'End';
  }
  return typeof score?.strokes === 'number' ? score.strokes : '-';
}

/** Strokes relative to the par of the holes actually scored, or '' when none were. */
function bpCsvRelative(strokes, parFaced) {
  if (!parFaced) {
    return '';
  }
  const relative = strokes - parFaced;
  if (relative === 0) {
    return 'E';
  }
  return relative > 0 ? '+' + relative : String(relative);
}

/**
 * The current match as a CSV scorecard.
 *
 * Rows: a course-name row, a par row, a header row and one row per player. The
 * player rows come from `standings`, which is already in rank order, and the totals
 * are the same values the screen shows.
 */
export function bpResultsCsv(roundHistory, standings) {
  if (
    !Array.isArray(roundHistory) ||
    !roundHistory.length ||
    !Array.isArray(standings) ||
    !standings.length
  ) {
    return '';
  }
  const rows = [];
  rows.push(
    ['Hole', ...roundHistory.map((round) => round.index + 1), 'Total', 'To par'].map(bpCsvField),
  );
  rows.push(
    ['Course', ...roundHistory.map((round) => round.title ?? round.id), '', ''].map(bpCsvField),
  );
  rows.push(
    [
      'Par',
      ...roundHistory.map((round) => (round.status === 'skipped' ? '-' : (round.par ?? ''))),
      '',
      '',
    ].map(bpCsvField),
  );
  for (const player of standings) {
    let parFaced = 0;
    const cells = roundHistory.map((round) => {
      const score = round.rows?.find((entry) => entry.uid === player.uid);
      if (typeof score?.strokes === 'number') {
        parFaced += round.par ?? 0;
      }
      return bpCsvCell(round, score);
    });
    rows.push(
      [
        player.name,
        ...cells,
        player.totalStrokes,
        bpCsvRelative(player.totalStrokes, parFaced),
      ].map(bpCsvField),
    );
  }
  return rows.map((row) => row.join(',')).join('\r\n') + '\r\n';
}

/**
 * The party's completed matches as JSON.
 *
 * The history is already a summary; this projects it again to a fixed key set, so a
 * future field cannot leak into a shared file by accident. `matchId` is dropped: it
 * is an internal identifier with no meaning outside this room.
 */
export function bpHistoryJson(matchHistory) {
  const matches = (Array.isArray(matchHistory) ? matchHistory : []).map((match) => ({
    endedAt: match.endedAt,
    holes: match.holes,
    courses: (match.courses ?? []).map((course) => ({
      id: course.id,
      title: course.title,
      par: course.par,
    })),
    standings: (match.standings ?? []).map((row) => ({
      name: row.name,
      rank: row.rank,
      holesSurvived: row.holesSurvived,
      totalStrokes: row.totalStrokes,
      totalTimeMs: row.totalTimeMs,
    })),
  }));
  return JSON.stringify({ format: 'better-party.results', version: 1, matches }, null, 2) + '\n';
}

/** Save text as a file. A download works without clipboard permission. */
export function bpDownloadResults(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  // The click has been handled synchronously; release the blob on the next turn.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
