#!/usr/bin/env python3
"""Inspect publication inputs without executing or extracting their archive paths.

Content is flattened before Gitleaks so its default path exclusions cannot skip
bundled dependencies, lockfiles or assets. Reports contain locations and hashes,
never matched text. Size/depth limits are errors, not permission to skip content.
"""

import argparse
import bz2
import gzip
import hashlib
import io
import json
import lzma
import os
import posixpath
from pathlib import Path
import re
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SCANNER = json.loads((ROOT / "scripts/publication-scanner.json").read_text())["image"]
if not re.fullmatch(r"ghcr\.io/gitleaks/gitleaks@sha256:[a-f0-9]{64}", SCANNER):
    raise RuntimeError("Invalid pinned publication scanner")
INSPECTION_FILES = [
    ".gitleaks.toml", "scripts/check-publication.sh", "scripts/check-publication.py",
    "scripts/publication-scanner.json", "scripts/publication-exceptions.json",
    "scripts/publication-pruned-files.json",
]
MAX_FILE = 768 * 1024 * 1024
MAX_TOTAL = 16 * 1024 * 1024 * 1024
MAX_FILES = 300_000
MAX_DEPTH = 12
CHUNK = 1024 * 1024
TEMPLATES = {".env.example", ".env.sample", ".env.template"}


class InspectionError(Exception):
    pass


