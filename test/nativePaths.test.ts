import { expect, it } from "vitest";
import { normalizeNativePath } from "../src/utils/nativePaths";

it.each([
  ["\\\\?\\C:\\work\\project", "C:\\work\\project"],
  ["\\\\?\\UNC\\server\\share\\project", "\\\\server\\share\\project"],
  ["\\\\?\\unc\\server\\share\\project", "\\\\server\\share\\project"],
  ["C:\\work\\project", "C:\\work\\project"],
  ["/work/project", "/work/project"]
])("normalizes native folder spelling %s", (native, expected) => {
  expect(normalizeNativePath(native)).toBe(expected);
});
