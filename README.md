# Unofficial Codex fork maintenance kit

Not affiliated with OpenAI. Node 24, git and tar are required. Builds also need
the pinned Rust toolchain, Cargo cache and matching V8 native assets. Nothing in
this kit automatically changes the owner's launcher or publishes a release.

The historical source pin is rust-v0.167.1,
0a94398fa60c4fac0e7659e4213a0a36e613dd46, Rust 1.95.0. The staged manifest
pins the validated workspace lock and native assets; its exact-input rebuild
passed locally. Current stable has not been queried
by this offline repair. LICENSE/NOTICE are copied from the pinned upstream
source; release staging copies and verifies the same admitted notices.

Changed upstream files are pager_overlay.rs, transcript_view/input.rs,
transcript_view/input_tests.rs, code-mode-runtime/Cargo.toml,
code-mode-runtime/src/ui/mod.rs, code-mode-runtime/src/runtime/mod.rs and
bottom_pane/chat_composer.rs.
Owner option B uses the official pointer-compressed V8 prebuilt without its heap
sandbox; this weakens containment for V8 memory-corruption bugs. The manifest pins
the source patch and both official native assets. Full-page movement is max(1, height * 2 / 5);
half-page and line movement remain unchanged. 0001 is byte-identical to its
original SHA256 555a8ab95a01cc2dc3bee177fb860499cf8b177d1552e611e21228dc6877e6e1.
Historical genuine red/green C02 evidence is retained. Composer-height changes
and Pi work remain separate features. Terminal C03 and independent T3 remain separate
acceptance gates; library probe fixtures cannot prove actual terminal motion.

## Local build and package

`node fork/bin/forkctl.mjs --help` lists local interfaces. No network adapter is
created by this CLI. Prepare archives exact objects and applies patches strictly;
it never modifies its source repository. Builds accept only the prepared archive
and verified provenance, with separate candidate and compilation locks.

Build requires --local --offline --state DIR --source DIR and the exact prepared
manifest. The default storage parent is this kit's .work. A private host driver
can explicitly select an already admitted project storageBase; do not copy a
large source/cache/target merely to bypass a sandbox. The build defaults to four Cargo
jobs (explicit range 1–16), private HOME/cache, remapped paths, aggregate deadlines and a separate
process-group supervisor. Uncertain cleanup retains both diagnostic locks.
Never reclaim a lock based only on process absence in a sandbox. A host owner
must verify the recorded PID/start/boot/group identities before archiving it.

Cargo --offline does not constrain native build scripts. RUSTY_V8_ARCHIVE always
points at the local state cargo-home/native-v8 directory, which disables this
pinned V8 source's remote fallback. Supply its exact binding and static library
there. CI additionally pins both URLs/hashes in native_assets and records their
hashes in build receipts. A missing native asset is a prerequisite, not permission
to fetch during an offline host build.

Finalization appends an immutable manifest revision after a validated workspace-
only lock refresh. If native assets were supplied after preparation, pass their
public pins through finalize --native-pins FILE; they must match that validated
native inventory exactly. Rebuild that exact revision before release packaging. Package
binds the candidate, manifest/lock, validated receipt and three frozen binaries.
It refuses synthetic runners for real releases. Fixture packages are explicitly
non-release. Staging accepts only the fixed file list, and privacy scanning also
covers tests and filenames. Private build logs are not release artifacts.

## Install and rollback

Adopt the original root containing bin/codex with `adopt-original --home DIR
--directory ROOT --version X.Y.Z-original`. The original is referenced and hashed,
never copied or edited. Test installs use explicit --fixture and throwaway HOME.
Real library installation requires an authenticated exact-artifact verification
and a trusted behavioral probe. The ordinary CLI does not accept unsigned JSON
or a checksum as release authorization.

installRelease in fork/lib/artifact.mjs connects release selection/download,
checksum validation, GitHub attestation verification, safe extraction, isolated
smoke/probe and activation. Its default verifier requires a modern gh supporting
attestation verify, constrained to the fork, signer workflow and source digest.
There is no checksum-only fallback. The owner supplies a real synchronous probe
that runs the staged binary with isolated HOME/CODEX_HOME and returns its hash
plus pager24/transcript24=9 and pager60/transcript60=24. Test callbacks are only
fixture evidence. No fake built-in patch-probe flag is invented.

Extraction validates the complete bounded gzip/ustar before writing: exact names,
checksums, target, helpers, no links or special entries. Version directories are
fresh. Activation uses atomic symlinks and refuses unmanaged launchers or redirected
bin directories. A pre-switch journal recovers with the original active and the
verified new version retained; select it explicitly with rollback --version.
Post-switch recovery completes the recorded activation. Running old processes
keep their original bytes. Retained execution requires --isolated. status/list,
rollback and recover are local operations; no real-HOME installation is implied.

## GitHub and CI integration

All live operations remain P4 owner actions. githubTransport requires an explicit
repository, authenticated request adapter and approval/signature adapters; it
never reads credentials or defaults to global fetch. githubRequest constrains
origins, response sizes and redirects; no token is forwarded to the asset CDN.

