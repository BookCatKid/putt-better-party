import { MAP_SOURCE, isRecord, type MapSource, type RoomConfig, type RoomPhase } from './domain.js';
import { LATE_JOIN, type LateJoinPolicy } from './domain.js';
import type { Identity, RoomCheckpoint } from './room-types.js';

/**
 * Structural validation for a persisted room checkpoint.
 *
 * `RoomStore.load()` reads rows written by an earlier process, which is an
 * untrusted boundary: the file can be truncated by a power loss, edited by
 * hand, produced by a different build, or written by a hostile local process
 * holding the database. Parsing must therefore produce either a checkpoint
 * whose every field satisfies the same bounds the live room enforces, or an
 * explicit rejection with a reason. It must never hand a half-valid object to
 * `Room.restore`.
 *
 * The constants below mirror the rules in `src/room.ts`: `Room.issue` caps the
 * identity list and mints hues below 360, `Room.configure` bounds the lobby
 * configuration, and `Room.restore` caps the random history. They are repeated
 * here rather than imported so this boundary stays honest on its own: a looser
 * live rule should not silently widen what a stored row may contain.
 *
 * Every field is required, with two documented exceptions (`hostTransfer`,
 * which is optional in the interface, and `config.randomHoles`, described
 * below). Being strict about a field that could be defaulted is deliberate: a
 * checkpoint is written atomically by `Room.checkpoint`, so a missing field
 * never means "an older build wrote this", it means the row is damaged or was
 * tampered with. A new field or a changed shape belongs in a new `version`,
 * which is what the version check exists for. The one field whose absence is
 * migrated is `config.randomHoles`, because rows written before that setting
 * existed are real and recoverable.
 */
export const CHECKPOINT_VERSION = 1;
const MAX_IDENTITIES = 200;
const MAX_HUE = 359;
const MAX_NAME_LENGTH = 24;
const MIN_RANDOM_HOLES = 1;
const MAX_RANDOM_HOLES = 10_000;
/**
 * A manual playlist has no upper bound in the room, so this is a persistence
 * resource limit rather than a protocol rule. The largest playlist in the
 * repository's tests is 153 courses, so 500 leaves room without allowing a
 * hostile row to allocate an unbounded configuration.
 */
const MAX_HOLE_COUNT = 500;
const MIN_TIMER_MS = 0;
const MAX_TIMER_MS = 86_400_000;
const MAX_PLAYERS = 50;
/**
 * Course ids are short slugs upstream; the saved-playlist API accepts at most
 * 64 characters. The cap is deliberately generous here so a row written by an
 * older build with a longer id still loads, but bounded so a hostile row cannot
 * carry megabyte-sized keys.
 */
const MAX_COURSE_ID_LENGTH = 100;
const MAX_TITLE_LENGTH = 200;
const MAX_TITLES = MAX_HOLE_COUNT;
/** `Room.restore` keeps at most this many random-history entries. */
const MAX_RANDOM_SEEN = 10_000;
const MAX_ROOM_CODE_LENGTH = 64;
/** Well above the largest valid checkpoint (about 1 MB of capped history). */
const MAX_PAYLOAD_LENGTH = 2_000_000;
const MAX_TOKEN_LENGTH = 512;
const MAX_UID_LENGTH = 100;
const ROOM_PHASES: readonly RoomPhase[] = [
  'lobby',
  'countdown',
  'playing',
  'hole-results',
  'final',
];
const MAP_SOURCES: readonly MapSource[] = [MAP_SOURCE.RANDOM, MAP_SOURCE.PICKED];

export type CheckpointFailureKind = 'unsupported-version' | 'corrupt';

export interface CheckpointParseFailure {
  ok: false;
  kind: CheckpointFailureKind;
  reason: string;
}

export interface CheckpointParseSuccess {
  ok: true;
  checkpoint: RoomCheckpoint;
}

export type CheckpointParseResult = CheckpointParseSuccess | CheckpointParseFailure;

class InvalidCheckpoint extends Error {
  readonly kind: CheckpointFailureKind;

  constructor(kind: CheckpointFailureKind, reason: string) {
    super(reason);
    this.kind = kind;
    this.name = 'InvalidCheckpoint';
  }
}

