import { describe, expect, it } from "vitest";

const {
  FDROID_ABI_VERSION_CODE_SUFFIXES,
  getDesktopNativeVersionInput,
  getFdroidVersionCodes,
  getNativeReleaseVersion,
} = require("./native-release-version");

describe("native release version", () => {
  it("resolves workstation metadata only through the desktop export input", () => {
    const version = "0.15.2-workstation.1";
    expect(getDesktopNativeVersionInput(version)).toBe("0.15.2");
    expect(getNativeReleaseVersion(getDesktopNativeVersionInput(version))).toEqual({
      appVersion: "0.15.2",
      androidVersionCode: 15002,
      iosBuildNumber: "15002999",
    });
    expect(() => getNativeReleaseVersion(version)).toThrow("unsupported version");
    expect(() => getFdroidVersionCodes(version)).toThrow("unsupported version");
  });

  it.each(["0.15.2", "0.15.2-beta.2"])(
    "preserves the native release channel for %s during desktop export",
    (version) => {
      expect(getDesktopNativeVersionInput(version)).toBe(version);
      expect(getNativeReleaseVersion(getDesktopNativeVersionInput(version))).toEqual(
        getNativeReleaseVersion(version),
      );
    },
  );

  it.each([
    "0.15.2-workstation.0",
    "0.15.2-workstation.01",
    "0.15.2-workstation.1-extra",
    "0.15.2-workstation.1\n",
    "0.15.2-alex.10",
    "prefix-0.15.2-workstation.1",
  ])("rejects unsupported desktop version %j", (version) => {
    expect(() => getNativeReleaseVersion(getDesktopNativeVersionInput(version))).toThrow(
      "unsupported version",
    );
  });

  it("reserves the final iOS build slot for a stable release", () => {
    expect(getNativeReleaseVersion("0.2.6")).toEqual({
      appVersion: "0.2.6",
      androidVersionCode: 2006,
      iosBuildNumber: "2006999",
    });
  });

  it("gives each beta a unique iOS build slot under the stable app version", () => {
    expect(getNativeReleaseVersion("0.2.6-beta.2")).toEqual({
      appVersion: "0.2.6",
      androidVersionCode: 2006,
      iosBuildNumber: "2006002",
    });
  });

  it("rejects beta numbers that consume the stable iOS build slot", () => {
    expect(() => getNativeReleaseVersion("0.2.6-beta.999")).toThrow(
      "iOS beta number must be between 1 and 998",
    );
  });

  it("derives one F-Droid version code per published ABI", () => {
    expect(FDROID_ABI_VERSION_CODE_SUFFIXES).toEqual({
      "armeabi-v7a": 1,
      "arm64-v8a": 2,
      x86: 3,
      x86_64: 4,
    });
    expect(getFdroidVersionCodes("0.5.0")).toEqual([
      { abi: "armeabi-v7a", versionCode: 50001 },
      { abi: "arm64-v8a", versionCode: 50002 },
      { abi: "x86", versionCode: 50003 },
      { abi: "x86_64", versionCode: 50004 },
    ]);
  });
});