submitPackagedCandidate admits only an exact host-built non-fixture package. The
async PR transport starts after the local lock releases. It creates only an
update/key branch and one PR, requires approval of the exact remote commit before
ref mutation, rechecks existing branches, and never force-updates history. The
review payload includes the manifest/input, patchset, artifact and receipt hashes.
A draft requires the exact merged PR/commit, matching rebuilt artifact, owner review
and authenticated attestation. Existing tags/releases/assets are never overwritten;
partial upload recovery is an explicit owner action. Publishing revalidates exact
review/artifact/fresh-VM identities and authentication before changing draft=false.

The CI entry point is `node fork/lib/ci.mjs discover|candidate|release`, restricted
to an explicit Actions context. Candidate CI resolves stable upstream, checks
retained candidate history for moved tags/dedupe, prepares clean source, validates
workspace-only online cache preparation, then compiles/tests offline. It finalizes
and rebuilds exact inputs before packaging. Release CI rebuilds the merged pin and
requires the candidate's artifact hash to match. Raw private build logs stay on
that runner. P85_NATIVE_ASSETS is the owner's two-entry JSON array of name/url/sha256
pins; release builds use the reviewed manifest pins instead of mutable variables.

Both workflows have read-only contents permissions for builds. The release's
separate owner-environment job downloads only the originating run's fixed artifact
and invokes the pinned official attestation action; it executes no checked-out
code. SHA placeholders must be resolved in P4. Configure the environment to allow
only fork and require owner review. Automatic branch/PR/draft writes stay disabled
until an equivalent public commit/push guard adapter is supplied, as BUILD.md
requires; the default outputs validated artifacts for the owner transport. This
fallback is intentional and is not proof of unattended PR creation or live CI.

## Validation limits

Run `node --test tests/` and the standalone import-boundary variant. Shared fixtures
are copied into tests/support with recorded hashes, not imported across projects.
Temporary test children are archived. Source pin, real binaries, C03, packaging
capacity, authenticated CI, permitted VM, publication and real installation require
their own evidence. A fixture PASS never grants release approval. An independent
T3 review must cover installer, extraction and workflow permissions before rollout.

The R5 staged host validation rebuilt all three binaries with Rust/native path maps, size optimization and deterministic receipt-bound stripping. The package passes the unchanged 128 MiB compressed / 512 MiB expanded gates and the owner-blocklist privacy check. Final binaries pass runtime smokes and real PTY paging; 11 linked runtime tests pass. The archive is 97,804,047 bytes, SHA256 `6e977b16a28437e05071b8d76884d3a812e6ca80be6ae04ea652d38f87928d7b`. R5 REPORT.md and its JSON receipts contain the exact host evidence. Publication, fresh-VM validation and real installation remain owner steps.

Before staging release binaries, run `node fork/bin/forkctl.mjs strip --state DIR --attempt UUID`; copy the exact paths from that attempt's STRIP.json. Host packaging requires its hash-bound strip receipt. Raw build artifacts are retained and cannot be substituted for final stripped outputs. CI staging uses the same stage.

`fork/privacy-literals.json` holds 17 exact exceptions for this host build, with source proofs in `fork/privacy-literal-proofs.json`. Patterns and size limits are unchanged. Every exception binds a complete binary hash, filename, offset, match length and digest, plus the proof digest; the one public CLI type-name false positive also binds the private regex hash. Unknown binaries or matches fail closed. Do not automatically regenerate exceptions for a new upstream version or a different build. No credential values are stored in either file.

Local artifact installation now accepts an explicit --local-evidence receipt for a package selected by the owner. It binds the complete archive SHA256 and the tested binary SHA256 plus all four paging results. This records local-only authorization and does not assert a publisher attestation.

The staged owner publication CLI is:

```
node fork/bin/forkctl.mjs publish --evidence OWNER_EVIDENCE.json
```

It requires exact HEAD approval through commit-review, a fresh Linux container record bound to HEAD and the committed artifact hash, a matching remote tag, immutable releases enabled, unchanged draft assets/checksums/manifest, and the public-scope guard. It re-downloads draft assets before publication. No automatic approvals or bot pushes are enabled. GNU runtime prerequisites include libssl3t64, libbz2-1.0, zlib1g and libzstd1.


### 0.167.1-p3: clear the composer with Alt+U

Press **Alt+U** once to clear the whole chat composer, at any cursor position.
This also clears attachments and pending paste payloads. The cleared draft stays
in local input history for recovery with Up. It does not send a message or
interrupt a running turn. Ctrl+U keeps its existing line-start deletion behavior.
Terminals must deliver Alt+U (usually Escape followed by `u`); desktop shortcuts
that intercept it take precedence.

The patch queue adds `0006-composer-alt-u-clear.patch` and
`0007-composer-alt-u-clear-tests.patch`, modifying
`codex-rs/tui/src/bottom_pane/chat_composer.rs`. The local/CI build requires all
four `alt_u_` behavior tests as well as the existing scroll tests. The maintenance
kit also fixes draft lookup during publication by listing every releases page
before selecting the exact tag. Publication guards remain required.