/**
 * Validate one parsed JSON value. Returns a normalised checkpoint on success,
 * or a failure that separates "this build cannot read the row" from "the row
 * is damaged". Both are skipped by the loader, but the distinction is logged
 * and keeps an unsupported version eligible for a later migration.
 */
export function parseRoomCheckpoint(value: unknown): CheckpointParseResult {
  try {
    return { ok: true, checkpoint: readCheckpoint(value) };
  } catch (error) {
    if (error instanceof InvalidCheckpoint) {
      return { ok: false, kind: error.kind, reason: error.message };
    }
    throw error;
  }
}

/**
 * Decode and validate a stored payload. JSON parsing is part of the same
 * boundary because a truncated or non-JSON payload is the most common form of
 * corruption and deserves the same "corrupt" classification as a bad field
 * rather than surfacing as an exception from every caller. The size check runs
 * first so an oversized row is refused before it is parsed into memory; a real
 * checkpoint is far smaller than the cap (the identity cap and the random
 * history cap are the two largest contributors and total well under a
 * megabyte).
 */
export function parseStoredRoomPayload(payload: string): CheckpointParseResult {
  if (payload.length > MAX_PAYLOAD_LENGTH) {
    return {
      ok: false,
      kind: 'corrupt',
      reason: `the payload is ${payload.length} characters, more than the supported ${MAX_PAYLOAD_LENGTH}`,
    };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    return { ok: false, kind: 'corrupt', reason: 'the payload is not valid JSON' };
  }
  return parseRoomCheckpoint(decoded);
}

function reject(kind: CheckpointFailureKind, reason: string): never {
  throw new InvalidCheckpoint(kind, reason);
}

/** A short, allocation-safe description of a rejected value for the log. */
function describeValue(value: unknown): string {
  if (typeof value === 'undefined') {
    return 'nothing';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return `the string ${JSON.stringify(value.slice(0, 40))}`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  return 'an object';
}

function readCheckpoint(value: unknown): RoomCheckpoint {
  if (!isRecord(value)) {
    reject('corrupt', `the payload is ${describeValue(value)}, not a JSON object`);
  }
  const rawVersion = value.version;
  if (typeof rawVersion === 'undefined') {
    reject('corrupt', 'version is missing');
  }
  if (typeof rawVersion !== 'number') {
    reject(
      'corrupt',
      `version must be the number ${CHECKPOINT_VERSION}, not ${describeValue(rawVersion)}`,
    );
  }
  if (rawVersion !== CHECKPOINT_VERSION) {
    reject('unsupported-version', `unsupported version ${describeValue(rawVersion)}`);
  }
  return {
    version: CHECKPOINT_VERSION,
    code: readString(value, 'code', MAX_ROOM_CODE_LENGTH),
    hostToken: readString(value, 'hostToken', MAX_TOKEN_LENGTH),
    hostUid: readHostUid(value),
    hostTransfer: readHostTransfer(value),
    issued: readIdentities(value),
    config: readConfig(value.config),
    titles: readTitles(value.titles),
    randomSeen: readRandomSeen(value.randomSeen),
    phase: readPhase(value.phase),
    starting: readBoolean(value, 'starting'),
    lastActivity: readLastActivity(value),
    recoveryNotice: readBoolean(value, 'recoveryNotice'),
  };
}

function readString(record: Record<string, unknown>, key: string, maximumLength: number): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) {
    reject(
      'corrupt',
      `${key} must be a non-empty string of at most ${maximumLength} characters, not ${describeValue(value)}`,
    );
  }
  return value;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    reject('corrupt', `${key} must be a boolean, not ${describeValue(value)}`);
  }
  return value;
}

function readInteger(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    reject(
      'corrupt',
      `${key} must be a whole number between ${minimum} and ${maximum}, not ${describeValue(value)}`,
    );
  }
  return value;
}

function readHostUid(record: Record<string, unknown>): string | null {
  const value = record.hostUid;
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_UID_LENGTH) {
    reject('corrupt', `hostUid must be null or a uid string, not ${describeValue(value)}`);
  }
  return value;
}

