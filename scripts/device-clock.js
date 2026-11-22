// Inserted into the archived GameCanvas module. The aliases resolve to the
// original useFrame/useThree bindings and the shared scene object.
//
// Clock-driven course devices (spinner, slider, pendulum, piston) animate from
// the renderer clock, whose phase when a round starts is arbitrary. Publishing it
// on the scene lets the replay recorder store that phase, so a replay places the
// devices where the match actually had them.
function BpDeviceClock() {
  const clock = followUseThree((state) => state.clock);
  followUseFrame(() => {
    followScene.deviceClockMs = clock.elapsedTime * 1000;
  }, -1000);
  return null;
}
