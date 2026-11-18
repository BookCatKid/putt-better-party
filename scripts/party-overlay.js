/**
 * Keep the game inert while a blocking overlay is in front of it.
 *
 * The game engine mounts its input listeners on `window`, not on the canvas, so
 * covering the scene with an overlay does not stop the engine hearing the
 * keyboard. While an overlay is up a stray keypress still reaches the in-flight
 * round, and the scene underneath stays in the tab order, so a keyboard user tabs
 * into a game they cannot see or operate.
 *
 * There are two such overlays and they are unrelated code: the loading screen this
 * route renders, and the lobby dashboard the pinned game bundle renders. They also
 * sit in different places - the loading screen is a sibling of the scene, the
 * lobby is nested deep inside it - so neither "inert the scene" nor "inert the
 * overlay's siblings" is right on its own. Instead, an overlay marks itself with
 * `data-bp-blocking-overlay` and everything outside its own ancestor chain is
 * made inert. That covers both shapes, and a third overlay only has to mark
 * itself.
 *
 * `inert` fixes the tab order and pointer hits but cannot stop events that target
 * `document.body` and bubble to `window`, which is exactly how the engine hears
 * them. So this does both: `inert` for the DOM's own behaviour, plus a
 * capture-phase guard on `window` that swallows the scene's input events before
 * the engine's own window listeners see them.
 *
 * Everything here is reversible: when the overlay goes away the elements it
 * covered are focusable again, the listeners are removed, and focus returns to
 * where the player left it.
 *
 * This lives beside the route rather than inside the pinned engine, because the
 * engine is an archived, hash-pinned bundle.
 */

/** Attribute an overlay sets on itself to be treated as blocking. */
const PARTY_BLOCKING_OVERLAY_SELECTOR = '[data-bp-blocking-overlay]';

/**
 * The input events the engine listens for above the scene.
 *
 * Taken from the pinned bundles: `keydown`/`keyup` drive the camera and the
 * keyboard shortcuts, the pointer events drive aiming and charging a shot, and
 * `wheel` zooms. `contextmenu` is included because the engine suppresses it.
 */
const PARTY_SCENE_INPUT_EVENTS = [
  'keydown',
  'keyup',
  'keypress',
  'pointerdown',
  'pointerup',
  'pointermove',
  'wheel',
  'touchstart',
  'touchmove',
  'contextmenu',
];

/**
 * The one kind of element inside an overlay that keeps its own input.
 *
 * A player has to be able to type their name, edit a number, drag the holes
 * slider, and use every key a text field understands. The engine already
 * declines keys aimed at these controls, so letting them through cannot restart
 * the round, and stopping their events would break them outright - a
 * `stopPropagation` in the capture phase keeps the event from ever reaching the
 * control that needs it.
 *
 * Buttons and links are deliberately *not* on this list. The engine does not
 * skip them, which is how a focused "Leave party" link let `r`, `c` and the arrow
 * keys reach the round. They do not need their events to reach them either:
 * stopping propagation leaves default actions alone, so Enter and Space still
 * activate a focused control and Tab still moves focus.
 */
const PARTY_OWN_INPUT = 'input, textarea, select, [contenteditable="true"]';

/**
 * Every element outside `overlay`'s ancestor chain, up to the document body.
 *
 * Walking up and collecting siblings at each level is what makes this work for an
 * overlay nested inside the scene as well as one beside it: it never includes an
 * ancestor of the overlay, so the overlay and its own controlled subtree are the
 * one part left live.
 */
function partyElementsAround(overlay) {
  const covered = [];
  let node = overlay;
  while (node && node.parentElement) {
    for (const sibling of node.parentElement.children) {
      if (sibling !== node) {
        covered.push(sibling);
      }
    }
    node = node.parentElement;
  }
  return covered;
}

/**
 * The blocking overlay that is actually in front, if any.
 *
 * Two overlays can be mounted at once - the lobby is rendered inside the scene
 * while the loading screen covers it - so the answer is the last one in document
 * order, which is the one painted last. Anything hidden is ignored, so a stale
 * overlay kept in the tree for a transition cannot win.
 */
function partyBlockingOverlay() {
  const candidates = [...document.querySelectorAll(PARTY_BLOCKING_OVERLAY_SELECTOR)];
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index];
    if (typeof candidate.checkVisibility === 'function' ? candidate.checkVisibility() : true) {
      return candidate;
    }
  }
  return null;
}

/**
 * Block the scene while any blocking overlay is showing, and restore it after.
 *
 * @param {{ current: HTMLElement | null }} sceneRef The game container.
 */
