# Standalone fixture copies

Each source and destination below is byte-identical in the staged repair.

| Source | Destination | SHA256 |
| --- | --- | --- |
| p2/v2-r2-behavior-resume/green-01/command.stdout | accepted-green.txt | 5e45de05e3fabf2c9e0c080a10f54589fe7c2afa236909656872e48552a57873 |
| astra-fix-20261117-attempt-01/build/fixtures/make-tarballs.mjs | make-tarballs.mjs | 3c9fa4a4c353a435d98a448d19b6073b9bbc30d620989883d41bd7e1135bae19 |
| astra-fix-20261117-attempt-01/build/fixtures/make-upstream.mjs | make-upstream.mjs | d0b77c6344bb2df082b5edc9ca33e41d3abe56e28362b4b93f9256cc9f89cbab |
| astra-fix-20261117-attempt-01/build/fixtures/releases/stable.json | releases/stable.json | 1c7d642bc977f3b0a1695ab93b23747431b0c87508caba3d2c459c83d8d519b3 |
| astra-fix-20261117-attempt-01/build/fixtures/upstream-src/codex-rs/tui/src/pager_overlay.rs | upstream-src/codex-rs/tui/src/pager_overlay.rs | a60808d3eb2591ad3090a08e53df5d75d5a8330568729b5d868ef57355f526f1 |
| astra-fix-20261117-attempt-01/build/fixtures/upstream-src/codex-rs/tui/src/transcript_view/input.rs | upstream-src/codex-rs/tui/src/transcript_view/input.rs | 222abe0a0dfea3561ea9b20211d16881fedc46c9ce21ecfb1df049b73fdea36b |
| astra-fix-20261117-attempt-01/build/fixtures/upstream-src/package.json | upstream-src/package.json | e73e5306305956f3acde16a84944a498828f10c15486966a4acd9166ec9b3a88 |

The accepted-green file is historical host output, not a new Rust execution.
No runtime imports cross the fork boundary. The helper owns and archives only
unique test children. The shared templates remain synthetic, not real Rust APIs.
The workflow policy implementation in fork/lib and build/tools is also an exact
copy, maintained here so standalone tests require no parent-plan imports.
