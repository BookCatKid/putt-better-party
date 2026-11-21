/**
 * Which model file each course piece uses, and how it collides.
 *
 * A course specification names its pieces (`"straight"`, `"ramp-high"`), but the
 * geometry lives in GLB files whose names do not always match the piece name:
 * `square-corner` is `square-corner-a.glb`, `bump` is `bump-walls.glb`, and the
 * event pieces (`sand`, `ice`, `slider`, `spinner`, `jump`, `boost`) are drawn
 * with the plain straight or open model because their behaviour comes from an
 * event device or a zone rather than from the mesh. Without this table a piece
 * either fails to resolve or silently collides as the wrong shape.
 *
 * The table is generated from the pinned client's own `registry-*.js` map by
 * evaluating that map with its helper functions stubbed, then reduced to the
 * fields the verifier needs. It is stored as data rather than evaluated at
 * runtime so it can be reviewed; `piece-registry` tests re-derive the bundle's
 * map and assert every entry matches, so the two cannot drift apart unnoticed.
 *
 * `replacedBy` is deliberately dropped. It marks pieces the editor no longer
 * offers, but a course authored with one still plays against the geometry it
 * was authored with, and substituting the newer model would change the
 * colliders under a replay recorded before the swap.
 */

export interface PieceTemplate {
  /** The model in `models/minigolf/` that supplies this piece's triangles. */
  glb: string;
  /**
   * An additional model whose triangles join the collider alongside `glb`'s.
   * A gate uses one because the drawn gate has a bar the ball must pass under,
   * while the flat floor beneath it is a separate model.
   */
  floorGlb?: string;
  /** Height, in model units, that the piece's base is lifted above its cell. */
  lift?: number;
  /** The piece has no collision of its own; an event device drives the ball. */
  noCollide?: boolean;
  /** The piece's floor gets no skirt plate underneath it. */
  noSkirt?: boolean;
  /**
   * The skirt style when one is emitted: the default `box` is a single flat
   * quad under the floor's bounding box, while `deck` is a per-triangle plate
   * used by the `-v2` corner variants whose floors are not axis-aligned boxes.
   */
  safetyNet?: 'deck';
  /**
   * The event-device behaviour the piece carries, when any. `boost`, `jump`,
   * `sand`, `ice`, `bumper` and `geyser` pieces create a zone the ball reacts
   * to, `portal` pairs teleport the ball, and `windmill`, `spinner` and
   * `slider` move only under the course's event graph.
   */
  special?:
    | 'windmill'
    | 'spinner'
    | 'slider'
    | 'boost'
    | 'jump'
    | 'sand'
    | 'ice'
    | 'bumper'
    | 'geyser'
    | 'portal';
}

