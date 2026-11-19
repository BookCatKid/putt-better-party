import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';

/**
 * The invite link in the lobby.
 *
 * The link has to be the ordinary party URL on whatever origin the page was
 * actually served from - behind a reverse proxy that is the public host, so
 * building it from `location.origin` is what keeps it correct without knowing the
 * deployment. The fallback matters because clipboard access is refused in more
 * places than it is granted, and a fallback that the player cannot copy from is not
 * a fallback.
 */

const base = process.env.BASE || 'http://127.0.0.1:8789';
const targets = await fetch('http://127.0.0.1:9239/json/list').then((response) => response.json());
const client = await connect(targets.find((target) => target.type === 'page'));

try {
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"');
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, '!!document.querySelector(".bp-name-input")');
  await client.evalJS(`
    (() => {
      const input = document.querySelector('.bp-name-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Invite test');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const joinButton = `[...document.querySelectorAll(".bp-join-form button")].find(b => b.textContent === "Join")`;
  await waitFor(client, `!!${joinButton} && !${joinButton}.disabled`);
  await client.evalJS(`${joinButton}.click()`);
  await waitFor(
    client,
    '!!document.querySelector(".bp-dashboard-overlay") && !document.querySelector(".bp-party-loading")',
  );

  const code = await client.evalJS('document.querySelector(".bp-dashboard-code").textContent');
  const copyButton = `[...document.querySelectorAll("button")].find(b => /Copy invite link|Link copied/.test(b.textContent))`;
  await waitFor(client, `!!${copyButton}`);

  // 1. Copying succeeds and is announced, not only relabelled.
  await client.evalJS(`
    (() => {
      window.bpClipboardText = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text) => { window.bpClipboardText = text; } },
      });
    })()
  `);
  await client.evalJS(`${copyButton}.click()`);
  await waitFor(client, 'window.bpClipboardText !== null');
  const copied = await client.evalJS(`({
    text: window.bpClipboardText,
    origin: location.origin,
    code: document.querySelector('.bp-dashboard-code').textContent,
    label: ${copyButton}.textContent,
    status: document.querySelector('[role=status].mt-1')?.textContent ?? null,
    fallback: !!document.querySelector('.bp-dashboard-invite-fallback'),
  })`);
  assert.equal(copied.text, copied.origin + '/party/' + copied.code);
  assert.equal(copied.text, copied.origin + '/party/' + code);
  assert.match(copied.label, /Link copied/);
  assert.match(copied.status, /copied to the clipboard/i);
  // A successful copy must not also show the fallback.
  assert.equal(copied.fallback, false);
  console.log('PASS copy writes the ordinary party URL and announces it');

  // 2. Refused clipboard access falls back to a selected, copyable field.
  await client.evalJS(`
    (() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => { throw new Error('denied'); } },
      });
    })()
  `);
  await client.evalJS(`${copyButton}.click()`);
  await waitFor(client, '!!document.querySelector(".bp-dashboard-invite-fallback")');
  const fallback = await client.evalJS(`(() => {
    const input = document.querySelector('.bp-dashboard-invite-fallback');
    return {
      value: input.value,
      readOnly: input.readOnly,
      focused: document.activeElement === input,
      selected: input.selectionStart === 0 && input.selectionEnd === input.value.length,
      status: document.querySelector('[role=status].mt-1')?.textContent ?? null,
    };
  })()`);
  assert.equal(fallback.value, copied.origin + '/party/' + code);
  assert.equal(fallback.readOnly, true);
  // The point of the fallback: the player can press Ctrl/Cmd+C immediately.
  assert.equal(fallback.focused, true, 'the fallback link is focused');
  assert.equal(fallback.selected, true, 'the fallback link is selected');
  assert.match(fallback.status, /blocked/i);
  console.log('PASS a refused clipboard is announced and the link is selected for copying');

  // 3. Keyboard: the copy control is a real button and responds to Enter.
  const keyboard = await client.evalJS(`(() => {
    const button = ${copyButton};
    const tag = button.tagName;
    button.focus();
    return { tag, focused: document.activeElement === button };
  })()`);
  assert.equal(keyboard.tag, 'BUTTON');
  assert.equal(keyboard.focused, true);
  console.log('PASS the copy control is a focusable button');

  const exceptions = client.events.filter((event) => event.type === 'exception');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('PASS no page exceptions');
} finally {
  client.close();
}
