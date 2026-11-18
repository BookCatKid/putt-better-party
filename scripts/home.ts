/**
 * The home page's create/join controls.
 *
 * A standalone script, not a snippet spliced into the pinned client, so it can be
 * ordinary strict TypeScript. Every element is looked up through `required`, which
 * fails loudly at load if the markup and the script have drifted apart - the
 * alternative is a handler that silently never binds, which looks exactly like a
 * page that is simply not responding.
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

const PARTY_CODE = /^[A-Z2-9]{5}$/;

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

/** Server errors are not `Error` instances, so the message needs extracting. */
function describe(error: unknown): string {
  if (error instanceof Error) {
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

createButton.onclick = async () => {
  createButton.disabled = true;
  errorMessage.textContent = '';
  try {
    const response = await fetch('/api/create', { method: 'POST' });
    const party = await readJson<CreatedParty & ApiError>(response);
    if (!response.ok || !party || typeof party.code !== 'string') {
      throw new Error(party?.error ?? 'Could not create a party.');
    }
    // The host capability is per-party, and is what authorises privileged calls
    // such as importing a course. It is kept in session storage so it dies with
    // the tab rather than persisting on a shared machine.
    sessionStorage.setItem('bp.host.' + party.code, party.hostToken);
    sessionStorage.setItem('bp.lastRoom', party.code);
    location.href = '/party/' + party.code;
  } catch (error) {
    errorMessage.textContent = describe(error);
    createButton.disabled = false;
  }
};

async function joinParty(inputCode: string): Promise<void> {
  errorMessage.textContent = '';
  const code = inputCode.trim().toUpperCase();
  if (!PARTY_CODE.test(code)) {
    errorMessage.textContent = 'Enter a valid five-character code.';
    return;
  }
  try {
    const response = await fetch('/api/room/' + code);
    const party = await readJson<ExistingParty & ApiError>(response);
    if (!response.ok || !party) {
      throw new Error(party?.error ?? 'That party does not exist.');
    }
    location.href = '/party/' + code;
  } catch (error) {
    errorMessage.textContent = describe(error);
  }
}

joinForm.onsubmit = (event) => {
  event.preventDefault();
  void joinParty(codeInput.value);
};

// Offer a way back to the last party this tab joined, but only if it still exists
// - a stale link to a finished party is worse than no link at all.
const recent = sessionStorage.getItem('bp.lastRoom');
if (recent && PARTY_CODE.test(recent)) {
  fetch('/api/room/' + recent)
    .then((response) => {
      if (!response.ok) {
        return;
      }
      resumeButton.hidden = false;
      resumeButton.textContent = 'Return to ' + recent;
      resumeButton.onclick = () => void joinParty(recent);
    })
    .catch(() => {
      // A failed probe just means no resume chip is shown.
    });
}

export {};
