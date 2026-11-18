import { waitFor } from './cdp.mjs';

/**
 * Open and close the playlist editor.
 *
 * The community catalog lives inside a modal `<dialog>` and is only mounted and
 * fetched while that dialog is open. A suite that wants catalog cards therefore
 * has to open the editor first; waiting for `.bp-catalog-scroll` on its own waits
 * forever.
 *
 * Scoping every query to `.bp-playlist-dialog` keeps these helpers from matching
 * an unrelated button elsewhere in the lobby, which has its own "Done"-shaped
 * controls.
 */
const editorButton = (label) =>
  `(()=>{const dialog=document.querySelector(".bp-playlist-dialog");` +
  `if(!dialog)return null;` +
  `return [...dialog.querySelectorAll("button")].find(b=>b.textContent===${JSON.stringify(label)})||null})()`;

export async function openPlaylistEditor(client) {
  await waitFor(
    client,
    '[...document.querySelectorAll("button")].some(b=>b.textContent==="Edit playlist"&&!b.disabled)',
  );
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.textContent==="Edit playlist").click()',
  );
  await waitFor(client, 'document.querySelector(".bp-playlist-dialog")?.open===true');
}

export async function closePlaylistEditor(client) {
  // A modal dialog puts the lobby behind its backdrop in the top layer, so the
  // party cannot be started until the editor is dismissed.
  await waitFor(client, '!!' + editorButton('Done'));
  await client.evalJS(editorButton('Done') + '.click()');
  await waitFor(client, 'document.querySelector(".bp-playlist-dialog")?.open!==true');
}
