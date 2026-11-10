// Git for Windows' folder layout, shared by the main process (src/main/gitTool.ts) and the unit tests' setup
// (tests/directGit.ts, HI-2812), which must agree on where the real git is. No imports: the tests' setup loads it in every worker.

/**
 * Where Git for Windows keeps the real git, under its root: `git --exec-path` is `<root>/<this>/libexec/git-core`, and
 * git.exe is in `<root>\<this>\bin` too. Its launcher puts that bin folder first on PATH and sets MSYSTEM to this
 * upper-cased (`ucrt64`: Git for Windows 2.56's UCRT64 build, HI-2400).
 */
export const GIT_MINGW_DIRS = ['mingw64', 'ucrt64', 'clangarm64', 'mingw32'] as const
