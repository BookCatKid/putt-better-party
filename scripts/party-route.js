// These bindings are supplied by the hash-pinned original party route.
// Keep the engine mounted while the party socket and renderer initialize.
function PartyRoute() {
  const React = partyRouteReact;
  const jsx = partyRouteJsx;
  const partyStore = partyRouteStore;
  const usePartyState = (selector) => selectPartyRouteState(partyStore, selector);
  const code = decodeURIComponent(location.pathname.split('/').at(-1));
  const admission = usePartyAdmission(code);
  const active = usePartyState((state) => state.active);
  const holeIds = usePartyState((state) => state.holeIds);
  const holeIndex = usePartyState((state) => state.holeIndex);
  const currentMap = usePartyState((state) => state.currentMap);
  const matchId = usePartyState((state) => state.matchId);
  const phase = usePartyState((state) => state.phase);
  const error = usePartyState((state) => state.error);
  const initialSnapshot = usePartyState((state) => state.bpInitialSnapshot);
  const roster = usePartyState((state) => state.roster);
  const selfUid = usePartyState((state) => state.self?.uid);
  const board = usePartyState((state) => state.board);
  const final = usePartyState((state) => state.final);
  const mapReady = usePartyState((state) => state.mapReady);
  const sceneReady = usePartyState((state) => state.bpSceneReady);
  const [level, setLevel] = React.useState(defaultPartyLevel);
  const [mapError, setMapError] = React.useState('');
  const [retry, setRetry] = React.useState(0);
  const [loadingMap, setLoadingMap] = React.useState(false);
  const holeId = holeIds[holeIndex] ?? holeIds[0] ?? 'gen:' + defaultPartySeed;

  React.useEffect(() => {
    if (!active) {
      return;
    }

    let cancelled = false;
    setPartyMapReady(false);
    setMapError('');
    setLoadingMap(true);

    async function loadLevel() {
      if (currentMap) {
        const sanitized = sanitizePartyLevel(currentMap);
        validatePartyLevel(sanitized);
        return structuredClone(sanitized);
      }
      if (matchId) {
        throw new Error('Waiting for the party map. Please reconnect.');
      }
      return loadPartyLevel(holeId);
    }

    loadLevel()
      .then((loadedLevel) => {
        if (!cancelled) {
          setLevel(loadedLevel);
          setPartyMapReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMapError('Couldn’t load this party hole.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingMap(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [active, holeId, holeIndex, matchId, currentMap, retry]);

  React.useEffect(() => () => resetPartyRuntime(), []);
  React.useEffect(() => {
    let title = 'Party ' + code;
    if (!active) {
      title = 'Join ' + code;
    } else if (phase === 'final') {
      title = 'Results';
    } else if (phase !== 'lobby' && currentMap?.name) {
      title = currentMap.name + ' · Hole ' + (holeIndex + 1) + '/' + holeIds.length;
    }
    document.title = title + ' · Better Party';
  }, [code, active, phase, currentMap, holeIndex, holeIds.length]);

  const stateReady =
    initialSnapshot &&
    roster.some((player) => player.uid === selfUid) &&
    board &&
    (phase !== 'final' || final);
  const correctLevel = !currentMap || currentMap.id === level.id;
  const ready =
    stateReady && mapReady && !loadingMap && !mapError && correctLevel && sceneReady === level.id;
  const [takingTooLong, setTakingTooLong] = React.useState(false);

  React.useEffect(() => {
    setTakingTooLong(false);
    if (!active || ready) {
      return;
    }
    const timeout = setTimeout(() => setTakingTooLong(true), 12_000);
    return () => clearTimeout(timeout);
  }, [active, ready]);

  let loadingOverlay = null;
  if (!active && admission.resume) {
    loadingOverlay = jsx.jsx(PartyLoadingScreen, {
      message: 'Rejoining party…',
      error: admission.error,
      onRetry: admission.sessionExpired ? undefined : admission.join,
      onEnterName: admission.sessionExpired ? admission.enterName : undefined,
    });
  } else if (active && !ready) {
    loadingOverlay = jsx.jsx(PartyLoadingScreen, {
      message: 'Loading party…',
      error: mapError || error,
      onRetry: mapError ? () => setRetry((previous) => previous + 1) : undefined,
      onReload: takingTooLong ? () => location.reload() : undefined,
    });
  }

  let content = null;
  if (active) {
    content = jsx.jsx('div', {
      className: ready ? 'bp-party-view' : 'bp-party-view bp-party-initializing',
      'aria-busy': !ready,
      children: jsx.jsx(PartyGameRoot, { level }, code),
    });
  } else if (!admission.resume) {
    content = jsx.jsx(PartyEntry, { code, admission });
  }

  return jsx.jsxs(jsx.Fragment, {
    children: [
      content,
      loadingOverlay,
      ready &&
        error &&
        jsx.jsx('p', {
          role: 'alert',
          className:
            'fixed inset-x-6 bottom-4 z-50 rounded-xl bg-red-950 p-3 text-center text-sm text-white',
          children: error,
        }),
    ],
  });
}
