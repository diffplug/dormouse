/**
 * Turning the Host's on-screen QR into something a fake camera can play, and
 * proving it still decodes (`scripts/pairing-walkthrough/README.md`).
 *
 * `ffmpeg` does every pixel operation — crop, scale, pad, Y4M — so the harness
 * needs no image dependency of its own. The decode borrows `@zxing/library`
 * out of `lib/`'s own `node_modules`: it is the decoder Pocket's scanner uses
 * (`lib/src/remote/pocket-app/ScanInvitation.tsx`), so a code this passes is a
 * code that scanner can read.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';

import { exec } from './proc.mjs';

const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
/** Overwrite, and say nothing unless something went wrong. */
const QUIET = ['-y', '-hide_banner', '-loglevel', 'error'];

/** The frame a phone's front camera hands `getUserMedia`. */
const CAMERA = { width: 640, height: 480, seconds: 2, fps: 5 };

/** Round up to an even number: yuv420p subsamples, so odd dimensions are refused. */
function even(n) {
  const rounded = Math.max(2, Math.round(n));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

/**
 * `{ width, height }` of an image, read back from ffmpeg rather than assumed.
 *
 * One full decode per call, so `crop` and `decodeQr` take a `size` a caller
 * already holds rather than re-deriving it.
 */
export async function imageSize(path) {
  // `-f null -` decodes without writing anything; the size lands on stderr.
  const { stderr } = await exec(FFMPEG, ['-hide_banner', '-i', path, '-f', 'null', '-'], {})
    .catch((err) => ({ stderr: err.message }));
  const match = /,\s(\d+)x(\d+)[\s,]/.exec(stderr);
  if (!match) throw new Error(`could not read the size of ${path}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * Crop `rect` (device pixels) out of `source` into `out`, with `padding` px of
 * margin on every side, clamped to the image.
 */
export async function crop(source, out, rect, { padding, size } = {}) {
  const { width, height } = size ?? (await imageSize(source));
  const x = Math.max(0, Math.floor(rect.x - padding));
  const y = Math.max(0, Math.floor(rect.y - padding));
  const w = Math.min(width - x, Math.ceil(rect.width + padding * 2));
  const h = Math.min(height - y, Math.ceil(rect.height + padding * 2));
  if (w <= 0 || h <= 0) throw new Error(`crop rect ${JSON.stringify(rect)} is outside ${source}`);
  await exec(FFMPEG, [...QUIET, '-i', source, '-vf', `crop=${w}:${h}:${x}:${y}`, out]);
  return { x, y, width: w, height: h };
}

/**
 * A looping single-frame Y4M of `source`, sized like a phone camera.
 *
 * Chromium's `--use-file-for-fake-video-capture` takes Y4M or MJPEG and plays
 * the file on repeat, so two seconds at 5 fps is plenty for a scanner. The code
 * is scaled with `neighbor` — a smoothing filter is exactly the blur a decoder
 * trips over — and padded onto white so the quiet zone survives the frame edge.
 */
export async function toY4m(source, out) {
  const w = even(CAMERA.width);
  const h = even(CAMERA.height);
  const side = even(Math.min(w, h) * 0.8);
  await exec(FFMPEG, [...QUIET,
    '-loop', '1', '-t', String(CAMERA.seconds), '-i', source,
    '-vf', `scale=${side}:${side}:flags=neighbor,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:white`,
    '-r', String(CAMERA.fps), '-pix_fmt', 'yuv420p', out]);
  return { ...CAMERA, width: w, height: h };
}

/**
 * A camera-shaped Y4M with nothing in it, replacing whatever `out` held.
 *
 * For the scenarios about codes that arrive by hand: a viewfinder still pointed
 * at the Host's live QR decodes it the moment the scanner mounts, which would
 * start a real ceremony underneath the one being driven. White rather than
 * black, so the screenshots show a viewfinder that is plainly looking at
 * nothing rather than one that looks broken.
 */
export async function blankY4m(out) {
  const w = even(CAMERA.width);
  const h = even(CAMERA.height);
  await exec(FFMPEG, [...QUIET,
    '-f', 'lavfi', '-i', `color=c=white:s=${w}x${h}:r=${CAMERA.fps}:d=${CAMERA.seconds}`,
    '-pix_fmt', 'yuv420p', out]);
  return { ...CAMERA, width: w, height: h };
}

/**
 * An integer nearest-neighbour enlargement of `source`.
 *
 * A laptop draws the code at 168 CSS px and a headless browser captures at
 * scale 1, which is only two or three pixels per module — near the floor for
 * any decoder. A phone camera pointed at the same screen sees far more than
 * that, so enlarging before decoding is closer to the real thing than the raw
 * crop is, not further from it. `neighbor` because smoothing the module edges
 * is the one thing that would genuinely destroy information.
 */
export async function upscale(source, out, factor = 4) {
  const { width, height } = await imageSize(source);
  await exec(FFMPEG, [...QUIET,
    '-i', source, '-vf', `scale=iw*${factor}:ih*${factor}:flags=neighbor`, out]);
  return { width: width * factor, height: height * factor };
}

/** Raw 8-bit grayscale samples of an image, straight out of ffmpeg. */
async function grayscale(path, size) {
  const { width, height } = size ?? (await imageSize(path));
  const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error',
    '-i', path, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { binary: true });
  return { width, height, data: new Uint8ClampedArray(stdout) };
}

/**
 * The text encoded in a QR image, or `null` when nothing decodes.
 *
 * `repoRoot` locates `lib/node_modules/@zxing/library`; the harness declares no
 * dependencies of its own, so the workspace's copy is the one that gets used.
 */
export async function decodeQr(path, repoRoot, size) {
  // The CJS build, not the ESM one: `esm/index.js` re-exports through directory
  // specifiers, which Node's ESM resolver refuses outright.
  const entry = join(repoRoot, 'lib', 'node_modules', '@zxing', 'library', 'cjs', 'index.js');
  const zxing = createRequire(import.meta.url)(entry);
  const { width, height, data } = await grayscale(path, size);
  const source = new zxing.RGBLuminanceSource(data, width, height);
  const bitmap = new zxing.BinaryBitmap(new zxing.HybridBinarizer(source));
  const reader = new zxing.MultiFormatReader();
  const hints = new Map([
    [zxing.DecodeHintType.POSSIBLE_FORMATS, [zxing.BarcodeFormat.QR_CODE]],
    [zxing.DecodeHintType.TRY_HARDER, true],
  ]);
  try {
    // Hints go to `decode`, not to `setHints`: `decode` re-applies its own
    // second argument, so a prior `setHints` is discarded and every 1D reader
    // gets tried — which logs a stack trace on the way to the right answer.
    return reader.decode(bitmap, hints).getText();
  } catch {
    return null;
  }
}