function readLastActivity(record: Record<string, unknown>): number {
  const value = record.lastActivity;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    reject('corrupt', `lastActivity must be a finite timestamp, not ${describeValue(value)}`);
  }
  return value;
}

function readPhase(value: unknown): RoomPhase {
  const phase = ROOM_PHASES.find((known) => known === value);
  if (!phase) {
    reject('corrupt', `phase must be a known room phase, not ${describeValue(value)}`);
  }
  return phase;
}

function readMapSource(value: unknown): MapSource {
  const source = MAP_SOURCES.find((known) => known === value);
  if (!source) {
    reject('corrupt', `config.mapSource must be "random" or "picked", not ${describeValue(value)}`);
  }
  return source;
}

function readHostTransfer(record: Record<string, unknown>): RoomCheckpoint['hostTransfer'] {
  const transfer = record.hostTransfer;
  if (typeof transfer === 'undefined' || transfer === null) {
    return null;
  }
  if (!isRecord(transfer)) {
    reject('corrupt', `hostTransfer must be null or an object, not ${describeValue(transfer)}`);
  }
  // A succession record has no previous owner, so an empty fromUid is valid;
  // a transfer without a target is not.
  const fromUid = transfer.fromUid;
  if (typeof fromUid !== 'string' || fromUid.length > MAX_UID_LENGTH) {
    reject('corrupt', `hostTransfer.fromUid must be a uid string, not ${describeValue(fromUid)}`);
  }
  const toUid = transfer.toUid;
  if (typeof toUid !== 'string' || toUid.length === 0 || toUid.length > MAX_UID_LENGTH) {
    reject('corrupt', `hostTransfer.toUid must be a uid string, not ${describeValue(toUid)}`);
  }
  const at = transfer.at;
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) {
    reject('corrupt', `hostTransfer.at must be a finite timestamp, not ${describeValue(at)}`);
  }
  return { fromUid, toUid, at };
}

function readIdentities(record: Record<string, unknown>): Identity[] {
  const value = record.issued;
  if (!Array.isArray(value)) {
    reject('corrupt', `issued must be an array, not ${describeValue(value)}`);
  }
  const entries: unknown[] = value;
  if (entries.length > MAX_IDENTITIES) {
    // A valid room can never hold this many, and silently dropping credentials
    // would let two players end up sharing a session.
    reject(
      'corrupt',
      `issued holds ${entries.length} identities, more than the ${MAX_IDENTITIES} a room can issue`,
    );
  }
  const identities: Identity[] = [];
  const knownUids = new Set<string>();
  for (const entry of entries) {
    const identity = readIdentity(entry);
    if (knownUids.has(identity.uid)) {
      reject('corrupt', `issued repeats the uid ${JSON.stringify(identity.uid)}`);
    }
    knownUids.add(identity.uid);
    identities.push(identity);
  }
  return identities;
}

function readIdentity(value: unknown): Identity {
  if (!isRecord(value)) {
    reject('corrupt', `issued entries must be objects, not ${describeValue(value)}`);
  }
  const uid = readString(value, 'uid', MAX_UID_LENGTH);
  const session = readString(value, 'session', MAX_TOKEN_LENGTH);
  const name = readString(value, 'name', MAX_NAME_LENGTH);
  if (!name.trim()) {
    reject('corrupt', 'issued entry name must contain a visible character');
  }
  const hue = readInteger(value, 'hue', 0, MAX_HUE);
  return { uid, session, name, hue };
}

function readConfig(value: unknown): RoomConfig {
  if (!isRecord(value)) {
    reject('corrupt', `config must be an object, not ${describeValue(value)}`);
  }
  const mapSource = readMapSource(value.mapSource);
  const holeMaximum = mapSource === MAP_SOURCE.RANDOM ? MAX_RANDOM_HOLES : MAX_HOLE_COUNT;
  const holes = readInteger(value, 'holes', 1, holeMaximum);
  const randomHoles = readRandomHoles(value, mapSource, holes);
  return {
    holes,
    timerMs: readInteger(value, 'timerMs', MIN_TIMER_MS, MAX_TIMER_MS),
    elimination: readBoolean(value, 'elimination'),
    maxPlayers: readInteger(value, 'maxPlayers', 1, MAX_PLAYERS),
    mapSource,
    selectedHoleIds: readHoleIds(value.selectedHoleIds),
    locked: readBoolean(value, 'locked'),
    excludeDaily: readBoolean(value, 'excludeDaily'),
    randomHoles,
    lateJoin: readLateJoin(value),
    courseVoting: readBoolean(value, 'courseVoting'),
  };
}

