# Unofficial modification notice

Modified by the fork maintainer: Page Up/Down steps in `codex-rs/tui/src/pager_overlay.rs` and two sites in `codex-rs/tui/src/transcript_view/input.rs` use 40% of viewport height, minimum one row. Half-page behavior is unchanged. The authoritative patch is the byte-identical `fork/patches/0001-scroll-40-percent.patch`; no provenance header has been added to those bytes.

This staged maintenance kit is unofficial and not endorsed by OpenAI. This notice identifies modifications for Apache-2.0 section 4(b); it does not replace the upstream LICENSE or NOTICE. LICENSE and NOTICE are copied from the exact pinned upstream source; release staging includes those actual notices.

Owner-selected patch `0005-official-v8-without-sandbox.patch` uses the official pointer-compressed V8 prebuilt without V8 heap-sandbox containment. It changes the code-mode-runtime Cargo feature request, removes its UI startup sandbox requirement, and replaces the linked-sandbox assertion with a linked-engine initialization test. This weakens containment for V8 memory-corruption bugs. The candidate manifest must explicitly pin this patch and its matching native asset hashes; this staged manifest enables it.

Modified by the fork maintainer in 0.167.1-p4:
`codex-rs/tui/src/bottom_pane/chat_composer.rs` binds Alt+U to whole-draft clear
with local history recovery and adds four behavior tests. Maintenance tooling
requires these tests and finds draft releases through a paginated release list.

Release 0.167.1-p4: maintenance publisher uses compatible paginated draft discovery and exact-input publication checks. Upstream runtime source and patches remain pinned.
