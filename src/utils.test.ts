import { describe, expect, it } from "vitest";
import { baseName, fmtSize, isImage, parentPath, quotePath } from "./utils";

describe("parentPath", () => {
  it("walks up one level", () => expect(parentPath("/a/b/c")).toBe("/a/b"));
  it("stops at the root", () => expect(parentPath("/a")).toBe("/"));
  it("keeps the root at the root", () => expect(parentPath("/")).toBe("/"));
  it("handles empty input", () => expect(parentPath("")).toBe("/"));
  it("ignores trailing slashes", () => expect(parentPath("/a/b/")).toBe("/a"));
});

describe("baseName", () => {
  it("returns the last segment", () => expect(baseName("/a/b/c.txt")).toBe("c.txt"));
  it("ignores trailing slashes", () => expect(baseName("/a/b/")).toBe("b"));
  it("handles bare names", () => expect(baseName("file")).toBe("file"));
});

describe("fmtSize", () => {
  it("marks directories", () => expect(fmtSize(4096, true)).toBe("—"));
  it("bytes", () => expect(fmtSize(512, false)).toBe("512 B"));
  it("kilobytes", () => expect(fmtSize(2048, false)).toBe("2.0 KB"));
  it("megabytes", () => expect(fmtSize(5 * 1024 * 1024, false)).toBe("5.0 MB"));
  it("gigabytes", () => expect(fmtSize(3 * 1024 * 1024 * 1024, false)).toBe("3.0 GB"));
});

describe("quotePath", () => {
  it("quotes paths with spaces", () => expect(quotePath("/a b/c")).toBe('"/a b/c"'));
  it("leaves plain paths alone", () => expect(quotePath("/a/b")).toBe("/a/b"));
});

describe("isImage", () => {
  it("detects images case-insensitively", () => expect(isImage("/x/Y.PNG")).toBe(true));
  it("rejects other files", () => expect(isImage("/x/y.txt")).toBe(false));
});
