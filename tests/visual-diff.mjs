#!/usr/bin/env bun
/*
 * Pixel-diff the visual baselines against a fresh capture.
 *
 * Usage:
 *   bun tests/visual-diff.mjs <baseline-dir> <fresh-dir> [threshold%]
 *
 * Every .png in the baseline directory is compared with the same-named file in
 * the fresh directory. Per screen the tool prints the share of pixels whose
 * RGBA channels moved by more than a small noise margin, and writes a
 * `<name>-diff.png` heatmap next to the fresh captures (differing pixels in
 * red over a desaturated copy of the fresh shot) so an intentional change is
 * easy to eyeball rather than guess at.
 *
 * Exit status is 1 when any screen exceeds the threshold, a baseline is
 * missing from the fresh capture, or a fresh capture has no baseline. The
 * default threshold is deliberately small: captures on one machine from one
 * build are deterministic, so a nonzero diff is a real visual change, not
 * noise. Re-baseline after intentional changes; never diff across machines —
 * font rasterisation differs between platforms.
 *
 * Self-contained PNG codec: Chromium screenshots are always 8-bit RGBA,
 * non-interlaced; the tool refuses anything else loudly rather than diffing a
 * misread image.
 */
import { inflateSync, deflateSync } from 'node:zlib';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNEL_NOISE = 12; // ignore sub-pixel AA jitter under this channel delta
const DEFAULT_THRESHOLD_PERCENT = 0.05;

function readChunks(bytes) {
  for (let index = 0; index < 8; index++) {
    if (bytes[index] !== PNG_SIGNATURE[index]) {
      throw Error('not a PNG file');
    }
  }
  const chunks = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    chunks.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  return chunks;
}

function decodePng(bytes) {
  const chunks = readChunks(bytes);
  const ihdr = chunks.find((chunk) => chunk.type === 'IHDR');
  const idat = Buffer.concat(
    chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data),
  );
  if (!ihdr || idat.length === 0) {
    throw Error('PNG is missing IHDR or IDAT');
  }
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  // Chromium emits truecolor RGB (type 2); RGBA (type 6) is accepted too and
  // everything is normalised to RGBA so the differ works in four channels.
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw Error(
      `unsupported PNG layout (bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}); expected 8-bit non-interlaced RGB or RGBA`,
    );
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(idat);
  const decoded = Buffer.alloc(height * stride);
  // PNG's Paeth predictor picks whichever of left/up/up-left the straight
  // estimate comes closest to; kept as a named helper for clarity.
  const paethPredictor = (left, up, upLeft) => {
    const estimate = left + up - upLeft;
    const leftDistance = Math.abs(estimate - left);
    const upDistance = Math.abs(estimate - up);
    const upLeftDistance = Math.abs(estimate - upLeft);
    if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
      return left;
    }
    return upDistance <= upLeftDistance ? up : upLeft;
  };
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)];
    const source = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    const target = decoded.subarray(row * stride, (row + 1) * stride);
    const above = row > 0 ? decoded.subarray((row - 1) * stride, row * stride) : null;
    for (let byte = 0; byte < stride; byte++) {
      const left = byte >= bpp ? target[byte - bpp] : 0;
      const up = above ? above[byte] : 0;
      const upLeft = above && byte >= bpp ? above[byte - bpp] : 0;
      switch (filter) {
        case 0:
          target[byte] = source[byte];
          break;
        case 1:
          target[byte] = (source[byte] + left) & 0xff;
          break;
        case 2:
          target[byte] = (source[byte] + up) & 0xff;
          break;
        case 3:
          target[byte] = (source[byte] + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          target[byte] = (source[byte] + paethPredictor(left, up, upLeft)) & 0xff;
          break;
        default:
          throw Error(`unsupported PNG filter ${filter}`);
      }
    }
  }
  // Normalise to RGBA: RGB sources get a fully opaque alpha channel.
  const pixels = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    pixels[pixel * 4] = decoded[pixel * bpp];
    pixels[pixel * 4 + 1] = decoded[pixel * bpp + 1];
    pixels[pixel * 4 + 2] = decoded[pixel * bpp + 2];
    pixels[pixel * 4 + 3] = bpp === 4 ? decoded[pixel * 4 + 3] : 255;
  }
  return { width, height, pixels };
}

