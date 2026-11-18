/**
 * The service version, in one place.
 *
 * It is read from `package.json` rather than duplicated in a constant, because a
 * version that exists in two places eventually disagrees with itself. The
 * manifest is part of the image already, so nothing extra is loaded.
 *
 * This is the version of **this project**, not of the wire protocol or of room
 * checkpoints, both of which are versioned separately and for different reasons:
 * the protocol tells a client whether it can speak to this server at all, and the
 * checkpoint tells the store whether it can read what a previous build wrote. A
 * service version says only which release is running.
 */

import packageManifest from '../package.json';

export const VERSION: string = packageManifest.version;
