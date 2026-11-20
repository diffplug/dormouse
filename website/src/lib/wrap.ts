/** `text` word-wrapped to `width` columns, as a terminal program wraps its
 *  prose; xterm.js would break mid-word. */
export function wrap(text: string, width: number): string[] {
  if (width <= 1) return [text];
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += " " + word;
    } else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out.length > 0 ? out : [""];
}
