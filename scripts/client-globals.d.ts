/**
 * Types for the globals that the patched bundles inject into authored snippets.
 *
 * Ten of the thirteen client files are not standalone scripts: `patch-client.py`
 * splices them into the pinned bundles' own lexical scope, so at runtime they see
 * dozens of names that no module of theirs declares - `transportPartyStore`,
 * `bpConnection`, `BetterPartyReact` and so on. Type-checking such a file means
 * telling the compiler what those names are without pretending they are imports,
 * because importing them would be a lie about how the file is loaded.
 *
 * This is that declaration, deliberately narrow. It describes only what the
 * snippets actually read, derived from the pinned bundles and from the bindings
 * objects they build; nothing is widened "just in case", because a wrong guess
 * here would let a real mismatch pass. Where a shape is genuinely unknown it is
 * `unknown` and has to be narrowed at the point of use.
 *
 * These are `declare` statements with no runtime presence. Nothing in this file is
 * emitted, and the bundles remain untouched.
 */

/** A minimal structural store: a snapshot plus a change subscription. */
interface SnippetStore<TState> {
  readonly state: TState;
  subscribe(listener: () => void): { unsubscribe(): void };
}

/** The party store fields the transport and lobby snippets read. */
interface SnippetPartyState {
  active: boolean;
  code: string;
  hostToken: string | null;
  self: string;
  selfRole: 'player' | 'spectator';
  isHost: boolean;
  count: number;
  phase: string;
  holeIndex: number;
  holeIds: string[];
  matchId: string | null;
  mapReady: boolean;
  startAt?: number;
  currentMap: { id: string } | null;
  config: Record<string, unknown>;
  roster: { id: string }[];
  board: unknown;
  final: unknown;
  vote: unknown;
  bpConnected: boolean;
  bpEverConnected: boolean;
  bpConnectionError: string | null;
  bpSceneReady: string | null;
  awaitingPlayers: number;
  recoveryNotice?: boolean;
}

/** The game store fields the transport reads. */
interface SnippetGameState {
  strokes: number;
  phase: string;
  result: { strokes: number; par: number; path?: number[] } | null;
  level: { id: string; cup?: [number, number, number] } | null;
  /** Advanced once per installed level; absent in older builds. */
  attemptSeq?: number;
}

/** The settings the transport reads. */
interface SnippetSettingsState {
  ghosts: boolean;
}

/** The live scene handles the transport samples ghost positions from. */
interface SnippetScene {
  ballPos: { x: number; y: number; z: number };
  pointer: { x: number; z: number; active: boolean };
  discontinuitySeq?: number;
  activeEventNodes?: Iterable<string>;
  traj?: number[];
  eventTimeline?: { sample: number; node: string }[];
}

/** Everything an authored snippet may reference from the bundle scope. */
declare const transportPartyStore: SnippetStore<SnippetPartyState>;
declare const transportGameStore: SnippetStore<SnippetGameState>;
declare const transportSettings: SnippetStore<SnippetSettingsState>;
declare const transportScene: SnippetScene;
declare const partyRuntimeStore: SnippetStore<SnippetPartyState>;
declare const betterPartyStore: SnippetStore<SnippetPartyState>;
declare function bpConnection(connected: boolean, errorMessage?: string | null): void;
declare function bpAck(message: { requestId: string; ok: boolean; msg?: string }): void;
declare function bpReceiveVote(message: { vote: SnippetPartyState['vote']; now: number }): void;
declare function registerTransportSender(
  send: ((message: unknown, requireSynchronization?: boolean) => boolean) | null,
): void;
declare function setTransportIdentity(
  isHost: boolean,
  count: number,
  role: 'player' | 'spectator',
): void;
declare function updateTransportParty(snapshot: unknown): void;
declare function setTransportFlyCamera(enabled: boolean): void;
declare function setTransportRoster(players: unknown[]): void;
declare function setTransportBoard(board: unknown): void;
declare function setTransportFinal(final: unknown): void;
declare function removeTransportGhost(id: string): void;
declare function showTransportCompletion(completion: {
  id: string;
  hue: number;
  strokes: number;
  par: number;
  at: number;
}): void;
declare function transportGhostHue(id: string): number;
declare function setTransportError(message: string): void;
declare function updateTransportGhost(position: unknown): void;
declare function transportSceneReadyLevelId(): string | null;
declare function receiveTransportHostToken(token: string): void;
declare function clearTransportHostToken(): void;
declare function isTransportSpectator(): boolean;

/**
 * A timer handle. Browsers return a number and Bun returns an object, and the
 * transport is exercised under both, so the handle is treated as opaque.
 */
type TimerHandle = ReturnType<typeof setTimeout>;

/** The bindings object `resolveTransportBindings` returns.
 *
 * Declared because it is the transport's only seam to the environment: with it
 * typed, every `bind.*` call is checked, and an injected test double cannot omit a
 * member or supply one of the wrong shape.
 *
 * The store types are structural interfaces declared above rather than the
 * bundle's own classes, so this stays a description of what is read and not a
 * copy of upstream internals.
 */
interface TransportBindings {
  readonly WebSocket: typeof WebSocket;
  readonly location: Location;
  readonly document: Document;
  readonly setTimeout: (handler: () => void, ms: number) => TimerHandle;
  /** Timer handles may be unset, and clearing an unset handle is a no-op. */
  readonly clearTimeout: (handle: TimerHandle | undefined) => void;
  readonly setInterval: (handler: () => void, ms: number) => TimerHandle;
  readonly clearInterval: (handle: TimerHandle | undefined) => void;
  readonly partyStore: SnippetStore<SnippetPartyState>;
  readonly gameStore: SnippetStore<SnippetGameState>;
  readonly settingsStore: SnippetStore<SnippetSettingsState>;
  readonly scene: SnippetScene;
  readonly connection: (connected: boolean, errorMessage?: string | null) => void;
  readonly registerSender: (
    send: ((message: unknown, requireSynchronization?: boolean) => boolean) | null,
  ) => void;
  readonly setIdentity: (isHost: boolean, count: number, role: 'player' | 'spectator') => void;
  readonly capturedHostToken: (token: string) => void;
  readonly dropHostToken: () => void;
  readonly updateParty: (snapshot: unknown) => void;
  readonly setFlyCamera: (enabled: boolean) => void;
  readonly setRoster: (players: unknown[]) => void;
  readonly setBoard: (board: unknown) => void;
  readonly setFinal: (final: unknown) => void;
  readonly removeGhost: (id: string) => void;
  readonly showCompletion: (completion: {
    id: string;
    hue: number;
    strokes: number;
    par: number;
    at: number;
  }) => void;
  readonly ghostHue: (id: string) => number;
  readonly setError: (message: string) => void;
  readonly updateGhost: (position: unknown) => void;
  readonly sceneReadyLevelId: () => string | null;
  readonly isSpectator: () => boolean;
  readonly ack: (message: { requestId: string; ok: boolean; msg?: string }) => void;
  readonly updateVote: (message: { vote: SnippetPartyState['vote']; now: number }) => void;
}

/** What the transport needs to run against a fake socket and stores. */
interface TransportOptions {
  readonly hostToken?: string;
  readonly bindings?: Partial<TransportBindings>;
  readonly onError?: (code: string, message?: string) => void;
}
