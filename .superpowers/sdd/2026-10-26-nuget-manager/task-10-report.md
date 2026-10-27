# Task 10 report

Implemented src/panel/{protocol,controller,NugetPanel,PanelManager}.ts and test/unit/panel/controller.test.ts (6 tests).

## TDD
RED: `npm run test:unit -- test/unit/panel` -> "Test Files 1 failed (1) / Tests no tests" (src/panel/controller missing).
GREEN: `controller.test.ts (6 tests)`, 6 passed. Full suite: 16 files, 106 tests passed. `npx tsc --noEmit` clean, `npm run build` OK.

## Self-review
- protocol.ts uses `import type` only.
- busy flag is set during load and run; watcher ignores while busy.
- Load failure: busy{null} then error{canOpenOutput:true}; unconfirmed installed stays.
- Failed op order: busy(label) -> busy(null) -> error (no opResult on failure).
- Source-mapping hint falls back to "your nuget.config" when configPaths fails.
- Concerns: esbuild entry is only extension.ts, so panel files are verified by tsc only until wired in (later task). PanelManager constructor takes (extensionUri, cli, openOutput, getTargets).

## Fix round 1
- run while busy now posts opResult{ok:false,'Another operation is in progress.'}; busy is a loads counter plus a running flag.
- PanelManager tracks in-flight opens per target.path (`opening` set).
- Added 2 tests (run during load; overlapping loads). Panel tests, full suite, tsc, build all pass.
