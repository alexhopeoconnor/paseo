import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function writeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
}

function createFakeMacBundle(options: { includeHelper: boolean }): {
  root: string;
  shimPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "paseo-cli-shim-test-"));
  const appPath = join(root, "Paseo.app");
  const contentsPath = join(appPath, "Contents");
  const resourcesPath = join(contentsPath, "Resources");
  const shimPath = join(resourcesPath, "bin", "paseo");
  const mainPath = join(contentsPath, "MacOS", "Paseo");
  const helperPath = join(
    contentsPath,
    "Frameworks",
    "Paseo Helper.app",
    "Contents",
    "MacOS",
    "Paseo Helper",
  );

  mkdirSync(dirname(shimPath), { recursive: true });
  mkdirSync(dirname(mainPath), { recursive: true });
  copyFileSync(join(packageRoot, "bin", "paseo"), shimPath);
  chmodSync(shimPath, 0o755);

  writeExecutable(mainPath, "#!/bin/sh\necho main-executable\n");

  if (options.includeHelper) {
    mkdirSync(dirname(helperPath), { recursive: true });
    writeExecutable(
      helperPath,
      [
        "#!/bin/sh",
        'printf "helper env=%s/%s cli=%s\\n" "$ELECTRON_RUN_AS_NODE" "$PASEO_NODE_ENV" "$PASEO_CLI"',
        'printf "args=%s\\n" "$*"',
        "",
      ].join("\n"),
    );
  }

  return { root, shimPath };
}