const crcTable = Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'latin1');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}
function encodePng(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let row = 0; row < height; row++) {
    raw[row * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function diffImages(baseline, fresh) {
  if (baseline.width !== fresh.width || baseline.height !== fresh.height) {
    return {
      mismatch: `size ${baseline.width}x${baseline.height} vs ${fresh.width}x${fresh.height}`,
    };
  }
  const total = baseline.width * baseline.height;
  const heat = Buffer.alloc(fresh.pixels.length);
  let changed = 0;
  for (let pixel = 0; pixel < total; pixel++) {
    const at = pixel * 4;
    const delta = Math.max(
      Math.abs(baseline.pixels[at] - fresh.pixels[at]),
      Math.abs(baseline.pixels[at + 1] - fresh.pixels[at + 1]),
      Math.abs(baseline.pixels[at + 2] - fresh.pixels[at + 2]),
      Math.abs(baseline.pixels[at + 3] - fresh.pixels[at + 3]),
    );
    if (delta > CHANNEL_NOISE) {
      changed++;
      heat[at] = 255;
      heat[at + 1] = 32;
      heat[at + 2] = 32;
      heat[at + 3] = 255;
    } else {
      // Desaturated copy of the fresh pixel so changed regions stand out.
      const gray = Math.round(
        fresh.pixels[at] * 0.3 + fresh.pixels[at + 1] * 0.59 + fresh.pixels[at + 2] * 0.11,
      );
      heat[at] = gray;
      heat[at + 1] = gray;
      heat[at + 2] = gray;
      heat[at + 3] = 255;
    }
  }
  return { changed, percent: (changed / total) * 100, heat };
}

const [baselineDir, freshDir, thresholdArg] = process.argv.slice(2);
if (!baselineDir || !freshDir) {
  console.error('usage: bun tests/visual-diff.mjs <baseline-dir> <fresh-dir> [threshold%]');
  process.exit(2);
}
const threshold = thresholdArg === undefined ? DEFAULT_THRESHOLD_PERCENT : Number(thresholdArg);
const baselines = readdirSync(baselineDir)
  .filter((name) => name.endsWith('.png'))
  .sort();
if (baselines.length === 0) {
  console.error('no baseline captures found in ' + baselineDir);
  process.exit(2);
}

let failed = false;
const rows = [];
for (const name of baselines) {
  const freshPath = join(freshDir, name);
  if (!existsSync(freshPath)) {
    rows.push([name, 'MISSING', '', '']);
    failed = true;
    continue;
  }
  try {
    const baseline = decodePng(readFileSync(join(baselineDir, name)));
    const fresh = decodePng(readFileSync(freshPath));
    const result = diffImages(baseline, fresh);
    if (result.mismatch) {
      rows.push([name, 'SIZE', result.mismatch, '']);
      failed = true;
      continue;
    }
    const percent = result.percent;
    const verdict = percent > threshold ? 'DIFF' : 'ok';
    if (percent > threshold) {
      failed = true;
      writeFileSync(
        join(freshDir, name.replace(/\.png$/, '-diff.png')),
        encodePng(fresh.width, fresh.height, result.heat),
      );
    }
    rows.push([name, verdict, percent.toFixed(3) + '%', result.changed + ' px']);
  } catch (error) {
    rows.push([name, 'ERROR', '', error.message]);
    failed = true;
  }
}
for (const capture of readdirSync(freshDir).filter(
  (file) => file.endsWith('.png') && !file.endsWith('-diff.png'),
)) {
  if (!baselines.includes(capture)) {
    rows.push([capture, 'EXTRA', '', 'no baseline']);
    failed = true;
  }
}
const width = Math.max(...rows.map((row) => row[0].length));
for (const [name, verdict, percent, note] of rows) {
  console.log(name.padEnd(width) + '  ' + verdict.padEnd(7) + percent.padEnd(9) + note);
}
console.log(
  failed ? 'visual-diff: changed beyond threshold or incomplete' : 'visual-diff: all screens match',
);
process.exit(failed ? 1 : 0);