def scanner_cpus():
    try:
        result = subprocess.run(["docker", "info", "--format", "{{.NCPU}}"],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    except (OSError, subprocess.SubprocessError):
        raise InspectionError("Docker daemon CPU capacity query failed") from None
    if result.returncode:
        raise InspectionError("Docker daemon CPU capacity query failed")
    value = result.stdout.strip()
    if not re.fullmatch(rb"[1-9][0-9]*", value):
        raise InspectionError("Docker daemon returned an invalid CPU capacity")
    try:
        return min(4, int(value))
    except ValueError:
        raise InspectionError("Docker daemon returned an invalid CPU capacity") from None


def git(repository, *args, data=None):
    result = subprocess.run(["git", "-C", str(repository), *args], input=data,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise InspectionError("Git input inspection failed")
    return result.stdout


def regular(path):
    path = Path(path)
    if not stat.S_ISREG(path.lstat().st_mode):
        raise InspectionError("Expected a regular, non-symlink input file")
    return path


def digest(path):
    hasher = hashlib.sha256()
    with regular(path).open("rb") as source:
        while block := source.read(CHUNK):
            hasher.update(block)
    return hasher.hexdigest()


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise InspectionError("Duplicate JSON object key")
        value[key] = item
    return value


def safe_name(name):
    if not isinstance(name, str) or not name or len(name) > 4096:
        raise InspectionError("Invalid archive path")
    # systemd uses a literal POSIX filename escape for hyphens. Keep it literal;
    # never decode it or accept Windows-style backslash path separators.
    if "\x00" in name or "\\" in name.replace("\\x2d", "") or name.startswith("/"):
        raise InspectionError("Unsafe archive path")
    parts = name.split("/")
    if ".." in parts:
        raise InspectionError("Archive path traverses its root")
    return "/".join(part for part in parts if part not in ("", "."))


def read_policy(path):
    if not path:
        return {"forbiddenLiterals": [], "allow": []}
    policy = json.loads(regular(path).read_text())
    if not isinstance(policy, dict) or set(policy) - {"forbiddenLiterals", "allow"}:
        raise InspectionError("Invalid private publication policy")
    literals = policy.get("forbiddenLiterals", [])
    if (not isinstance(literals, list) or len(literals) > 256 or
            any(not isinstance(value, str) or not 4 <= len(value) <= 4096 for value in literals)):
        raise InspectionError("Invalid private policy literals")
    policy.setdefault("allow", [])
    policy["forbiddenLiterals"] = literals
    return policy


def checked_allow(entries):
    if not isinstance(entries, list):
        raise InspectionError("Invalid publication exceptions")
    for entry in entries:
        if (not isinstance(entry, dict) or set(entry) != {"path", "sha256", "rule", "reason"}
                or any(not isinstance(value, str) or not value for value in entry.values())
                or not re.fullmatch(r"[a-f0-9]{64}", entry["sha256"])):
            raise InspectionError("Exceptions require an exact path, SHA-256, rule and reason")
    return entries


class Inspector:
    def __init__(self, directory, policy=None, allowances=None):
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.policy = policy or {"forbiddenLiterals": [], "allow": []}
        self.allowances = checked_allow((allowances or []) + self.policy.get("allow", []))
        self.records = []
        self.findings = []
        self.total = 0
        self.seen = set()
        self.unpacked = set()
        self.containers = 0
        self.archive_stack = []
        self.duplicate_container_findings = 0
        self.package_architectures = {}

    def finding(self, record, rule, line=None):
        finding = {"path": record["path"], "sha256": record["sha256"], "rule": rule}
        if line is not None:
            finding["line"] = line
        if record.get("gitObject"):
            finding["gitObject"] = record["gitObject"]
        if not any(all(finding[key] == allow[key] for key in ("path", "sha256", "rule"))
                   for allow in self.allowances):
            for literal in self.policy.get("forbiddenLiterals", []):
                finding["path"] = re.sub(re.escape(literal), "[PRIVATE]", finding["path"], flags=re.I)
            self.findings.append(finding)

    def add(self, source, name, size, git_object=None, check_names=True):
        if size < 0 or size > MAX_FILE or len(self.records) >= MAX_FILES:
            raise InspectionError("Publication input exceeds an inspection limit")
        if self.total + size > MAX_TOTAL:
            raise InspectionError("Publication input exceeds the total inspection limit")
        number = len(self.records)
        destination = self.directory / f"{number:08d}.txt"
        record = {"path": name, "size": size, "ancestors": list(self.archive_stack)}
        if git_object:
            record["gitObject"] = git_object
        hasher = hashlib.sha256()
        remaining = size
        literals = [value.encode().lower() for value in self.policy.get("forbiddenLiterals", [])]
        name_bytes = name.encode().lower()
        found_literals = {index for index, value in enumerate(literals) if value in name_bytes}
        overlap = max([len(value) for value in literals] + [1]) - 1
        previous = b""
        # Keep binary strings searchable too; no files are dropped by extension.
        with destination.open("xb") as output:
            while remaining:
                block = source.read(min(CHUNK, remaining))
                if not block:
                    raise InspectionError("Truncated publication input")
                remaining -= len(block)
                hasher.update(block)
                search = previous + block.lower()
                found_literals.update(index for index, value in enumerate(literals) if value in search)
                previous = search[-overlap:] if overlap else b""
                output.write(block.decode("utf-8", errors="replace").replace("\x00", " ").encode())
        record["sha256"] = hasher.hexdigest()
        self.records.append(record)
        self.seen.add(name)
        self.total += size
        control = re.fullmatch(r"(.+\.deb)!control\.tar(?:\.[^!]+)?!control", name)
        if control and size < 65536:
            architecture = re.search(r"(?m)^Architecture:[ \t]*(\S+)[ \t]*$", destination.read_text())
            if architecture:
                self.package_architectures[control[1]] = architecture[1]
        for index in found_literals:
            self.finding(record, f"private-literal-{index + 1}")
        if check_names and forbidden_name(name):
            self.finding(record, "local-state-path")
        return record

    def bytes(self, data, name, **kwargs):
        return self.add(io.BytesIO(data), name, len(data), **kwargs)

    def link(self, target, name, hard=False):
        if "\x00" in target or "\\" in target.replace("\\x2d", ""):
            raise InspectionError("Unsafe archive link")
        if not target.startswith("/"):
            base = "" if hard else posixpath.dirname(name.split("!")[-1])
            resolved = posixpath.normpath(posixpath.join(base, target))
            if resolved == ".." or resolved.startswith("../"):
                raise InspectionError("Archive link traverses its root")
        # Never create/follow links. Absolute links in Linux images are metadata.
        record = self.bytes(target.encode(), name + " [link]", check_names=False)
        if forbidden_name(name):
            self.finding(record, "local-state-path")

    def inspect_file(self, path, name, depth=0):
        path = regular(path)
        with path.open("rb") as source:
            self.inspect(source, name, path.stat().st_size, depth)

    def inspect(self, source, name, size, depth=0):
        if depth > MAX_DEPTH:
            raise InspectionError("Nested archive depth exceeds the inspection limit")
        self.add(source, name, size)
        self.archive_stack.append(len(self.records) - 1)
        try:
            source.seek(0)
            prefix = source.read(512)
            source.seek(0)
            lower = name.lower()
            unsupported = (b"7z\xbc\xaf\x27\x1c", b"Rar!\x1a\x07", b"MSCF")
            if prefix.startswith(unsupported) or lower.endswith((".7z", ".rar", ".cab")):
                raise InspectionError("Unsupported archive format cannot be inspected")
            if lower.endswith((".zip", ".jar", ".whl", ".vsix", ".xpi")) and not prefix.startswith(
                    (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")):
                raise InspectionError("Declared ZIP archive has an invalid header")
            if lower.endswith(".deb") and not prefix.startswith(b"!<arch>\n"):
                raise InspectionError("Declared Debian archive has an invalid header")
            for suffix, magic in ((".gz", b"\x1f\x8b"), (".tgz", b"\x1f\x8b"),
                                  (".xz", b"\xfd7zXZ\x00"), (".bz2", b"BZh")):
                if lower.endswith(suffix) and not prefix.startswith(magic):
                    raise InspectionError("Declared compressed archive has an invalid header")
            if prefix.startswith(b"!<arch>\n"):
                self.ar(source, name, depth, deb=lower.endswith(".deb"))
            elif prefix.startswith(b"!<thin>\n"):
                raise InspectionError("Thin archive has external content that cannot be inspected")
            elif lower.endswith(".asar"):
                self.asar(source, name, size, depth)
            elif prefix.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")):
                self.zip(source, name, depth)
            elif (prefix.startswith((b"\x1f\x8b", b"\xfd7zXZ\x00", b"BZh"))
                  or prefix[257:262] == b"ustar"
                  or lower.endswith((".tar", ".tar.gz", ".tgz", ".tar.xz", ".tar.bz2"))):
                try:
                    archive = tarfile.open(fileobj=source, mode="r:*")
                except tarfile.ReadError:
                    source.seek(0)
                    if prefix.startswith(b"\x1f\x8b"):
                        uncompressed = gzip.GzipFile(fileobj=source)
                    elif prefix.startswith(b"\xfd7zXZ\x00"):
                        uncompressed = lzma.LZMAFile(source)
                    elif prefix.startswith(b"BZh"):
                        uncompressed = bz2.BZ2File(source)
                    else:
                        raise InspectionError("Unsupported or corrupt compressed archive")
                    with uncompressed:
                        self.spool(uncompressed, name + "!uncompressed", depth + 1)
                else:
                    with archive:
                        self.tar(archive, name, depth)
            elif prefix.startswith(b"\x28\xb5\x2f\xfd"):
                raise InspectionError("Zstandard archive inspection is not supported")
        finally:
            self.archive_stack.pop()

    def spool(self, source, name, depth, expected=None):
        with tempfile.TemporaryFile() as temporary:
            count = 0
            while True:
                block = source.read(CHUNK)
                if not block:
                    break
                count += len(block)
                if count > MAX_FILE or self.total + count > MAX_TOTAL:
                    raise InspectionError("Expanded archive exceeds an inspection limit")
                temporary.write(block)
            if expected is not None and count != expected:
                raise InspectionError("Truncated archive member")
            temporary.seek(0)
            self.inspect(temporary, name, count, depth)

    def tar(self, archive, name, depth):
        self.containers += 1
        names = set()
        for member in archive:
            relative = safe_name(member.name)
            if not relative and member.isdir():
                continue
            if relative in names:
                raise InspectionError("Duplicate archive member")
            names.add(relative)
            child = name + "!" + relative
            if member.isdir():
                continue
            if member.issym() or member.islnk():
                self.link(member.linkname, child, member.islnk())
            elif member.isfile():
                with archive.extractfile(member) as source:
                    self.spool(source, child, depth + 1, member.size)
            elif member.ischr() or member.isblk() or member.isfifo():
                # Docker image layers can contain devices. Record, never create them.
                self.bytes(json.dumps({"type": member.type.decode(), "major": member.devmajor,
                                       "minor": member.devminor}).encode(), child + " [device]")
            else:
                raise InspectionError("Unsupported archive member")

    def zip(self, source, name, depth):
        self.containers += 1
        names = set()
        with zipfile.ZipFile(source) as archive:
            for member in archive.infolist():
                relative = safe_name(member.filename)
                if relative in names:
                    raise InspectionError("Duplicate ZIP member")
                names.add(relative)
                if member.flag_bits & 1:
                    raise InspectionError("Encrypted ZIP member cannot be inspected")
                if member.is_dir():
                    continue
                child = name + "!" + relative
                with archive.open(member) as content:
                    if stat.S_ISLNK(member.external_attr >> 16):
                        if member.file_size > 4096:
                            raise InspectionError("Invalid ZIP link")
                        self.link(content.read().decode(), child)
                    else:
                        self.spool(content, child, depth + 1, member.file_size)

    def ar(self, source, name, depth, deb=False):
        self.containers += 1
        if source.read(8) != b"!<arch>\n":
            raise InspectionError("Invalid ar archive")
        members = set()
        string_table = b""
        number = 0
        while header := source.read(60):
            if len(header) != 60 or header[58:] != b"`\n":
                raise InspectionError("Invalid ar member header")
            raw_name = header[:16].decode("ascii").strip()
            size = int(header[48:58].decode("ascii").strip())
            if size < 0 or size > MAX_FILE:
                raise InspectionError("Invalid ar member size")
            data = source.read(size)
            if len(data) != size:
                raise InspectionError("Truncated ar archive")
            if size % 2 and len(source.read(1)) != 1:
                raise InspectionError("Truncated ar padding")
            number += 1
            if deb:
                member = safe_name(raw_name.rstrip("/"))
                if member in members:
                    raise InspectionError("Duplicate Debian member")
            elif raw_name == "//":
                string_table = data
                member = "string-table"
            elif raw_name in {"/", "/SYM64/"}:
                member = "symbol-table"
            elif raw_name.startswith("/") and raw_name[1:].isdigit():
                offset = int(raw_name[1:])
                end = string_table.find(b"/\n", offset)
                if not 0 <= offset < end:
                    raise InspectionError("Invalid ar extended member name")
                member = safe_name(string_table[offset:end].decode())
            elif raw_name.startswith("#1/"):
                length = int(raw_name[3:])
                if not 0 < length <= min(size, 4096):
                    raise InspectionError("Invalid ar inline member name")
                member = safe_name(data[:length].rstrip(b"\0").decode())
                data = data[length:]
            else:
                member = safe_name(raw_name.rstrip("/"))
            members.add(member)
            if deb and member == "debian-binary" and data != b"2.0\n":
                raise InspectionError("Unsupported Debian format")
            child = name + "!" + ("" if deb else f"member-{number:06d}/") + member
            self.inspect(io.BytesIO(data), child, len(data), depth + 1)
        if deb and ("debian-binary" not in members
                    or len([item for item in members if item.startswith("control.tar")]) != 1
                    or len([item for item in members if item.startswith("data.tar")]) != 1
                    or len(members) != 3):
            raise InspectionError("Unexpected Debian archive layout")

    def asar(self, source, name, size, depth):
        self.containers += 1
        prefix = source.read(16)
        if len(prefix) != 16:
            raise InspectionError("Truncated ASAR header")
        pickle_size, header_size, payload_size, json_size = struct.unpack("<IIII", prefix)
        if (pickle_size != 4 or not 8 <= header_size <= 16 * 1024 * 1024
                or payload_size + 4 != header_size or json_size > header_size - 8):
            raise InspectionError("Invalid ASAR header")
        header = json.loads(source.read(json_size), object_pairs_hook=unique_object)
        base = 8 + header_size
        if base > size:
            raise InspectionError("ASAR header exceeds its file")

        def visit(node, relative=""):
            files = node.get("files")
            if not isinstance(files, dict):
                raise InspectionError("Invalid ASAR directory")
            for leaf, entry in files.items():
                component = safe_name(leaf)
                if not component or "/" in component or not isinstance(entry, dict):
                    raise InspectionError("Unsafe ASAR member")
                child_relative = f"{relative}/{component}".lstrip("/")
                child = name + "!" + child_relative
                if "files" in entry:
                    visit(entry, child_relative)
                elif "link" in entry:
                    safe_name(entry["link"])
                    self.link(entry["link"], child, hard=True)
                elif entry.get("unpacked"):
                    self.unpacked.add(name + ".unpacked/" + child_relative)
                else:
                    offset, length = int(entry["offset"]), int(entry["size"])
                    if offset < 0 or length < 0 or base + offset + length > size:
                        raise InspectionError("ASAR member exceeds its file")
                    source.seek(base + offset)
                    data = source.read(length)
                    self.inspect(io.BytesIO(data), child, length, depth + 1)
        visit(header)

    def finish_archives(self):
        missing = sorted(self.unpacked - self.seen)
        if not missing:
            return []
        contract = json.loads((ROOT / "scripts/publication-pruned-files.json").read_text(),
                              object_pairs_hook=unique_object)
        if (contract.get("schemaVersion") != 1
                or contract.get("architecture") != "amd64"
                or contract.get("asar") != "opt/Paseo/resources/app.asar"
                or contract.get("source") != "packages/desktop/scripts/after-pack.js"
                or digest(ROOT / contract["source"]) != contract.get("sourceSha256")
                or not isinstance(contract.get("entries"), list)
                or len(contract["entries"]) != 15
                or len(set(contract["entries"])) != 15):
            raise InspectionError("Reviewed optional-file pruning contract changed")
        reviewed = []
        for name in missing:
            match = re.fullmatch(r"(.+\.deb)!data\.tar(?:\.[^!]+)?!" +
                                 re.escape(contract["asar"]) + r"\.unpacked/(.+)", name)
            if (not match or self.package_architectures.get(match[1]) != contract["architecture"]
                    or match[2] not in contract["entries"]):
                raise InspectionError("Unexpected ASAR unpacked content is missing from the inspected payload")
            reviewed.append({"path": name, "reason": contract["reason"]})
        return reviewed

    def scan(self):
        if not self.records:
            return
        cpus = scanner_cpus()
        config = ROOT / ".gitleaks.toml"
        # Raw scanner JSON exists only in this subprocess pipe/memory. Disable
        # Docker logging too. Hash actual matched secrets before discarding them;
        # decoded findings cannot be reconstructed from source line coordinates.
        command = ["docker", "run", "--rm", "--network", "none", "--read-only",
                   "--log-driver", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                   "--cpus", str(cpus), "--env", f"GOMAXPROCS={cpus}",
                   "--user", f"{os.getuid()}:{os.getgid()}", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
                   "--mount", f"type=bind,src={self.directory},dst=/scan,readonly",
                   "--mount", f"type=bind,src={config},dst=/config.toml,readonly", SCANNER,
                   "dir", "/scan", "--config", "/config.toml", "--redact=0", "--no-banner",
                   "--log-level=error", "--ignore-gitleaks-allow", "--gitleaks-ignore-path=/tmp",
                   "--max-target-megabytes=0", "--max-archive-depth=0", "--report-format=json",
                   "--report-path=/dev/stdout", "--exit-code=42"]
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode not in (0, 42):
            raise InspectionError(f"Pinned secret scanner failed (exit {result.returncode})")
        raw_findings = json.loads(result.stdout)
        if not isinstance(raw_findings, list) or (result.returncode == 42 and not raw_findings):
            raise InspectionError("Pinned secret scanner returned an invalid report")
        findings = []
        for finding in raw_findings:
            filename = Path(finding["File"]).name
            if not re.fullmatch(r"[0-9]{8}\.txt", filename):
                raise InspectionError("Scanner returned an unexpected input path")
            number = int(filename[:-4])
            if not 0 <= number < len(self.records):
                raise InspectionError("Scanner returned an unknown input")
            secret = finding.get("Secret")
            fingerprint = hashlib.sha256(secret.encode()).hexdigest() if secret else None
            findings.append({"record": number, "rule": finding["RuleID"],
                             "line": finding.get("StartLine"), "fingerprint": fingerprint})
        del raw_findings, result
        for finding in findings:
            if finding["fingerprint"] and any(
                    other["fingerprint"] == finding["fingerprint"]
                    and other["rule"] == finding["rule"]
                    and finding["record"] in self.records[other["record"]]["ancestors"]
                    for other in findings):
                self.duplicate_container_findings += 1
                continue
            self.finding(self.records[finding["record"]], finding["rule"], finding["line"])


def forbidden_name(name):
    # Archive boundary markers separate virtual roots; no paths are materialized.
    parts = re.split(r"[/!]", name)
    leaf = parts[-1]
    if leaf.startswith(".env") and leaf not in TEMPLATES:
        return True
    if leaf.endswith((".pem", ".key", ".p12", ".pfx")):
        # Public certificate material is scanned for private-key content instead.
        return not leaf.endswith(".pem")
    return (any(part in {".secrets", ".paseo", ".git", "playwright-report"} for part in parts)
            or "/.codex/auth.json" in "/" + name
            or "/playwright/.auth/" in "/" + name)


def collect_git(inspector, repository, mode):
    repository = Path(repository).resolve()
    if mode == "history":
        if git(repository, "rev-parse", "--is-shallow-repository").strip() != b"false":
            raise InspectionError("History inspection requires a complete clone")
        objects = []
        for line in git(repository, "rev-list", "--objects", "--all").splitlines():
            oid, _, name = line.partition(b" ")
            objects.append((oid.decode(), name.decode(errors="replace")))
        checks = git(repository, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)",
                     data="".join(oid + "\n" for oid, _ in objects).encode()).splitlines()
        entries = [(oid, name or oid, int(check.split()[2]))
                   for (oid, name), check in zip(objects, checks, strict=True)
                   if check.split()[1] == b"blob"]
    else:
        changed = None
        if mode == "staged":
            changed = set(git(repository, "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").split(b"\0"))
        entries = []
        for entry in git(repository, "ls-files", "--stage", "-z").split(b"\0"):
            if not entry:
                continue
            metadata, filename = entry.split(b"\t", 1)
            filemode, oid, stage = metadata.split()
            if stage != b"0" or filemode == b"160000":
                raise InspectionError("Resolve index conflicts/submodules before publication inspection")
            if changed is not None and filename not in changed:
                continue
            size = int(git(repository, "cat-file", "-s", oid.decode()))
            entries.append((oid.decode(), filename.decode(errors="replace"), size))
    process = subprocess.Popen(["git", "-C", str(repository), "cat-file", "--batch"],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        for oid, name, size in entries:
            process.stdin.write((oid + "\n").encode())
            process.stdin.flush()
            actual = process.stdout.readline().split()
            if actual != [oid.encode(), b"blob", str(size).encode()]:
                raise InspectionError("Git object changed while inspecting it")
            if size > MAX_FILE:
                raise InspectionError("Git blob exceeds the inspection limit")
            data = process.stdout.read(size)
            if len(data) != size:
                raise InspectionError("Truncated Git object")
            start = len(inspector.records)
            inspector.inspect(io.BytesIO(data), name, size)
            for record in inspector.records[start:]:
                record["gitObject"] = oid
            if process.stdout.read(1) != b"\n":
                raise InspectionError("Truncated Git object")
        process.stdin.close()
        if process.wait() != 0:
            raise InspectionError("Git object inspection failed")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


def collect_directory(inspector, directory):
    directory = Path(directory).resolve()
    if not directory.is_dir():
        raise InspectionError("Inspection directory does not exist")
    for parent, folders, files in os.walk(directory, followlinks=False):
        for leaf in sorted(folders + files):
            path = Path(parent) / leaf
            relative = path.relative_to(directory).as_posix()
            if path.is_symlink():
                inspector.link(os.readlink(path), relative)
            elif path.is_file():
                inspector.inspect_file(path, "package.deb" if relative.endswith(".deb") else relative)
            elif not path.is_dir():
                raise InspectionError("Unsupported filesystem input")


def collect_release(inspector, directory):
    directory = Path(directory).resolve()
    names = sorted(item.name for item in directory.iterdir())
    packages = [name for name in names if re.fullmatch(r"Paseo-\d+\.\d+\.\d+-workstation\.[1-9]\d*-amd64\.deb", name)]
    if len(packages) != 1 or set(names) != {packages[0], "paseo-fork-builder.tar.gz", "provenance.json", "SHA256SUMS"}:
        raise InspectionError("Release directory must contain exactly the four reviewed assets")
    sums = {}
    for line in regular(directory / "SHA256SUMS").read_text().splitlines():
        match = re.fullmatch(r"([a-f0-9]{64})  ([A-Za-z0-9_.-]+)", line)
        if not match or match[2] in sums:
            raise InspectionError("Invalid release checksum inventory")
        sums[match[2]] = match[1]
    if set(sums) != set(names) - {"SHA256SUMS"}:
        raise InspectionError("Release checksum inventory is incomplete")
    for name, expected in sums.items():
        if digest(directory / name) != expected:
            raise InspectionError("Release asset checksum differs")
    provenance = json.loads(regular(directory / "provenance.json").read_text())
    if provenance.get("file") != packages[0] or provenance.get("sha256") != sums[packages[0]]:
        raise InspectionError("Release provenance disagrees with its package")
    sums["SHA256SUMS"] = digest(directory / "SHA256SUMS")
    collect_directory(inspector, directory)
    return sums


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["staged", "snapshot", "history", "package", "release", "directory"])
    parser.add_argument("--repository", default=str(ROOT))
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--file")
    parser.add_argument("--directory")
    default_policy = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "paseo/publication-policy.json"
    parser.add_argument("--policy", default=os.environ.get("PASEO_PUBLICATION_POLICY") or
                        (str(default_policy) if default_policy.exists() else None))
    parser.add_argument("--report")
    args = parser.parse_args()
    report = {"schemaVersion": 1, "mode": args.mode, "ok": False, "scannerImage": SCANNER,
              "findings": []}
    try:
        report["inspectionInputs"] = {name: digest(ROOT / name) for name in INSPECTION_FILES}
        allowances = checked_allow(json.loads((ROOT / "scripts/publication-exceptions.json").read_text()))
        policy = read_policy(args.policy)
        if args.policy:
            report["privatePolicySha256"] = digest(args.policy)
        if args.mode == "history" and not args.all:
            raise InspectionError("History inspection requires explicit --all")
        with tempfile.TemporaryDirectory(prefix="paseo-publication-") as temporary:
            inspector = Inspector(Path(temporary) / "content", policy, allowances)
            if args.mode in {"staged", "snapshot", "history"}:
                collect_git(inspector, args.repository, args.mode)
            elif args.mode == "package":
                if not args.file:
                    raise InspectionError("Package inspection requires --file")
                report["sha256"] = digest(args.file)
                inspector.inspect_file(args.file, "package.deb")
                if digest(args.file) != report["sha256"]:
                    raise InspectionError("Package changed during inspection")
            elif args.mode == "release":
                if not args.directory:
                    raise InspectionError("Release inspection requires --directory")
                report["assets"] = collect_release(inspector, args.directory)
            else:
                if not args.directory:
                    raise InspectionError("Directory inspection requires --directory")
                collect_directory(inspector, args.directory)
            report["reviewedPrunedEntries"] = inspector.finish_archives()
            inspector.scan()
            if args.mode == "package" and digest(args.file) != report["sha256"]:
                raise InspectionError("Package changed during inspection")
            if args.mode == "release":
                if set(path.name for path in Path(args.directory).iterdir()) != set(report["assets"]):
                    raise InspectionError("Release asset inventory changed during inspection")
                after = {name: digest(Path(args.directory) / name) for name in report["assets"]}
                if after != report["assets"]:
                    raise InspectionError("Release assets changed during inspection")
            report.update(filesScanned=len(inspector.records), bytesScanned=inspector.total,
                          archivesInspected=inspector.containers, findings=inspector.findings,
                          duplicateContainerFindings=inspector.duplicate_container_findings)
            if report["inspectionInputs"] != {name: digest(ROOT / name) for name in INSPECTION_FILES}:
                raise InspectionError("Publication inspection inputs changed during the scan")
            report["ok"] = not inspector.findings
    except (InspectionError, OSError, ValueError, KeyError, TypeError, EOFError, tarfile.TarError, zipfile.BadZipFile) as error:
        # Only our fixed diagnostic messages are emitted. Parser/system exceptions
        # can contain source data, so retain their type without their text.
        report["error"] = str(error) if isinstance(error, InspectionError) else type(error).__name__
    if args.report:
        destination = Path(args.report)
        if not destination.is_absolute() or destination.exists() or destination.is_symlink():
            print("Publication report must be a new absolute path", file=sys.stderr)
            return 2
        with destination.open("x") as output:
            os.chmod(destination, 0o600)
            json.dump(report, output, indent=2)
            output.write("\n")
    print(json.dumps(report))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