describe("desktop packaging", () => {
  it.skipIf(process.platform !== "linux")(
    "bounds scanner resources by Docker daemon capacity and rejects failed capacity checks",
    () => {
      const inspectorPath = join(packageRoot, "..", "..", "scripts", "check-publication.py");
      const result = spawnSync(
        "python3",
        [
          "-B",
          "-c",
          String.raw`
import importlib.util, pathlib, subprocess, sys, tempfile
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("publication", sys.argv[1])
publication = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publication)

with tempfile.TemporaryDirectory() as directory:
    for capacity, expected in [(1, 1), (2, 2), (4, 4), (64, 4)]:
        commands = []
        def run(command, **options):
            commands.append(command)
            assert options["stdout"] == subprocess.PIPE
            assert options["stderr"] == subprocess.PIPE
            if command[:2] == ["docker", "info"]:
                assert command == ["docker", "info", "--format", "{{.NCPU}}"]
                assert options["timeout"] > 0
                return subprocess.CompletedProcess(command, 0, f"{capacity}\n".encode(), b"")
            assert command[:2] == ["docker", "run"]
            assert command[command.index("--cpus") + 1] == str(expected)
            assert f"GOMAXPROCS={expected}" in command
            return subprocess.CompletedProcess(command, 0, b"[]", b"")
        inspector = publication.Inspector(pathlib.Path(directory) / f"capacity-{capacity}")
        inspector.bytes(b"const value = 1;", "example.js")
        with patch.object(publication.subprocess, "run", side_effect=run):
            inspector.scan()
        assert len(commands) == 2 and not inspector.findings

    failures = [
        subprocess.CompletedProcess([], 1, b"2\n", b"private diagnostic must remain hidden"),
        OSError("private diagnostic must remain hidden"),
        subprocess.TimeoutExpired("docker", 30, stderr=b"private diagnostic must remain hidden"),
        *[subprocess.CompletedProcess([], 0, value, b"private diagnostic must remain hidden")
          for value in [b"0\n", b"-1\n", b"", b"two\n", b"2.5\n", b"2\nextra"]],
    ]
    for number, failure in enumerate(failures):
        inspector = publication.Inspector(pathlib.Path(directory) / f"failure-{number}")
        inspector.bytes(b"const value = 1;", "example.js")
        options = {"side_effect": failure} if isinstance(failure, Exception) else {"return_value": failure}
        with patch.object(publication.subprocess, "run", **options) as command:
            try:
                inspector.scan()
            except publication.InspectionError as error:
                assert str(error) in {
                    "Docker daemon CPU capacity query failed",
                    "Docker daemon returned an invalid CPU capacity",
                }
                assert "private diagnostic" not in str(error)
            else:
                raise AssertionError("Invalid Docker capacity did not block scanning")
            assert command.call_count == 1
print("scanner capacity, two-CPU compatibility and fail-closed diagnostics verified")
`,
          inspectorPath,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        "scanner capacity, two-CPU compatibility and fail-closed diagnostics verified",
      );
    },
  );

  it.skipIf(process.platform !== "linux")(
    "inspects nested package content without materializing archive paths",
    () => {
      const inspectorPath = join(packageRoot, "..", "..", "scripts", "check-publication.py");
      const result = spawnSync(
        "python3",
        [
          "-B",
          "-c",
          String.raw`
import contextlib, gzip, hashlib, importlib.util, io, json, pathlib, struct, sys, tarfile, tempfile
spec = importlib.util.spec_from_file_location("publication", sys.argv[1])
publication = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publication)

def archive(name, data):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as tar:
        member = tarfile.TarInfo(name)
        member.size = len(data)
        tar.addfile(member, io.BytesIO(data))
    return output.getvalue()

def asar(name, data):
    header = json.dumps({"files": {name: {"size": len(data), "offset": "0"}}}).encode()
    padding = (4 - len(header) % 4) % 4
    payload = struct.pack("<I", len(header)) + header + b"\0" * padding
    header_pickle = struct.pack("<I", len(payload)) + payload
    return struct.pack("<II", 4, len(header_pickle)) + header_pickle + data

with tempfile.TemporaryDirectory() as root:
    root = pathlib.Path(root)
    safe = publication.Inspector(root / "safe")
    data = archive(".env.example", b"OPENAI_API_KEY=\n")
    safe.inspect(io.BytesIO(data), "safe.tar", len(data))
    assert not safe.findings
    assert any(item["path"].endswith("!.env.example") for item in safe.records)

    environment = publication.Inspector(root / "environment")
    data = archive(".env.production", b"API_TOKEN=fixture\n")
    environment.inspect(io.BytesIO(data), "unsafe.tar", len(data))
    assert any(item["rule"] == "local-state-path" for item in environment.findings)

    nested = publication.Inspector(root / "nested", {"forbiddenLiterals": ["private-publication-fixture.invalid"]})
    data = archive("app.asar", asar("settings.json", b'{"host":"private-publication-fixture.invalid"}'))
    nested.inspect(io.BytesIO(data), "bundle.tar", len(data))
    assert any(item["path"].endswith("!app.asar!settings.json") for item in nested.findings)
    assert "private-publication-fixture.invalid" not in json.dumps(nested.findings)

    names = publication.Inspector(root / "names", {"forbiddenLiterals": ["private-publication-fixture.invalid"]})
    names.bytes(b"{}", "private-publication-fixture.invalid/config.json")
    assert len(names.findings) == 1 and names.findings[0]["rule"] == "private-literal-1"
    assert "private-publication-fixture.invalid" not in json.dumps(names.findings)

    traversal = publication.Inspector(root / "traversal")
    data = archive("../escaped", b"must not be written")
    try:
        traversal.inspect(io.BytesIO(data), "traversal.tar", len(data))
    except publication.InspectionError:
        pass
    else:
        raise AssertionError("Traversal was accepted")
    assert not (root / "escaped").exists()

    for number, (name, data) in enumerate([
            ("hidden.bin", bytes.fromhex("377abcaf271c") + b"unsupported"),
            ("hidden.bin", b"Rar!" + bytes([26, 7, 0]) + b"unsupported"),
            ("hidden.bin", b"MSCFunsupported"),
            ("broken.zip", b"not a zip"),
            ("broken.gz", b"not compressed"),
            ("broken.asar", b"not an asar"),
            ("broken.deb", b"not a Debian package")]):
        malformed = publication.Inspector(root / f"malformed-{number}")
        try:
            malformed.inspect(io.BytesIO(data), name, len(data))
        except publication.InspectionError:
            pass
        else:
            raise AssertionError("Unsupported or malformed archive was silently scanned as plain data")

    systemd_name = r"usr/lib/systemd/system/system-systemd\x2dcryptsetup.slice"
    assert publication.safe_name(systemd_name) == systemd_name
    try:
        publication.safe_name(r"..\escaped")
    except publication.InspectionError:
        pass
    else:
        raise AssertionError("Windows-style traversal separator was accepted")

    wrong_release = root / "release"
    wrong_release.mkdir()
    (wrong_release / "private-notes.txt").write_text("not a release asset")
    try:
        publication.collect_release(publication.Inspector(root / "inventory"), wrong_release)
    except publication.InspectionError:
        pass
    else:
        raise AssertionError("Unexpected release files were accepted")

    limited = publication.Inspector(root / "limit")
    try:
        limited.add(io.BytesIO(b"x"), "large.js", publication.MAX_FILE + 1)
    except publication.InspectionError:
        pass
    else:
        raise AssertionError("Oversized input was silently skipped")
    contract = json.loads((publication.ROOT / "scripts/publication-pruned-files.json").read_text())
    optional = contract["entries"][0]
    def unpacked_header(relative):
        tree = {"files": {}}
        node = tree
        components = relative.split("/")
        for part in components[:-1]:
            node["files"][part] = {"files": {}}
            node = node["files"][part]
        node["files"][components[-1]] = {"size": 123, "unpacked": True}
        encoded = json.dumps(tree).encode()
        payload = struct.pack("<I", len(encoded)) + encoded + bytes((4 - len(encoded) % 4) % 4)
        header = struct.pack("<I", len(payload)) + payload
        return struct.pack("<II", 4, len(header)) + header
    def deb(architecture, relative):
        entries = [
            ("debian-binary", b"2.0\n"),
            ("control.tar", archive("control", ("Package: fixture\nArchitecture: " + architecture + "\n").encode())),
            ("data.tar", archive("opt/Paseo/resources/app.asar", unpacked_header(relative))),
        ]
        output = b"!<arch>\n"
        for name, data in entries:
            output += f"{name + '/':<16}{0:<12}{0:<6}{0:<6}{'100644':<8}{len(data):<10}".encode() + bytes([96, 10])
            output += data + (b"\n" if len(data) % 2 else b"")
        return output
    pruned = publication.Inspector(root / "pruned")
    data = deb("amd64", optional)
    pruned.inspect(io.BytesIO(data), "package.deb", len(data))
    reviewed = pruned.finish_archives()
    assert len(reviewed) == 1 and reviewed[0]["reason"] == contract["reason"]
    for number, (architecture, relative) in enumerate([
            ("arm64", optional), ("amd64", "node_modules/required/runtime.js")]):
        rejected = publication.Inspector(root / f"missing-{number}")
        data = deb(architecture, relative)
        rejected.inspect(io.BytesIO(data), "package.deb", len(data))
        try:
            rejected.finish_archives()
        except publication.InspectionError:
            pass
        else:
            raise AssertionError("Unexpected missing ASAR content was accepted")
    original_root = publication.ROOT
    changed = root / "changed-policy"
    (changed / "scripts").mkdir(parents=True)
    (changed / "packages/desktop/scripts").mkdir(parents=True)
    (changed / "scripts/publication-pruned-files.json").write_text(json.dumps(contract))
    (changed / contract["source"]).write_text("changed pruning implementation")
    try:
        publication.ROOT = changed
        try:
            pruned.finish_archives()
        except publication.InspectionError:
            pass
        else:
            raise AssertionError("Changed pruning implementation was accepted")
    finally:
        publication.ROOT = original_root

    complete = root / "complete-release"
    complete.mkdir()
    package_name = "Paseo-0.15.2-workstation.1-amd64.deb"
    package_bytes = deb("amd64", optional)
    (complete / package_name).write_bytes(package_bytes)
    (complete / "paseo-fork-builder.tar.gz").write_bytes(gzip.compress(archive("manifest.json", b"[]")))
    (complete / "provenance.json").write_text(json.dumps({"file": package_name, "sha256": hashlib.sha256(package_bytes).hexdigest()}))
    inventory = [package_name, "paseo-fork-builder.tar.gz", "provenance.json"]
    (complete / "SHA256SUMS").write_text("".join(publication.digest(complete / name) + "  " + name + "\n" for name in inventory))
    empty_policy = root / "empty-policy.json"
    empty_policy.write_text("{}")
    original_scan, original_argv = publication.Inspector.scan, sys.argv
    try:
        sys.argv = ["check-publication.py", "release", "--directory", str(complete), "--policy", str(empty_policy)]
        publication.Inspector.scan = lambda self: (complete / package_name).write_bytes(b"changed during scan")
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            assert publication.main() == 1
        assert json.loads(captured.getvalue())["error"] == "Release assets changed during inspection"
        (complete / package_name).write_bytes(package_bytes)
        publication.Inspector.scan = lambda self: (complete / "unreviewed.txt").write_text("extra asset")
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            assert publication.main() == 1
        assert json.loads(captured.getvalue())["error"] == "Release asset inventory changed during inspection"
    finally:
        publication.Inspector.scan, sys.argv = original_scan, original_argv
print("nested content, redaction, traversal, inventory and limits verified")
`,
          inspectorPath,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        "nested content, redaction, traversal, inventory and limits verified",
      );
    },
  );

  it.skipIf(process.platform !== "linux")(
    "accepts an exported candidate only after its exact bytes pass publication inspection",
    () => {
      const root = mkdtempSync(join(tmpdir(), "paseo-publication-gate-"));
      const output = join(root, "output");
      const input = join(root, "input");
      const release = join(root, "packages", "desktop", "release");
      const packageName = "Paseo-0.15.2-workstation.1-amd64.deb";
      const builderImage = `sha256:${"a".repeat(64)}`;
      const driver = join(packageRoot, "..", "..", "scripts", "fork-build.mjs");
      const invoke = (mode: string) =>
        spawnSync(process.execPath, [driver, mode], {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            PASEO_BUILD_IMAGE: builderImage,
            PASEO_BUILD_SOURCE: "b".repeat(40),
            PASEO_BUILD_OUTPUT: output,
          },
        });
      try {
        mkdirSync(output);
        mkdirSync(release, { recursive: true });
        mkdirSync(join(input, "DEBIAN"), { recursive: true });
        writeFileSync(
          join(input, "DEBIAN", "control"),
          "Package: paseo\nVersion: 0.15.2~workstation.1\nArchitecture: amd64\nMaintainer: Fixture <fixture@example.invalid>\nDescription: publication gate fixture\n",
        );
        const built = spawnSync("dpkg-deb", ["--build", input, join(release, packageName)], {
          encoding: "utf8",
        });
        expect(built.status, built.stderr).toBe(0);
        writeFileSync(
          join(root, "package.json"),
          JSON.stringify({ version: "0.15.2-workstation.1" }),
        );
        writeFileSync(
          join(root, "fork-release.json"),
          JSON.stringify({
            recipeVersion: 1,
            builderImage,
            upstreamVersion: "0.15.2",
            upstreamCommit: "c".repeat(40),
          }),
        );
        const candidate = invoke("candidate");
        expect(candidate.status, candidate.stderr).toBe(0);
        expect(existsSync(join(output, "candidate.json"))).toBe(true);
        expect(existsSync(join(output, "provenance.json"))).toBe(false);
        expect(invoke("record").status).not.toBe(0);

        const bytes = readFileSync(join(output, packageName));
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const inspectionFiles = [
          ".gitleaks.toml",
          "scripts/check-publication.sh",
          "scripts/check-publication.py",
          "scripts/publication-scanner.json",
          "scripts/publication-exceptions.json",
          "scripts/publication-pruned-files.json",
        ];
        const inspectionInputs = Object.fromEntries(
          inspectionFiles.map((file) => {
            const source = join(packageRoot, "..", "..", file);
            const destination = join(root, file);
            mkdirSync(dirname(destination), { recursive: true });
            copyFileSync(source, destination);
            return [file, createHash("sha256").update(readFileSync(source)).digest("hex")];
          }),
        );
        const scannerImage = JSON.parse(
          readFileSync(join(root, "scripts", "publication-scanner.json"), "utf8"),
        ).image as string;
        const report = {
          schemaVersion: 1,
          mode: "package",
          ok: true,
          sha256,
          findings: [],
          scannerImage,
          inspectionInputs,
        };
        for (const invalid of [
          { ...report, ok: false },
          { ...report, sha256: "e".repeat(64) },
          { ...report, findings: [{ rule: "fixture" }] },
          { ...report, mode: "snapshot" },
          { ...report, scannerImage: "unreviewed:latest" },
          { ...report, scannerImage: `ghcr.io/gitleaks/gitleaks@sha256:${"d".repeat(64)}` },
          { ...report, inspectionInputs: {} },
          {
            ...report,
            inspectionInputs: { ...inspectionInputs, ".gitleaks.toml": "e".repeat(64) },
          },
        ]) {
          writeFileSync(join(output, "publication.json"), JSON.stringify(invalid));
          expect(invoke("record").status).not.toBe(0);
          expect(existsSync(join(output, "provenance.json"))).toBe(false);
        }
        writeFileSync(join(output, "publication.json"), JSON.stringify(report));
        writeFileSync(join(output, packageName), "replaced bytes");
        expect(invoke("record").status).not.toBe(0);
        expect(existsSync(join(output, "provenance.json"))).toBe(false);
        writeFileSync(join(output, packageName), bytes);
        const accepted = invoke("record");
        expect(accepted.status, accepted.stderr).toBe(0);
        const provenance = JSON.parse(readFileSync(join(output, "provenance.json"), "utf8"));
        expect(provenance.sha256).toBe(sha256);
        expect(provenance.publicationCheck.scannerImage).toBe(report.scannerImage);
        expect(provenance.publicationCheck.reportSha256).toBe(
          createHash("sha256")
            .update(readFileSync(join(output, "publication.json")))
            .digest("hex"),
        );
        expect(invoke("record").status).not.toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it.skipIf(process.platform !== "linux")(
    "rejects owner-only runtime inputs before installing as root",
    () => {
      const { assertLinuxRuntimePermissions } = createRequire(import.meta.url)(
        "../../e2e/packaged-app-smoke.js",
      );
      const root = mkdtempSync(join(tmpdir(), "paseo-package-permissions-"));
      const directory = join(root, "zsh");
      const integration = join(directory, ".zshenv");
      try {
        mkdirSync(directory);
        chmodSync(directory, 0o755);
        writeFileSync(integration, "# shell integration\n");
        chmodSync(integration, 0o600);
        expect(() => assertLinuxRuntimePermissions(root)).toThrow("inaccessible to non-owner");
        chmodSync(integration, 0o644);
        expect(() => assertLinuxRuntimePermissions(root)).not.toThrow();
        chmodSync(directory, 0o700);
        expect(() => assertLinuxRuntimePermissions(root)).toThrow("inaccessible to non-owner");
        chmodSync(directory, 0o755);
        chmodSync(integration, 0o744);
        expect(() => assertLinuxRuntimePermissions(root)).toThrow("inaccessible to non-owner");
        chmodSync(integration, 0o755);
        expect(() => assertLinuxRuntimePermissions(root)).not.toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it("uses an Electron runtime whose Squirrel handoff explicitly wakes ShipIt", () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    const electronVersion = pkg.devDependencies?.electron ?? "0.0.0";
    const electronMajor = Number(electronVersion.split(".")[0]);

    expect(electronMajor).toBeGreaterThanOrEqual(44);
  });

  it("requires macOS 13 or newer in the packaged application", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain('minimumSystemVersion: "13.0.0"');
  });

  it("unpacks server zsh shell integration files for external shells", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain(
      "node_modules/@getpaseo/server/dist/server/terminal/shell-integration/**/*",
    );
    expect(config).not.toContain(
      "node_modules/@getpaseo/server/dist/src/terminal/shell-integration/**/*",
    );
  });

  it("excludes package debug/source files from the packaged app", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain("!**/*.map");
    expect(config).toContain("!node_modules/@getpaseo/*/src/**");
    expect(config).toContain("!node_modules/@getpaseo/**/*.test.*");
    expect(config).toContain("!node_modules/@getpaseo/**/*.spec.*");
  });

  it("excludes the bundled daemon web UI from the packaged app", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain("!node_modules/@getpaseo/server/dist/server/web-ui/**");
  });

  it("uses the server skill catalog without a duplicate desktop resource", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");
    const serverPackage = readFileSync(join(packageRoot, "..", "server", "package.json"), "utf8");
    const runtimeTrace = readFileSync(
      join(packageRoot, "..", "..", "scripts", "trace-daemon.mjs"),
      "utf8",
    );

    expect(config).not.toContain("from: ../../skills");
    expect(serverPackage).toContain("fs.rmSync('dist/server/skills',{recursive:true,force:true})");
    expect(serverPackage).toContain("fs.cpSync('../../skills','dist/server/skills'");
    expect(runtimeTrace).toContain('"packages/server/dist/server/skills/**"');
  });

  it("registers Paseo agent links with the operating system", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain("name: Paseo agent link");
    expect(config).toContain("- paseo");
  });

  // electron-builder packs production dependencies declared in package.json into
  // app.asar. Runtime code in runtime-paths.ts and bin/paseo dynamically resolves
  // these workspace packages by string, so static analysis (TypeScript, Knip) cannot
  // see the link. If a runtime-required workspace dep is dropped from
  // dependencies, the build still succeeds but ships a broken bundle. This
  // assertion is the safety net.
  it("declares all workspace packages required at runtime", () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const deps = pkg.dependencies ?? {};

    for (const required of ["@getpaseo/cli", "@getpaseo/server"]) {
      expect(deps[required], `${required} must be declared in dependencies`).toBe("*");
    }
  });

  it("launches the packaged macOS CLI through Helper instead of the main app executable", () => {
    if (process.platform === "win32") return;

    const bundle = createFakeMacBundle({ includeHelper: true });
    try {
      const result = spawnSync(bundle.shimPath, ["--version"], { encoding: "utf8" });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`helper env=1/production cli=${bundle.shimPath}`);
      expect(result.stdout).toContain("node-entrypoint-runner.js");
      expect(result.stdout).toContain("node-script");
      expect(result.stdout).toContain("@getpaseo/cli/dist/index.js");
      expect(result.stdout).toContain("--version");
      expect(result.stdout).not.toContain("main-executable");
    } finally {
      rmSync(bundle.root, { recursive: true, force: true });
    }
  });

  it("fails packaged macOS CLI startup when Helper is missing", () => {
    if (process.platform === "win32") return;

    const bundle = createFakeMacBundle({ includeHelper: false });
    try {
      const result = spawnSync(bundle.shimPath, ["--version"], { encoding: "utf8" });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Bundled Paseo Helper executable not found");
      expect(result.stdout).not.toContain("main-executable");
    } finally {
      rmSync(bundle.root, { recursive: true, force: true });
    }
  });
});

it("installs the Linux helper as root-owned 4755 regardless of root's namespace access", () => {
  const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");
  expect(config).toContain("afterInstall: scripts/linux-sandbox/after-install.tpl");
  const installer = readFileSync(
    join(packageRoot, "scripts/linux-sandbox/after-install.tpl"),
    "utf8",
  );
  expect(installer).not.toContain("unshare");
  expect(installer).toContain("chown root:root '/opt/${sanitizedProductName}/chrome-sandbox'");
  expect(installer).toContain("chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox'");
  expect(installer).not.toContain("chmod 0755");
});
