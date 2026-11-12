import { expect, it } from "vitest";
import { parseNeoReadLink, neoreadLink } from "./neoread-link";

const id = "0123456789abcdef0123456789abcdef";
it("round-trips document, annotation and page targets", () => {
  for (const target of [
    { id },
    { id, annotation: "fedcba9876543210fedcba9876543210" },
    { id, page: 12 },
  ])
    expect(parseNeoReadLink(neoreadLink(target))).toEqual(target);
});
it("rejects links exported with the old scheme", () => {
  expect(neoreadLink({ id })).toBe(`neoread://open?id=${id}`);
  expect(parseNeoReadLink(`reader://open?id=${id}&page=3`)).toBeNull();
});
it("rejects other schemes, actions and malformed parameters", () => {
  for (const link of [
    `https://open?id=${id}`,
    `neoread://delete?id=${id}`,
    "neoread://open?id=../../etc",
    "not a link",
  ])
    expect(parseNeoReadLink(link)).toBeNull();
  expect(
    parseNeoReadLink(`neoread://open?id=${id}&annotation=x&page=-1&extra=1`),
  ).toEqual({ id });
});
