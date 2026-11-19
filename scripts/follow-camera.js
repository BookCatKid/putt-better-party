// Inserted into the archived GameCanvas module. The aliases resolve to the
// original useFrame/useThree/React/Vector3 bindings and interpolated ghosts.
function BpFollowCamera({ targetId }) {
  const camera = followUseThree((state) => state.camera);
  const canvas = followUseThree((state) => state.gl.domElement);
  const orbit = followReact.useRef({ yaw: 0, pitch: 0.8, distance: 6 });
  const destination = followReact.useMemo(() => new FollowVector(), []);
  const look = followReact.useMemo(() => new FollowVector(), []);
  const initialized = followReact.useRef(false);

  followReact.useEffect(() => {
    initialized.current = false;
    let drag = null;
    const down = (event) => {
      if (event.button !== 0 && event.button !== 2) {
        return;
      }
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    };
    const move = (event) => {
      if (drag?.id !== event.pointerId) {
        return;
      }
      orbit.current.yaw -= (event.clientX - drag.x) * 0.006;
      orbit.current.pitch = Math.max(
        0.2,
        Math.min(1.35, orbit.current.pitch + (event.clientY - drag.y) * 0.004),
      );
      drag.x = event.clientX;
      drag.y = event.clientY;
    };
    const release = () => {
      drag = null;
    };
    const zoom = (event) => {
      event.preventDefault();
      orbit.current.distance = Math.max(
        2.4,
        Math.min(18, orbit.current.distance * Math.exp(event.deltaY * 0.001)),
      );
    };
    canvas.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('blur', release);
    canvas.addEventListener('wheel', zoom, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', release);
      canvas.removeEventListener('wheel', zoom);
    };
  }, [canvas, targetId]);

  followUseFrame((_state, delta) => {
    const ghost = liveGhost(followGhosts, targetId);
    let distance = orbit.current.distance;
    if (ghost) {
      look.set(ghost.cx, ghost.cy, ghost.cz);
    } else {
      const { min, max } = followScene.courseAabb;
      look.set((min[0] + max[0]) / 2, 0, (min[2] + max[2]) / 2);
      distance = Math.max(distance, Math.max(max[0] - min[0], max[2] - min[2]) * 1.4 + 3);
    }
    const { yaw, pitch } = orbit.current;
    destination.set(
      look.x + Math.sin(yaw) * Math.cos(pitch) * distance,
      look.y + Math.sin(pitch) * distance,
      look.z + Math.cos(yaw) * Math.cos(pitch) * distance,
    );
    if (initialized.current) {
      camera.position.lerp(destination, 1 - Math.exp(-8 * delta));
    } else {
      camera.position.copy(destination);
      initialized.current = true;
    }
    camera.lookAt(look);
    bpWatchLive(!!ghost);
  });
  followReact.useEffect(() => () => bpWatchLive(false), []);
  return null;
}
