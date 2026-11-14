/**
 * Scrubber: removes every known encoding of a secret value from text.
 *
 * Forms covered: raw, reversed, base64 (std + url-safe, all 3 alignments so the value is
 * caught inside a longer base64 blob), hex (any case), URL-encoded (encodeURIComponent,
 * every-byte %XX in both cases, form '+' encoding), and the JSON-escaped raw form.
 * Line breaks inserted between characters (as `base64 -b`/`xxd -p` wrap) are tolerated.
 *
 * Not covered (by design): arbitrary transforms (rot13, xor, splitting with
 * other separators, partial leaks). Allowlisting is the real control.
 */
export const REDACTED = "[REDACTED:secret]";
const MIN_FORM_LEN = 4;

function b64Inner(bytes: Buffer, offset: number, urlSafe: boolean): string {
  const padded = Buffer.concat([Buffer.alloc(offset), bytes]);
  let enc = padded.toString("base64").replace(/=+$/, "");
  if (urlSafe) enc = enc.replace(/\+/g, "-").replace(/\//g, "_");
  const n = bytes.length;
  const start = Math.ceil((8 * offset) / 6);
  const end = Math.floor((8 * (offset + n) - 6) / 6); // inclusive
  return enc.slice(start, end + 1);
}

export function encodedForms(value: string): { exact: string[]; caseless: string[] } {
  const bytes = Buffer.from(value, "utf8");
  const exact = new Set<string>();
  const caseless = new Set<string>();
  const add = (s: string) => s.length >= MIN_FORM_LEN && exact.add(s);
  add(value);
  add([...value].reverse().join(""));
  add(JSON.stringify(value).slice(1, -1));
  for (const off of [0, 1, 2]) {
    add(b64Inner(bytes, off, false));
    add(b64Inner(bytes, off, true));
  }
  add(bytes.toString("base64"));
  add(encodeURIComponent(value));
  add(encodeURIComponent(value).replace(/%20/g, "+"));
  add(escape(value));
  const pct = [...bytes].map((b) => "%" + b.toString(16).padStart(2, "0")).join("");
  caseless.add(pct);
  caseless.add(bytes.toString("hex"));
  caseless.add(Buffer.from([...value].reverse().join(""), "utf8").toString("hex"));
  return { exact: [...exact], caseless: [...caseless].filter((s) => s.length >= MIN_FORM_LEN) };
}

function esc(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");
}

/** Regex for a needle that tolerates CR/LF between characters. */
function wrapTolerant(needle: string): string {
  return [...needle].map(esc).join("[\\r\\n]*");
}

export class Scrubber {
  private exactRe: RegExp | null = null;
  private caselessRe: RegExp | null = null;
  constructor(values: string[]) {
    const exact: string[] = [];
    const caseless: string[] = [];
    for (const v of values) {
      if (!v || v.length < MIN_FORM_LEN) continue;
      const f = encodedForms(v);
      exact.push(...f.exact);
      caseless.push(...f.caseless);
    }
    const build = (list: string[], flags: string) =>
      list.length
        ? new RegExp([...new Set(list)].sort((a, b) => b.length - a.length).map(wrapTolerant).join("|"), flags)
        : null;
    this.exactRe = build(exact, "g");
    this.caselessRe = build(caseless, "gi");
  }

  /** Returns scrubbed text and how many redactions were made. */
  scrub(text: string): { text: string; redactions: number } {
    let n = 0;
    let out = text;
    // caseless (hex) first: hex of a value can contain the raw value only if the value is hex itself.
    for (const re of [this.caselessRe, this.exactRe]) {
      if (!re) continue;
      out = out.replace(re, () => {
        n++;
        return REDACTED;
      });
    }
    return { text: out, redactions: n };
  }

  contains(text: string): boolean {
    return this.scrub(text).redactions > 0;
  }
}

/** High-confidence token shapes that should never be written into memory. */
export const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];
