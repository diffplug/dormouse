/** Which canvas color space shows an image's raw values as its color
 * metadata means them: Display P3, or sRGB, which also stands in for a space
 * no canvas offers (an approximation: the saved pixels and profile stay
 * exact). No DOM, so Node tests load it. */
import { ascii } from '../../src/image-format';

/** Display P3's primaries as an ICC profile's colorant tags hold them
 * (D50-adapted XYZ, red, green, then blue), for profiles whose description
 * does not name it. */
const P3_COLORANTS = [0.5151, 0.2412, -0.0011, 0.2919, 0.6922, 0.0419, 0.1572, 0.0666, 0.7841];

/** A PNG `cICP` chunk's space: its colour primaries code (ITU-T H.273) is 12 for Display P3. */
export const cicpSpace = (data: Uint8Array): PredefinedColorSpace => data[0] === 12 ? 'display-p3' : 'srgb';

/** An ICC profile's space, by its description and else by its primaries. */
export function iccSpace(profile: Uint8Array): PredefinedColorSpace {
  const view = new DataView(profile.buffer, profile.byteOffset, profile.byteLength);
  if (profile.length < 132 || ascii(profile, 36, 40) !== 'acsp') return 'srgb';
  const tags = new Map<string, Uint8Array>();
  const count = view.getUint32(128);
  for (let i = 0, at = 132; i < count && at + 12 <= profile.length; i++, at += 12) {
    const offset = view.getUint32(at + 4), size = view.getUint32(at + 8);
    if (offset + size <= profile.length) tags.set(ascii(profile, at, at + 4), profile.subarray(offset, offset + size));
  }
  if (/display p3/i.test(description(tags.get('desc')))) return 'display-p3';
  const xyz = ['rXYZ', 'gXYZ', 'bXYZ'].flatMap(sig => {
    const tag = tags.get(sig);
    if (!tag || tag.length < 20) return [];
    const v = new DataView(tag.buffer, tag.byteOffset, tag.byteLength);
    return [8, 12, 16].map(at => v.getInt32(at) / 65536);
  });
  return xyz.length === 9 && P3_COLORANTS.every((c, i) => Math.abs(c - xyz[i]) < 0.02) ? 'display-p3' : 'srgb';
}

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
