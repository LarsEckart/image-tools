import { describe, expect, test } from "bun:test";
import {
  getPngFilenameForSource,
  getTargetOutputFilename,
  getUniqueFilename,
  isSupportedHeifFile,
  shouldSkipAlreadyConverted,
} from "./heif-to-png";

describe("isSupportedHeifFile", () => {
  test("accepts .heic and .heif case-insensitively", () => {
    expect(isSupportedHeifFile("IMG_1234.heic")).toBe(true);
    expect(isSupportedHeifFile("IMG_1234.HEIC")).toBe(true);
    expect(isSupportedHeifFile("IMG_1234.heif")).toBe(true);
    expect(isSupportedHeifFile("IMG_1234.HEIF")).toBe(true);
  });

  test("rejects unsupported extensions", () => {
    expect(isSupportedHeifFile("IMG_1234.png")).toBe(false);
    expect(isSupportedHeifFile("IMG_1234.jpg")).toBe(false);
    expect(isSupportedHeifFile("IMG_1234")).toBe(false);
  });
});

describe("getPngFilenameForSource", () => {
  test("preserves the basename and changes the extension to .png", () => {
    expect(getPngFilenameForSource("IMG_1234.HEIC")).toBe("IMG_1234.png");
    expect(getPngFilenameForSource("nested/path/Portrait.HEIF")).toBe("Portrait.png");
  });
});

describe("getUniqueFilename", () => {
  test("returns the base filename when it is available", () => {
    expect(getUniqueFilename("IMG_1234", ".png", new Set())).toBe("IMG_1234.png");
  });

  test("adds a numeric suffix when the target name is already reserved", () => {
    const reservedNames = new Set(["IMG_1234.png", "IMG_1234-1.png"]);

    expect(getUniqueFilename("IMG_1234", ".png", reservedNames)).toBe("IMG_1234-2.png");
  });
});

describe("getTargetOutputFilename", () => {
  test("uses suffixes by default when a collision exists", () => {
    const reservedNames = new Set(["IMG_1234.png"]);

    expect(getTargetOutputFilename("IMG_1234.HEIC", reservedNames, false)).toBe("IMG_1234-1.png");
  });

  test("keeps the plain target filename when overwrite is enabled", () => {
    const reservedNames = new Set(["IMG_1234.png", "IMG_1234-1.png"]);

    expect(getTargetOutputFilename("IMG_1234.HEIC", reservedNames, true)).toBe("IMG_1234.png");
  });
});

describe("shouldSkipAlreadyConverted", () => {
  test("skips when history exists and the previous output still exists", () => {
    expect(
      shouldSkipAlreadyConverted(
        {
          sourceFilename: "IMG_1234.HEIC",
          outputPath: "/tmp/outputs/IMG_1234.png",
          convertedAt: "2026-04-14T00:00:00.000Z",
        },
        true
      )
    ).toBe(true);
  });

  test("does not skip when history exists but the old output is gone", () => {
    expect(
      shouldSkipAlreadyConverted(
        {
          sourceFilename: "IMG_1234.HEIC",
          outputPath: "/tmp/outputs/IMG_1234.png",
          convertedAt: "2026-04-14T00:00:00.000Z",
        },
        false
      )
    ).toBe(false);
  });
});
