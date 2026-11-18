// Broad prefixes first, specific prefixes last: rustc uses the last matching map.
export function compilerPolicy({ home, root, source }) {
  const maps = [
    [home, '/toolchain-home'],
    [`${home}/.cargo/registry`, '/cargo/registry'],
    [`${home}/.cargo/git`, '/cargo/git'],
    [root, '/build/codex'],
    [`${root}/cargo-home/registry`, '/cargo/registry'],
    [`${root}/cargo-home/git`, '/cargo/git'],
    [source, '/src/codex'],
  ];
  const native = maps.map(([from,to]) => `-ffile-prefix-map=${from}=${to}`).join(' ');
  return { schema: 1, maps, env: {
    RUSTFLAGS: maps.map(([from,to]) => `--remap-path-prefix=${from}=${to}`).join(' ') + ' -C debuginfo=0 -C split-debuginfo=off',
    CFLAGS: native, CXXFLAGS: native,
    CARGO_PROFILE_RELEASE_OPT_LEVEL: 'z', CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '1',
    CARGO_PROFILE_RELEASE_DEBUG: '0', CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO: 'off',
    CARGO_PROFILE_RELEASE_STRIP: 'none', CARGO_PROFILE_DEV_DEBUG: '0', CARGO_PROFILE_TEST_DEBUG: '0',
  }};
}
