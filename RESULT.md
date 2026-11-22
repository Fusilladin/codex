# Daily CI toolchain fix

Status: local fix and tests passed. No push was made.

The November 21 candidate failed because the merged manifest pins Rust 1.95.0 but upstream rust-v0.171.0 pins 1.99.1. Discovery now reads the toolchain at the resolved upstream commit and includes it in candidate identity. The scheduled workflow installs that version, and candidate preparation checks the checkout against discovery before recording it in the candidate manifest. The existing source-provenance check still verifies the prepared archive against that manifest. The merged release manifest remains pinned to its own toolchain.

Validation: `node --test tests/ci.test.mjs tests/workflow.test.mjs` passed (6 tests); `node --test tests/` passed (66 tests); `git diff --check` passed. A full candidate build was not run locally; the CI build and packaging outcome remains unverified.

Assumptions:
- Stable upstream Rust versions are expressed as a single numeric `channel` in `codex-rs/rust-toolchain.toml`; unsupported or ambiguous pins fail closed.
- The current CI native asset configuration remains appropriate; the reported failure did not test later build steps.

The sandbox makes the original checkout's `.git` read-only. The local commit is therefore on branch `fork` in `/tmp/codex-ci-fix`; the working files and this report also remain in the original checkout. To push that commit after the required commit-review approval, run:

```sh
cd /tmp/codex-ci-fix
git push https://github.com/Fusilladin/codex.git fork:fork
```