function usePartyOverlayGuard(sceneRef) {
  const React = partyRouteReact;

  React.useEffect(() => {
    // Focus is only worth restoring if the player was in this document to begin
    // with; on a fresh load there is nothing to go back to.
    let restoreTo = null;
    let release = null;
    let blockedFor = null;

    /*
     * The elements this guard has made inert, each with the `aria-hidden` it had
     * beforehand, so releasing restores what was there rather than assuming it
     * had none.
     */
    const coveredNow = new Map();

    /**
     * Make exactly `next` inert and everything else live again.
     *
     * This runs on every mutation rather than once, because an overlay can arm
     * before the page it covers has finished mounting: on a rejoin the loading
     * screen is up while the scene and its lobby are still arriving, so what is
     * covered grows after the guard has already started. Applying the difference
     * keeps that correct without tearing the guard down and losing the player's
     * focus position.
     */
    const cover = (next) => {
      const wanted = new Set(next);
      for (const [element, previousHidden] of coveredNow) {
        if (wanted.has(element)) {
          continue;
        }
        element.removeAttribute('inert');
        if (previousHidden === null) {
          element.removeAttribute('aria-hidden');
        } else {
          element.setAttribute('aria-hidden', previousHidden);
        }
        coveredNow.delete(element);
      }
      for (const element of wanted) {
        if (coveredNow.has(element)) {
          continue;
        }
        coveredNow.set(element, element.getAttribute('aria-hidden'));
        element.setAttribute('inert', '');
        // `inert` is honoured by every current browser, but `aria-hidden` is what
        // makes assistive technology ignore the scene in one that lacks it.
        element.setAttribute('aria-hidden', 'true');
      }
    };

    const apply = () => {
      // The overlay can be replaced without the page ever becoming unblocked: the
      // lobby is already behind the loading screen and takes over when it goes.
      if (release && blockedFor !== partyBlockingOverlay()) {
        release();
      }
      const overlay = partyBlockingOverlay();
      if (!overlay) {
        cover([]);
        return;
      }
      if (release) {
        // Same overlay, but the page underneath it may have changed since.
        cover(partyElementsAround(overlay));
        return;
      }
      restoreTo = document.activeElement;
      blockedFor = overlay;
      cover(partyElementsAround(overlay));

      /*
       * Swallow the engine's input at the window's capture phase, where this runs
       * before any of the engine's own window listeners.
       *
       * Only a control that genuinely needs its own key and pointer events is
       * exempt. Everything else - the scene behind the overlay, the overlay
       * container that is focused so its status is announced, and every button
       * and link inside it - is hidden from the engine. Default actions are left
       * alone on purpose: cancelling them would also cancel Tab's focus move and
       * the activation of a focused button. The one exception is the context
       * menu, which would otherwise open browser chrome over a screen that is
       * meant to be the only thing on it.
       */
      const guard = (event) => {
        const target = event.target;
        const inside = target instanceof Node && overlay.contains(target);
        const own = target instanceof Element && target.closest(PARTY_OWN_INPUT) instanceof Element;
        if (inside && own) {
          return;
        }
        event.stopPropagation();
        if (event.type === 'contextmenu') {
          event.preventDefault();
        }
      };
      for (const type of PARTY_SCENE_INPUT_EVENTS) {
        window.addEventListener(type, guard, true);
      }

      // Move the player into the overlay so the message is announced and the next
      // Tab stays inside the blocking UI instead of landing on the scene.
      if (!overlay.contains(document.activeElement)) {
        if (!overlay.hasAttribute('tabindex')) {
          overlay.setAttribute('tabindex', '-1');
        }
        overlay.focus({ preventScroll: true });
      }

      release = () => {
        for (const type of PARTY_SCENE_INPUT_EVENTS) {
          window.removeEventListener(type, guard, true);
        }
        cover([]);
        /*
         * Restoring focus matters most on the rejoin path, where the player never
         * left this page: they come back to the control they pressed. If that
         * control has unmounted - the Join button usually has - the scene is
         * tidier than the document body, because Tab then starts from the game
         * rather than from the top of an otherwise empty page.
         */
        const previous = restoreTo;
        const scene = sceneRef.current;
        if (
          previous instanceof HTMLElement &&
          previous.isConnected &&
          !previous.closest('[inert]')
        ) {
          previous.focus({ preventScroll: true });
        } else if (scene instanceof HTMLElement && scene.isConnected) {
          scene.focus({ preventScroll: true });
        }
        restoreTo = null;
        blockedFor = null;
        release = null;
      };
    };

    apply();
    // Overlays mount and unmount without this route re-rendering, so watch the
    // document rather than thread every overlay's state through here. Only the
    // marker and the element list are watched: `class` changes sixty times a
    // second during play, and re-running this on each of them would be a cost for
    // no benefit when the marker is what declares an overlay blocking.
    let scheduled = 0;
    const observer = new MutationObserver(() => {
      if (scheduled) {
        return;
      }
      scheduled = requestAnimationFrame(() => {
        scheduled = 0;
        apply();
      });
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-bp-blocking-overlay'],
    });
    return () => {
      observer.disconnect();
      if (scheduled) {
        cancelAnimationFrame(scheduled);
      }
      if (release) {
        release();
      }
    };
  }, []);
}
