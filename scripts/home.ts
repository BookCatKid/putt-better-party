/**
 * The home page's create/join controls.
 *
 * A standalone script, not a snippet spliced into the pinned client, so it can be
 * ordinary strict TypeScript. Every element is looked up through `required`, which
 * fails loudly at load if the markup and the script have drifted apart - the
 * alternative is a handler that silently never binds, which looks exactly like a
 * page that is simply not responding.
 *
 * That same reasoning is why storage access is wrapped: `sessionStorage` throws
 * when a browser blocks site storage (Safari private mode, a disabled store, a full
 * quota), and an unguarded `getItem` at module scope would abort this whole file
 * before a single handler was attached - a dead page with no explanation.
 */

/** The server's reply to `POST /api/create`. */
interface CreatedParty {
  code: string;
  hostToken: string;
}

/** The server's reply to `GET /api/room/<code>`. */
interface ExistingParty {
  code: string;
  phase: string;
  locked: boolean;
  players: number;
}

/** An error body the server returns alongside a non-2xx status. */
interface ApiError {
  error?: string;
}

/**
 * The party-code alphabet, which must agree with `ROOM_CODE` in
 * `src/request-guards.ts`. A mismatch is user-visible in the worst way: a valid
 * code rejected before it is ever sent, with no way to tell that apart from a
 * typo. `tests/home-admission.test.js` asserts the two stay equal.
 */
const PARTY_CODE = /^[A-Z2-9]{5}$/;

/**
 * How long an admission request may take before it is abandoned.
 *
 * Without a bound a stalled connection leaves the page permanently mid-submit with
 * both buttons disabled and nothing to click, which is indistinguishable from a
 * frozen tab. The party socket uses the same budget.
 */
const REQUEST_TIMEOUT_MS = 15_000;

const LAST_ROOM_KEY = 'bp.lastRoom';

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`The home page is missing its #${id} element.`);
  }
  return element as T;
}

const createButton = required<HTMLButtonElement>('create');
const joinForm = required<HTMLFormElement>('join');
const codeInput = required<HTMLInputElement>('code');
const resumeButton = required<HTMLButtonElement>('resume');
const errorMessage = required<HTMLParagraphElement>('error');
const joinSubmit = joinForm.querySelector('button');
if (!joinSubmit) {
  throw new Error('The home page join form is missing its submit button.');
}
// Bound to a separate const so the non-null type survives into the closures below;
// TypeScript will not narrow a captured binding across a function boundary.
const joinButton = joinSubmit;

/** Server errors are not `Error` instances, so the message needs extracting. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    // A timeout is a DOMException named `TimeoutError` with an unhelpful message.
    if (error.name === 'TimeoutError') {
      return 'The server did not respond. Please try again.';
    }
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}

/** Read a JSON body, or `null` when the response is not JSON at all. */
async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** Storage reads never throw; a blocked store simply has nothing to remember. */
function readStored(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Storage writes report whether they stuck, so the caller can explain a failure. */
function writeStored(key: string, value: string): boolean {
  try {
    sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeStored(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Nothing to do: the point of removing is that the value is not wanted, and a
    // store that cannot be written to cannot be read from either.
  }
}

/** True when this browser will let us keep a party code and host key at all. */
function storageWorks(): boolean {
  const probe = 'bp.probe';
  if (!writeStored(probe, '1')) {
    return false;
  }
  removeStored(probe);
  return true;
}

/**
 * One admission at a time.
 *
 * Create and join both end in a `location.href` assignment, so two in flight means
 * whichever resolves last wins the navigation - and a create that loses still
 * leaves a `bp.host.<code>` entry for a party the player never entered. A single
 * flag plus disabling both controls makes the second submit a no-op instead.
 */
let admissionInFlight = false;

function beginAdmission(): boolean {
  if (admissionInFlight) {
    return false;
  }
  admissionInFlight = true;
  createButton.disabled = true;
  joinButton.disabled = true;
  errorMessage.textContent = '';
  return true;
}

/** Release the guard. Never called on success, because success navigates away. */
function endAdmission(): void {
  admissionInFlight = false;
  createButton.disabled = false;
  joinButton.disabled = false;
}

async function createParty(): Promise<void> {
  // Checked before the request, not after: a party created by someone who cannot
  // store the host key would be a room with no host, and it would sit until the
  // idle sweep reclaimed it. Refusing up front is the honest outcome.
  if (!storageWorks()) {
    errorMessage.textContent =
      'This browser is blocking site storage, so a party cannot be created here. ' +
      'Allow storage for this site, or open it in a normal window.';
    // Releasing the guard is part of the refusal: a message the player cannot act
    // on, with both controls disabled, is the stuck page this whole guard exists to
    // avoid.
    endAdmission();
    return;
  }
  try {
    const response = await fetch('/api/create', {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const party = await readJson<CreatedParty & ApiError>(response);
    if (!response.ok || !party || typeof party.code !== 'string') {
      throw new Error(party?.error ?? 'Could not create a party.');
    }
    // The host capability is per-party, and is what authorises privileged calls
    // such as importing a course. It is kept in session storage so it dies with
    // the tab rather than persisting on a shared machine.
    writeStored('bp.host.' + party.code, party.hostToken);
    writeStored(LAST_ROOM_KEY, party.code);
    location.href = '/party/' + party.code;
  } catch (error) {
    errorMessage.textContent = describe(error);
    endAdmission();
  }
}

async function joinParty(inputCode: string): Promise<void> {
  const code = inputCode.trim().toUpperCase();
  if (!PARTY_CODE.test(code)) {
    errorMessage.textContent = 'Enter a valid five-character code.';
    // Reachable from the resume chip, which takes the guard before calling in.
    endAdmission();
    return;
  }
  try {
    const response = await fetch('/api/room/' + code, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const party = await readJson<ExistingParty & ApiError>(response);
    if (!response.ok || !party) {
      throw new Error(party?.error ?? 'That party does not exist.');
    }
    writeStored(LAST_ROOM_KEY, code);
    location.href = '/party/' + code;
  } catch (error) {
    errorMessage.textContent = describe(error);
    endAdmission();
  }
}

createButton.onclick = () => {
  if (!beginAdmission()) {
    return;
  }
  void createParty();
};

joinForm.onsubmit = (event) => {
  event.preventDefault();
  // Validate before taking the guard, so a typo does not consume the one attempt
  // and leave the controls disabled.
  const code = codeInput.value.trim().toUpperCase();
  if (!PARTY_CODE.test(code)) {
    errorMessage.textContent = 'Enter a valid five-character code.';
    return;
  }
  if (!beginAdmission()) {
    return;
  }
  void joinParty(code);
};

// Offer a way back to the last party this tab joined, but only if it still exists
// - a stale link to a finished party is worse than no link at all.
const recent = readStored(LAST_ROOM_KEY);
if (recent && PARTY_CODE.test(recent)) {
  fetch('/api/room/' + recent, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    .then((response) => {
      if (response.ok) {
        resumeButton.hidden = false;
        resumeButton.textContent = 'Return to ' + recent;
        resumeButton.onclick = () => {
          if (!beginAdmission()) {
            return;
          }
          void joinParty(recent);
        };
        return;
      }
      // A 404 is the server saying the party is gone, so the remembered code is
      // obsolete and is forgotten rather than probed again on every visit. Any
      // other status (or a network failure) may be temporary, so it is hidden but
      // kept.
      if (response.status === 404) {
        removeStored(LAST_ROOM_KEY);
      }
    })
    .catch(() => {
      // A failed probe just means no resume chip is shown.
    });
}

export {};
