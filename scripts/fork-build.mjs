import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  constants,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const release = readJson("fork-release.json");
const mode = process.argv[2];
const output = process.env.PASEO_BUILD_OUTPUT || "/out";
const imageRole = process.env.PASEO_BUILD_IMAGE_ROLE;
let expectedImage;
if (imageRole === "package") expectedImage = release.builderImage;
else if (imageRole === "check") expectedImage = release.checkBuilderImage;
if (!expectedImage || expectedImage !== process.env.PASEO_BUILD_IMAGE) {
  throw new Error("The selected Docker image differs from this source's image policy");
}

function stampManifest(manifest, names, version) {
  manifest.version = version;
  for (const section of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      if (names.has(name)) manifest[section][name] = manifest.private ? "*" : version;
    }
  }
}

if (mode === "dependency-key") {
  const root = readJson("package.json");
  const files = [
    "package-lock.json",
    "package.json",
    ...root.workspaces.map((p) => `${p}/package.json`),
    // npm ci only executes lifecycle hooks and applies patches. Other script
    // changes select checks, but must not throw away a valid install cache.
    "scripts/postinstall-patches.mjs",
  ];
  function collect(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  collect("patches");
  const hash = createHash("sha256").update(process.env.PASEO_BUILD_IMAGE).update("\0");
  for (const file of files.sort())
    hash.update(file).update("\0").update(readFileSync(file)).update("\0");
  console.log(hash.digest("hex"));
} else if (mode === "stamp") {
  const root = readJson("package.json");
  const files = ["package.json", ...root.workspaces.map((p) => `${p}/package.json`)];
  const packages = files.map((file) => ({ file, manifest: readJson(file) }));
  const names = new Set(packages.map(({ manifest }) => manifest.name));
  const lock = readJson("package-lock.json");
  lock.version = release.runtimeVersion;
  for (const { file, manifest } of packages) {
    stampManifest(manifest, names, release.runtimeVersion);
    const lockPath = file === "package.json" ? "" : path.dirname(file);
    if (!lock.packages[lockPath]) throw new Error(`Missing workspace lock: ${lockPath}`);
    lock.packages[lockPath].version = manifest.version;
    for (const section of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      if (manifest[section]) lock.packages[lockPath][section] = manifest[section];
    }
    writeJson(file, manifest);
  }
  writeJson("package-lock.json", lock);
} else if (mode === "candidate" || mode === "record") {
  const files = readdirSync("packages/desktop/release").filter((file) => file.endsWith(".deb"));
  if (files.length !== 1) throw new Error(`Expected one Debian package, found ${files.length}`);
  const file = `packages/desktop/release/${files[0]}`;
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  const metadata = execFileSync(
    "dpkg-deb",
    ["--field", file, "Package", "Version", "Architecture"],
    { encoding: "utf8" },
  );
  const fields = Object.fromEntries(
    metadata
      .trim()
      .split("\n")
      .map((line) => line.split(/: /, 2)),
  );
  const provenance = {
    schemaVersion: 1,
    recipeVersion: release.recipeVersion,
    sourceCommit: process.env.PASEO_BUILD_SOURCE,
    baseline: process.env.PASEO_BUILD_BASELINE === "1",
    upstreamVersion: process.env.PASEO_BUILD_BASELINE === "1" ? "0.15.0" : release.upstreamVersion,
    upstreamCommit:
      process.env.PASEO_BUILD_BASELINE === "1"
        ? process.env.PASEO_BUILD_SOURCE
        : release.upstreamCommit,
    runtimeVersion: readJson("package.json").version,
    builderImage: release.builderImage,
    nodeVersion: process.version,
    packageName: fields.Package,
    packageVersion: fields.Version,
    architecture: fields.Architecture,
    file: files[0],
    sha256,
    packagedSmoke: "passed",
  };
  if (mode === "candidate") {
    copyFileSync(file, path.join(output, files[0]), constants.COPYFILE_EXCL);
    writeFileSync(path.join(output, "candidate.json"), `${JSON.stringify(provenance, null, 2)}\n`, {
      flag: "wx",
    });
    console.log(`Unaccepted candidate: ${path.join(output, files[0])}\nSHA-256: ${sha256}`);
  } else {
    const candidate = readJson(path.join(output, "candidate.json"));
    const inspection = readJson(path.join(output, "publication.json"));
    const inspectionPaths = [
      ".gitleaks.toml",
      "scripts/check-publication.sh",
      "scripts/check-publication.py",
      "scripts/publication-scanner.json",
      "scripts/publication-exceptions.json",
      "scripts/publication-pruned-files.json",
    ].sort();
    const inspectionInputs = Object.fromEntries(
      inspectionPaths.map((inputPath) => [
        inputPath,
        createHash("sha256").update(readFileSync(inputPath)).digest("hex"),
      ]),
    );
    const exportedSha256 = createHash("sha256")
      .update(readFileSync(path.join(output, files[0])))
      .digest("hex");
    if (
      JSON.stringify(candidate) !== JSON.stringify(provenance) ||
      exportedSha256 !== sha256 ||
      inspection.schemaVersion !== 1 ||
      inspection.mode !== "package" ||
      inspection.ok !== true ||
      inspection.sha256 !== sha256 ||
      !Array.isArray(inspection.findings) ||
      inspection.findings.length !== 0 ||
      inspection.scannerImage !== readJson("scripts/publication-scanner.json").image ||
      JSON.stringify(Object.keys(inspection.inspectionInputs ?? {}).sort()) !==
        JSON.stringify(inspectionPaths) ||
      inspectionPaths.some(
        (inputPath) => inspection.inspectionInputs[inputPath] !== inspectionInputs[inputPath],
      )
    ) {
      throw new Error("Package identity or publication inspection changed before acceptance");
    }
    provenance.publicationCheck = {
      scannerImage: inspection.scannerImage,
      inspectionInputs,
      reportSha256: createHash("sha256")
        .update(readFileSync(path.join(output, "publication.json")))
        .digest("hex"),
    };
    writeFileSync(
      path.join(output, "provenance.json"),
      `${JSON.stringify(provenance, null, 2)}\n`,
      {
        flag: "wx",
      },
    );
    console.log(`Accepted package: ${path.join(output, files[0])}\nSHA-256: ${sha256}`);
  }
} else {
  throw new Error("Expected dependency-key, stamp, candidate or record");
}
