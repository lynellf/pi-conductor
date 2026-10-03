# Release preparation — v0.23.0

## Scope and decisions

- Minor release for progressive enhancement (#167), plus cutoff provenance
  (#155, #171) and Linux lineage/subreaper fixes (#157, #170).
- Baseline: merged `main` at `7c3598b1a289cec6f2e88fb16ff9742cd852b0f4`.
  Preparation changes metadata/documentation only; no dependency or runtime changes.
- The overseer will build and publish from a Linux VM. This checklist targets
  Linux x64, matching CI. Stop if the VM has a different architecture.
- Do not publish, create/push a release tag, or create a hosted release as part of
  preparation. #166 remains parked.
- The native binary is build-platform-specific. `files` ships `dist/`, but not
  `native/` or `scripts/`; installed packages cannot rebuild this helper. Do not
  publish a macOS-built tarball or claim multi-platform native support. Other
  architectures, libc combinations, full macOS/Windows acceptance, and protected
  workspace portability remain unverified. Missing bindings retain warnings and
  conservative lineage checks, never an enhanced-runtime downgrade to baseline.

## Preparation gates

- [x] Confirm npm `latest` is `0.22.1` and choose `0.23.0`.
- [x] Observe combined-main Linux acceptance: run 1018, job 1022, **4,585 tests /
  440 files passed**, including all five child-subreaper tests and real activation.
- [x] Bump `package.json` and add dated release/compatibility notes.
- [x] Document Linux artifact/native validation and separate publication steps.
- [x] Run local quality commands and portable package/CLI checks (results below).
- [x] Inspect a versioned package preview and review the preparation diff.
- [x] Confirm Linux CI for release metadata candidate
  `f0ace5b80ef669d25438cec57cdb30e94ef6f87d`: run 1020, job 1024,
  **4,585 tests / 440 files passed** with frozen install, lint/typecheck,
  unprivileged full tests, and all five child-subreaper tests (including real activation).
  The acceptance-record update changes only this unshipped plan; package/runtime
  bytes are unchanged. The publisher-owned gate still requires passing CI on the
  final PR head and the merged release commit.

### Evidence limits and retained findings

Run 1017 at the same baseline SHA recorded a failure in
`controller-local-effect-runtime.test.ts` — “keeps settlement unconfirmed while an
unmarked same-session child remains” — before hitting the ten-minute job deadline.
The log lacks the final assertion diff; the cause is not classified. Run 1018 at
that SHA passed without a source change. This is not proof that the earlier failure
was harmless or fixed. Retain the failure and stop if it recurs in release checks.

Baseline lint exits successfully with an existing unused `childSubreaperState`
import warning in `supervised-process-identity.ts`; preparation does not remove it.
Local macOS preparation used Node **25.6.0** / pnpm **10.32.1**: typecheck,
build, lint and format commands exited zero; production audit found no known
vulnerabilities. pnpm warned that the local installation fingerprint was stale
following the version change; no dependency/lockfile graph was changed. Frozen
install validation on the pinned Linux toolchain remains authoritative.

Package metadata (13), grep guard (4), packed portable extension (1), and packed
CLI (13): **31 passed**. Separately, `packed-file-tools.test.ts` failed with
`admission_origin_unavailable`: its probe constructs `ToolExecutionController`
directly, requiring Linux procfs rather than selecting baseline. No skip or
fixture change was added. This does not establish full macOS acceptance.

The macOS `0.23.0` preview contains **2,807 files** (2.7 MB compressed / 13.1 MB
unpacked), expected entrypoints/source/assets, no native addon, and no forbidden
paths or credential filenames in the inspected listing. Its tarball publish dry
run succeeded without publication. This is a metadata/package-layout preview,
**not the Linux artifact to publish** and not Linux native delivery evidence.

## Publisher-owned gates (Linux VM)

- [ ] Merge reviewed metadata after its Linux CI passes; record the exact merged
  release SHA. Use that clean `main` checkout, not an older feature branch.
- [ ] Build with Node **22.19.0**, pnpm **10.33.1**, an existing C compiler, and
  matching Node headers. A successful build exit alone does not prove native support.
- [ ] Pass all quality/full-test gates as a non-root user, without test skips,
  permission-check relaxation, shared-cache mutation, or hook bypasses.
- [ ] Inspect/load the helper from the actual packed artifact, and retain its SHA
  and integrity hash. Run packed extension/CLI coverage in the full suite.
- [ ] Review the publish dry run and deliberately authorize publication.
- [ ] Verify registry metadata/integrity and smoke-test the registry-installed
  package in a disposable project. Only then create a tag/hosted release if desired.

### 1. Verify and pack (does not publish)

Start from a fresh checkout on the VM: avoid stale `dist/` binaries. Set `umask 022`
before cloning/installing. Ensure the recorded SHA is the reviewed release commit;
these commands do not select or approve a commit for you. Do not loosen protected
runtime/file checks to make tests pass. Git does not track group-write bits; if an
editor changes job-local tracked modes, repair those per `AGENTS.md` and rerun.

```bash
set -eu
umask 022
test "$(id -u)" -ne 0
test "$(git branch --show-current)" = main
test -z "$(git status --porcelain)"
test "$(node --version)" = v22.19.0
test "$(pnpm --version)" = 10.33.1
node -e 'if(process.platform!=="linux" || process.arch!=="x64" || require("./package.json").version!=="0.23.0") process.exit(1)'
git rev-parse HEAD
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm lint
pnpm format:check
pnpm test
pnpm audit --prod

release_dir=$(mktemp -d)
pnpm pack --pack-destination "$release_dir"
artifact="$release_dir/pi-conductor-0.23.0.tgz"
tar -tzf "$artifact" > "$release_dir/files.txt"
mkdir "$release_dir/unpacked"
tar -xzf "$artifact" -C "$release_dir/unpacked"
export PACKED_ROOT="$release_dir/unpacked/package"
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.PACKED_ROOT;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
assert.equal(pkg.version, '0.23.0');
for (const file of ['dist/index.js', 'dist/index.d.ts', 'dist/bin/conduct.js',
  'extensions/conduct.ts', 'src/host/execution/child-subreaper.ts',
  'dist/native/child-subreaper.node']) assert.ok(existsSync(join(root, file)), file);
const { ensureChildSubreaper } = await import(pathToFileURL(
  join(root, 'dist/host/execution/child-subreaper.js')).href);
const state = ensureChildSubreaper();
assert.equal(state.available, true, state.detail);
assert.equal(state.active, true, state.detail);
console.log(state.detail);
JS
sha512sum "$artifact" > "$release_dir/artifact.sha512"
node -e 'const {readFileSync}=require("node:fs"); const {createHash}=require("node:crypto"); console.log("sha512-"+createHash("sha512").update(readFileSync(process.argv[1])).digest("base64"))' "$artifact" > "$release_dir/artifact.integrity"
```

Review `files.txt`: CLI, extension, TS source, declarations, sandbox resources,
README/license/changelog must be present. Tests, `node_modules`, private run logs,
Git metadata, scratch files, credentials and top-level `native/` / `scripts/`
must not ship.
Check that package exports, peers, engines and repository metadata are unchanged.
Retain the logs, exact Git SHA, file list and both artifact hashes. Packed extension
and CLI tests in `pnpm test` validate test-created packages; the probe above separately
checks the tarball you will actually publish. If anything fails, do not publish.

### 2. Dry run, then publication by the overseer

The [pnpm publish contract](https://pnpm.io/10.x/cli/publish) accepts tarballs and
supports `--dry-run`. Use the verified tarball, not a fresh directory repack. Tarball
publication is not a substitute for the source `prepublishOnly` quality gates:
those were performed explicitly above. Keep registry authentication outside Git.

```bash
pnpm publish "$artifact" --dry-run --access public --publish-branch main \
  --registry https://registry.npmjs.org
```

**Only after all gates pass and you deliberately choose to publish:**

```bash
pnpm publish "$artifact" --access public --publish-branch main \
  --registry https://registry.npmjs.org
pnpm view pi-conductor@0.23.0 version dist.integrity --json \
  --registry https://registry.npmjs.org
pnpm view pi-conductor dist-tags --json --registry https://registry.npmjs.org
```

Require registry integrity to match `artifact.integrity`, and `latest` to point to
`0.23.0`. In a disposable project verify extension discovery, a small ordinary-tool
workflow, capability/degradation records, and strict preflight refusal when required
features are unavailable. Do not reuse production logs or change global Pi settings.
Watch for native-load warnings, unexpected cleanup uncertainty or capability drift.

## Containment if publication reveals a regression

Stop distribution; investigate from retained artifact/logs. With separate approval,
move `latest` back to the previous `0.22.1` using
`pnpm dist-tag add pi-conductor@0.22.1 latest --registry https://registry.npmjs.org`.
That only redirects future installs: it neither undoes installed packages nor makes
new baseline records readable by older hosts. Preserve run logs and inspect partial
effects; never replay commands or downgrade active runs as a rollback shortcut.
Fixes require a new version, not overwriting `0.23.0`.
