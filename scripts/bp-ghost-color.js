/**
 * Remote-ball appearance for the party canvas.
 *
 * The upstream ghost renderer knows daily-hole cosmetics only; the party
 * resolves each ghost's ball from the validated roster instead. Called once per
 * ghost per frame by the patched instanced-ball loop, with the animated-effect
 * budget passed in because the count lives in the host bundle: beyond it the
 * ball draws the selected solid colour, the same budget rule the original
 * applies to its own overlays.
 *
 * @param {string} id ghost id, which is the roster entry's short id
 * @param {object} ghost the instanced ghost record being drawn
 * @param {object} color the THREE.Color the loop fills before upload
 * @param {number} animatedCount animated ghosts drawn so far this frame
 * @param {number} animatedBudget the engine's animated-overlay cap (`jt`)
 */
export function bpGhostColor(id, ghost, color, animatedCount, animatedBudget) {
  const player = transportPartyStore.state.roster.find((member) => member.id === id);
  if (player?.colorOverride) {
    ghost.ballEffect = undefined;
    color.setHSL(player.hue / 360, 0.75, 0.62);
    return;
  }
  if (player?.ball) {
    ghost.ballEffect =
      animatedCount < animatedBudget ? bpBallRegistry.get(player.ball.key)?.effect : undefined;
    color.set(player.ball.color);
    return;
  }
  if (ghost.ballColor) {
    color.set(ghost.ballColor);
    return;
  }
  color.setHSL((player?.hue ?? ghost.hue) / 360, 0.75, 0.62);
}