/**
 * Late joining is one of three named policies, never an arbitrary string, so a
 * row cannot smuggle an unrecognised policy past the live configuration rules.
 */
function readLateJoin(record: Record<string, unknown>): LateJoinPolicy {
  const value = record.lateJoin;
  if (value !== LATE_JOIN.NEVER && value !== LATE_JOIN.NEXT_HOLE && value !== LATE_JOIN.ALWAYS) {
    reject(
      'corrupt',
      `config.lateJoin must be one of ${Object.values(LATE_JOIN).join(', ')}, not ${describeValue(value)}`,
    );
  }
  return value;
}

/**
 * `Room.restore` fills `randomHoles` from `holes` when it is missing, because
 * rows written before the field existed are still readable. Keep that migration
 * here so the validator returns a complete configuration.
 */
function readRandomHoles(
  record: Record<string, unknown>,
  mapSource: MapSource,
  holes: number,
): number {
  if (typeof record.randomHoles === 'undefined') {
    return mapSource === MAP_SOURCE.RANDOM ? holes : 3;
  }
  return readInteger(record, 'randomHoles', MIN_RANDOM_HOLES, MAX_RANDOM_HOLES);
}

function readHoleIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    reject('corrupt', `config.selectedHoleIds must be an array, not ${describeValue(value)}`);
  }
  const entries: unknown[] = value;
  if (entries.length > MAX_HOLE_COUNT) {
    reject(
      'corrupt',
      `config.selectedHoleIds holds ${entries.length} ids, more than the supported ${MAX_HOLE_COUNT}`,
    );
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_COURSE_ID_LENGTH) {
      reject(
        'corrupt',
        `config.selectedHoleIds must contain course ids of at most ${MAX_COURSE_ID_LENGTH} characters, not ${describeValue(entry)}`,
      );
    }
    ids.push(entry);
  }
  return ids;
}

function readTitles(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    reject('corrupt', `titles must be an object, not ${describeValue(value)}`);
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_TITLES) {
    reject(
      'corrupt',
      `titles holds ${entries.length} entries, more than the supported ${MAX_TITLES}`,
    );
  }
  const titles: Array<[string, string]> = [];
  for (const [id, title] of entries) {
    if (id.length === 0 || id.length > MAX_COURSE_ID_LENGTH) {
      reject('corrupt', 'titles keys must be course ids');
    }
    if (typeof title !== 'string' || title.length > MAX_TITLE_LENGTH) {
      reject(
        'corrupt',
        `titles["${id}"] must be a string of at most ${MAX_TITLE_LENGTH} characters, not ${describeValue(title)}`,
      );
    }
    titles.push([id, title]);
  }
  return Object.fromEntries(titles);
}

/**
 * The random history only feeds selection avoidance, so an oversized list is
 * trimmed to the same cap `Room.restore` applies instead of rejecting the room.
 * Entries beyond the cap are never read, so they are not validated.
 */
function readRandomSeen(value: unknown): string[] {
  if (!Array.isArray(value)) {
    reject('corrupt', `randomSeen must be an array, not ${describeValue(value)}`);
  }
  const entries: unknown[] = value;
  const kept = Math.min(entries.length, MAX_RANDOM_SEEN);
  const history: string[] = [];
  for (let index = 0; index < kept; index += 1) {
    const entry = entries[index];
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_COURSE_ID_LENGTH) {
      reject(
        'corrupt',
        `randomSeen must contain course ids of at most ${MAX_COURSE_ID_LENGTH} characters, not ${describeValue(entry)}`,
      );
    }
    history.push(entry);
  }
  return history;
}
