/** Which canvas color space shows an image's raw values as its color
 * metadata means them. No DOM, so Node tests load it. */

/** `display-p3` or `srgb`, or null for a space no canvas offers, which the
 * editor shows as sRGB (an approximation: the saved pixels and profile stay exact). */
export type SourceSpace = PredefinedColorSpace | null;

/** Primaries an ICC profile's colorant tags hold (D50-adapted XYZ, red, green,
 * then blue), for profiles whose description names neither space. */
const COLORANTS: [PredefinedColorSpace, number[]][] = [
  ['display-p3', [0.5151, 0.2412, -0.0011, 0.2919, 0.6922, 0.0419, 0.1572, 0.0666, 0.7841]],
  ['srgb', [0.4361, 0.2225, 0.0139, 0.3851, 0.7169, 0.0971, 0.1431, 0.0606, 0.7141]],
];

/** A PNG `cICP` chunk's space: its colour primaries code (ITU-T H.273), 12 for
 * Display P3 and 1 for sRGB. */
export const cicpSpace = (data: Uint8Array): SourceSpace => data[0] === 12 ? 'display-p3' : data[0] === 1 ? 'srgb' : null;

/** An ICC profile's space, by its description and else by its primaries. */
export function iccSpace(profile: Uint8Array): SourceSpace {
  const view = new DataView(profile.buffer, profile.byteOffset, profile.byteLength);
  if (profile.length < 132 || ascii(profile, 36, 40) !== 'acsp') return null;
  const tags = new Map<string, Uint8Array>();
  const count = view.getUint32(128);
  for (let i = 0, at = 132; i < count && at + 12 <= profile.length; i++, at += 12) {
    const offset = view.getUint32(at + 4), size = view.getUint32(at + 8);
    if (offset + size <= profile.length) tags.set(ascii(profile, at, at + 4), profile.subarray(offset, offset + size));
  }
  const name = description(tags.get('desc'));
  if (/display p3/i.test(name)) return 'display-p3';
  if (/\bsrgb\b/i.test(name)) return 'srgb';
  const xyz = ['rXYZ', 'gXYZ', 'bXYZ'].flatMap(sig => {
    const tag = tags.get(sig);
    if (!tag || tag.length < 20) return [];
    const v = new DataView(tag.buffer, tag.byteOffset, tag.byteLength);
    return [8, 12, 16].map(at => v.getInt32(at) / 65536);
  });
  if (xyz.length !== 9) return null;
  return COLORANTS.find(([, ref]) => ref.every((c, i) => Math.abs(c - xyz[i]) < 0.02))?.[0] ?? null;
}

const ascii = (b: Uint8Array, start: number, end: number) => String.fromCharCode(...b.subarray(start, end));

/** A `desc` tag's text: ICC v2 `textDescriptionType` or v4 `multiLocalizedUnicodeType`. */
function description(tag: Uint8Array | undefined): string {
  if (!tag || tag.length < 12) return '';
  const v = new DataView(tag.buffer, tag.byteOffset, tag.byteLength), type = ascii(tag, 0, 4);
  if (type === 'desc') return ascii(tag, 12, Math.min(tag.length, 12 + v.getUint32(8))).replace(/\0+$/, '');
  if (type !== 'mluc' || tag.length < 28) return '';
  const length = v.getUint32(20), offset = v.getUint32(24);
  let text = '';
  for (let i = offset; i + 1 < Math.min(tag.length, offset + length); i += 2) text += String.fromCharCode(v.getUint16(i));
  return text;
}