/** Every piece the pinned client can place. */
const PIECES: Record<string, PieceTemplate> = {
  block: { glb: 'block.glb' },
  boost: { glb: 'straight.glb', special: 'boost' },
  'boost-open': { glb: 'open.glb', special: 'boost' },
  bump: { glb: 'bump-walls.glb' },
  'bump-down': { glb: 'bump-down-walls.glb' },
  'bump-down-open': { glb: 'bump-down.glb' },
  'bump-open': { glb: 'bump.glb' },
  'bumper-open': { glb: 'open.glb', special: 'bumper' },
  castle: { glb: 'castle.glb' },
  corner: { glb: 'corner.glb' },
  crest: { glb: 'crest.glb' },
  end: { glb: 'end.glb' },
  gap: { glb: 'gap.glb', noSkirt: true },
  gate: { glb: 'structure-gate.glb' },
  'gate-base': { glb: 'structure-gate.glb', floorGlb: 'gate-base.glb' },
  'gate-wide': { glb: 'structure-gate-wide.glb' },
  'gate-wide-base': { glb: 'structure-gate-wide.glb', floorGlb: 'gate-base.glb' },
  gates: { glb: 'structure-gates.glb' },
  'gates-base': { glb: 'structure-gates.glb', floorGlb: 'gate-base.glb' },
  geyser: { glb: 'gap.glb', noSkirt: true, special: 'geyser' },
  halfpipe: { glb: 'spline-concave-straight.glb', lift: 0.566, noCollide: true, noSkirt: true },
  'hill-corner': { glb: 'hill-corner.glb' },
  'hill-round': { glb: 'hill-round.glb' },
  'hill-square': { glb: 'hill-square.glb' },
  'hole-open': { glb: 'hole-open.glb' },
  'hole-round': { glb: 'hole-round.glb' },
  'hole-square': { glb: 'hole-square.glb' },
  ice: { glb: 'straight.glb', special: 'ice' },
  'ice-open': { glb: 'open.glb', special: 'ice' },
  'inner-corner': { glb: 'inner-corner.glb' },
  jump: { glb: 'straight.glb', special: 'jump' },
  'jump-open': { glb: 'open.glb', special: 'jump' },
  loop: { glb: 'spline-concave-looping.glb', lift: 0.566, noCollide: true, noSkirt: true },
  'narrow-block': { glb: 'narrow-block.glb' },
  'narrow-round': { glb: 'narrow-round.glb' },
  'narrow-square': { glb: 'narrow-square.glb' },
  'obstacle-block': { glb: 'obstacle-block.glb' },
  'obstacle-diamond': { glb: 'obstacle-diamond.glb' },
  'obstacle-triangle': { glb: 'obstacle-triangle.glb' },
  open: { glb: 'open.glb' },
  portal: { glb: 'end.glb', special: 'portal' },
  ramp: { glb: 'ramp.glb' },
  'ramp-high': { glb: 'ramp-high.glb' },
  'ramp-large': { glb: 'ramp-large.glb' },
  'ramp-large-side': { glb: 'ramp-large-side.glb' },
  'ramp-low': { glb: 'ramp-low.glb' },
  'ramp-medium': { glb: 'ramp-medium.glb' },
  'ramp-sharp': { glb: 'ramp-sharp.glb' },
  'ramp-square': { glb: 'ramp-square.glb' },
  'receiver-corner': { glb: 'receiver-corner.glb', noSkirt: true },
  'round-cap': { glb: 'hole-round.glb', floorGlb: 'open.glb' },
  'round-corner-a': { glb: 'round-corner-a.glb' },
  'round-corner-a-v2': { glb: 'round-corner-a.glb', safetyNet: 'deck' },
  'round-corner-b': { glb: 'round-corner-b.glb' },
  'round-corner-c': { glb: 'round-corner-c.glb' },
  'round-corner-c-v2': { glb: 'round-corner-c.glb', safetyNet: 'deck' },
  'round-large-corner': { glb: 'round-large-corner.glb' },
  'round-large-corner-open': { glb: 'round-large-corner-open.glb' },
  'round-large-corner-open-v2': { glb: 'round-large-corner-open.glb', safetyNet: 'deck' },
  'round-large-corner-v2': { glb: 'round-large-corner.glb', safetyNet: 'deck' },
  sand: { glb: 'straight.glb', special: 'sand' },
  'sand-open': { glb: 'open.glb', special: 'sand' },
  side: { glb: 'side.glb' },
  'skew-corner': { glb: 'skew-corner.glb' },
  'skew-corner-v2': { glb: 'skew-corner.glb', safetyNet: 'deck' },
  'skew-large-corner': { glb: 'skew-large-corner.glb' },
  'skew-large-corner-open': { glb: 'skew-large-corner-open.glb' },
  'skew-large-corner-open-v2': { glb: 'skew-large-corner-open.glb', safetyNet: 'deck' },
  'skew-large-corner-v2': { glb: 'skew-large-corner.glb', safetyNet: 'deck' },
  slider: { glb: 'straight.glb', special: 'slider' },
  'slider-open': { glb: 'open.glb', special: 'slider' },
  spinner: { glb: 'straight.glb', special: 'spinner' },
  'spinner-open': { glb: 'open.glb', special: 'spinner' },
  'spline-bend-deck': {
    glb: 'spline-default-straight-bend.glb',
    lift: 1,
    noCollide: true,
    noSkirt: true,
  },
  'spline-curve-deck': { glb: 'spline-default-curve.glb', lift: 1, noCollide: true, noSkirt: true },
  'spline-straight': { glb: 'spline-default.glb' },
  'spline-straight-concave': { glb: 'spline-concave.glb' },
  split: { glb: 'split.glb' },
  'split-start': { glb: 'split-start.glb' },
  'split-t': { glb: 'split-t.glb' },
  'split-walls-to-open': { glb: 'split-walls-to-open.glb' },
  'square-corner': { glb: 'square-corner-a.glb' },
  start: { glb: 'start.glb' },
  straight: { glb: 'straight.glb' },
  'structure-windmill': { glb: 'structure-windmill.glb', special: 'windmill' },
  'support-low': { glb: 'support-low.glb' },
  'support-low-bottom': { glb: 'support-low-bottom.glb' },
  supports: { glb: 'supports.glb' },
  'tunnel-double': { glb: 'tunnel-double.glb' },
  'tunnel-narrow': { glb: 'tunnel-narrow.glb' },
  'tunnel-wide': { glb: 'tunnel-wide.glb' },
  'wall-left': { glb: 'wall-left.glb' },
  'wall-right': { glb: 'wall-right.glb' },
  'walls-to-open': { glb: 'walls-to-open.glb' },
  windmill: { glb: 'windmill.glb', special: 'windmill' },
};

/**
 * The three hole pieces get no skirt regardless of the registry's `skirt`
 * field: the client's own `Re` set (`CourseEventDevices-*.js`) excludes them,
 * because a plate across the opening would make the hole unreachable.
 */
export const NO_SKIRT_PIECES = new Set(['hole-round', 'hole-square', 'hole-open']);

/**
 * `special` values that move the ball during play even with no event graph:
 * a `loop` always forms a guided zone, and the six zone kinds act on contact.
 * `windmill`, `spinner` and `slider` are absent because they move only under
 * the course's `events` field.
 */
export const ACTIVE_SPECIALS = new Set([
  'boost',
  'jump',
  'sand',
  'ice',
  'bumper',
  'geyser',
  'portal',
]);

/** Resolve a course piece name to its template, or `null` when unknown. */
export function pieceTemplate(name: string): PieceTemplate | null {
  return PIECES[name] ?? null;
}

/** Every known piece name, for tests and for validating a specification. */
export function pieceNames(): string[] {
  return Object.keys(PIECES);
}
