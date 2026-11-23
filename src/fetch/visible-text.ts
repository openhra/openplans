import { createHash } from "node:crypto";

/**
 * Hash of the visible text of an HTML page, for terms pages whose bytes change on every request
 * (timestamps, cache-busters, random widget ids) while the legal wording stays the same.
 *
 * The text is what a reader sees: comments, doctype, `script`, `style`, `template` and `noscript`
 * elements are dropped, every other tag becomes a space, character references are decoded, query
 * strings and fragments are cut from URLs that appear in the text, and whitespace collapses to
 * single spaces. A changed word, number or sentence changes the hash. The default for a terms pin
 * stays the hash of the raw bytes; a host opts in with `terms.hashMode: "visible-text"`.
 *
 * `ops/research-fetch/visible_text.py` mirrors this function; the shared fixture in
 * `tests/fixtures/visible-text/` pins both to one digest.
 */
export const termsHashModes = ["raw", "visible-text"] as const;
export type TermsHashMode = (typeof termsHashModes)[number];

const namedEntities: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  bull: "•",
  middot: "·",
  sect: "§",
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z]{2,8}));/g,
    (whole, hex?: string, dec?: string, name?: string) => {
      if (name !== undefined) return namedEntities[name] ?? whole;
      const code = hex !== undefined ? parseInt(hex, 16) : parseInt(dec!, 10);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code)
        : " ";
    },
  );
}

/** The normalised visible text of an HTML document. */
export function visibleText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, " ")
    .replace(/<![^>]*>/g, " ")
    .replace(/<\?[^>]*>/g, " ");
  for (const element of ["script", "style", "template", "noscript"])
    text = text.replace(
      new RegExp(
        `<${element}(?=[\\s/>])[^>]*>[\\s\\S]*?(?:</${element}\\s*>|$)`,
        "gi",
      ),
      " ",
    );
  text = text.replace(/<\/?[A-Za-z][^>]*>/g, " ");
  text = decodeEntities(text);
  text = text.replace(/https?:\/\/[^\s<>"')\]]+/gi, (url) =>
    url.replace(/[?#].*$/, ""),
  );
  return text.replace(/\s+/g, " ").trim();
}

export function visibleTextSha256(html: string | Uint8Array): string {
  const source =
    typeof html === "string" ? html : Buffer.from(html).toString("utf8");
  return createHash("sha256").update(visibleText(source), "utf8").digest("hex");
}
