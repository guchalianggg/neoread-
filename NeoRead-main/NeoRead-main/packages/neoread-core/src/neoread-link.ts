/** `neoread://open?id=<document>[&annotation=<id>][&page=<n>]` opens a place in the library. */
export const NEOREAD_SCHEME = "neoread";
export const LINK_SCHEMES = [NEOREAD_SCHEME];

export interface NeoReadLinkTarget {
  id: string;
  annotation?: string;
  page?: number;
}

const hash = /^[0-9a-f]{32}$/;

export function neoreadLink(target: NeoReadLinkTarget) {
  const query = new URLSearchParams({ id: target.id });
  if (target.annotation) query.set("annotation", target.annotation);
  if (target.page) query.set("page", String(target.page));
  return `${NEOREAD_SCHEME}://open?${query}`;
}

/** Only the open action with known, well-formed parameters is accepted. */
export function parseNeoReadLink(link: string): NeoReadLinkTarget | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const action = url.hostname || url.pathname.replace(/^\/+/, "");
  const scheme = url.protocol.slice(0, -1);
  if (!LINK_SCHEMES.includes(scheme) || action !== "open") return null;
  const id = url.searchParams.get("id") || "";
  if (!hash.test(id)) return null;
  const target: NeoReadLinkTarget = { id };
  const annotation = url.searchParams.get("annotation");
  if (annotation && hash.test(annotation)) target.annotation = annotation;
  const page = Number(url.searchParams.get("page"));
  if (Number.isInteger(page) && page > 0 && page < 100000) target.page = page;
  return target;
}
