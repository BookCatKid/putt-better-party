const createButton = document.getElementById('create');
const joinForm = document.getElementById('join');
const codeInput = document.getElementById('code');
const resumeButton = document.getElementById('resume');
const errorMessage = document.getElementById('error');
const partyCodePattern = /^[A-Z2-9]{5}$/;

createButton.onclick = async () => {
  createButton.disabled = true;
  errorMessage.textContent = '';
  try {
    const response = await fetch('/api/create', { method: 'POST' });
    const party = await response.json();
    if (!response.ok) {
      throw new Error(party.error);
    }
    sessionStorage.setItem('bp.host.' + party.code, party.hostToken);
    sessionStorage.setItem('bp.lastRoom', party.code);
    location.href = '/party/' + party.code;
  } catch (error) {
    errorMessage.textContent = error.message;
    createButton.disabled = false;
  }
};

async function joinParty(inputCode) {
  errorMessage.textContent = '';
  const code = inputCode.trim().toUpperCase();
  if (!partyCodePattern.test(code)) {
    errorMessage.textContent = 'Enter a valid five-character code.';
    return;
  }
  try {
    const response = await fetch('/api/room/' + code);
    const party = await response.json();
    if (!response.ok) {
      throw new Error(party.error);
    }
    location.href = '/party/' + code;
  } catch (error) {
    errorMessage.textContent = error.message;
  }
}

joinForm.onsubmit = (event) => {
  event.preventDefault();
  joinParty(codeInput.value);
};

const recent = sessionStorage.getItem('bp.lastRoom');
if (recent && partyCodePattern.test(recent)) {
  fetch('/api/room/' + recent)
    .then((response) => {
      if (response.ok) {
        resumeButton.hidden = false;
        resumeButton.textContent = 'Return to ' + recent;
        resumeButton.onclick = () => joinParty(recent);
      }
    })
    .catch(() => {});
}
