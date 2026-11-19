/** Select by stable player UID, not the socket ID that changes on reconnect. */
export function canWatch(party, gamePhase) {
  return (
    party.active &&
    party.phase === 'playing' &&
    (party.selfRole === 'spectator' || gamePhase === 'holed' || gamePhase === 'forfeit')
  );
}

export function watchChoice(party) {
  const choice = party.bpWatchChoice;
  return choice && choice.matchId === party.matchId && choice.holeIndex === party.holeIndex
    ? choice.target
    : 'auto';
}

export function watchCandidates(party) {
  const roster = new Map(party.roster.map((player) => [player.uid, player]));
  return (party.board?.standings ?? []).flatMap((row) => {
    const player = roster.get(row.uid);
    if (
      row.uid === party.self?.uid ||
      !row.alive ||
      row.finished ||
      !player?.connected ||
      player.role !== 'player'
    ) {
      return [];
    }
    return [player];
  });
}

export function followTarget(party, gamePhase) {
  if (!canWatch(party, gamePhase)) {
    return null;
  }
  const choice = watchChoice(party);
  if (choice === 'free') {
    return null;
  }
  const candidates = watchCandidates(party);
  return candidates.find((player) => player.uid === choice) ?? candidates[0] ?? null;
}

export function liveGhost(ghosts, id, now = Date.now()) {
  const ghost = ghosts.get(id);
  // The original renderer expires ghosts after four seconds. Never follow
  // expired or non-finite positions.
  if (
    !ghost ||
    now - ghost.lastSeen > 4000 ||
    ![ghost.cx, ghost.cy, ghost.cz].every(Number.isFinite)
  ) {
    return null;
  }
  return ghost;
}
