# Changelog

## [0.6.1](https://github.com/tyroneross/bookmark/compare/bookmark-v0.6.0...bookmark-v0.6.1) (2026-10-29)


### Bug Fixes

* **mcp:** report the package.json version instead of a hard-coded 0.3.2 ([660a221](https://github.com/tyroneross/bookmark/commit/660a2219837cc44f245596ea6383a6a41dc1c8eb))
* **plugin:** run the committed bundle so GitHub plugin installs work without npm ([3562c1d](https://github.com/tyroneross/bookmark/commit/3562c1d1512d149358727a9400e99295e7f91e47))

## [0.6.0](https://github.com/tyroneross/bookmark/compare/bookmark-v0.5.0...bookmark-v0.6.0) (2026-10-29)


### Features

* **hosts:** run Bookmark's hooks on Codex, Gemini CLI and Copilot CLI through one host adapter ([e628ccf](https://github.com/tyroneross/bookmark/commit/e628ccf5e72db48c7d1cd6d5a1b1fd35b8f78d45))
* **usage:** measure Codex sessions from rollout token_count events ([9aafd29](https://github.com/tyroneross/bookmark/commit/9aafd297fc1c77ac5ba91d858e744d1c6cca601b))


### Bug Fixes

* **hooks:** resolve storage for restore, context-check and precompact like stop ([ef74288](https://github.com/tyroneross/bookmark/commit/ef74288fd4060a7d8c9944334892595f6ae9339e))
* **hosts:** detect Copilot compat payloads correctly, keep Copilot protected without a limit, frame restored notes as data ([86c5274](https://github.com/tyroneross/bookmark/commit/86c5274413201d49c4b5ef05393007162d74e988))
* **install:** leave look-alike user hooks alone, run the local build from a checkout, keep backups out of dotfile repos ([81f9865](https://github.com/tyroneross/bookmark/commit/81f9865e617635bdd2f4e917ce6748c83dfc578c))
* **install:** merge only Bookmark's own hook handlers, keep file modes, refuse malformed configs ([ce0a92d](https://github.com/tyroneross/bookmark/commit/ce0a92d0f9a57bf902e4d919861da291a83014f9))
* **stop:** block only near the context limit, never bootstrap storage from a turn end ([ad0d6c9](https://github.com/tyroneross/bookmark/commit/ad0d6c930a69ad9a303a73998a121608ba9c0139))

## [0.5.0](https://github.com/tyroneross/bookmark/compare/bookmark-v0.4.0...bookmark-v0.5.0) (2026-10-05)


### Features

* **handoff:** give each session its own verifiable handoff so concurrent sessions resume the right one ([2ced09d](https://github.com/tyroneross/bookmark/commit/2ced09da2590aee89b21b5035442c6d18f568a43))

## [0.4.0](https://github.com/tyroneross/bookmark/compare/bookmark-v0.3.2...bookmark-v0.4.0) (2026-09-07)


### Features

* **release:** detect a stalled cadence and a registry that never got the release ([dd7a06e](https://github.com/tyroneross/bookmark/commit/dd7a06e8d2184f8490060243027ff1bce966e1d5))
