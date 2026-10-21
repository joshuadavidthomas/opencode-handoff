# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project attempts to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!--
## [${version}]
### Added - for new features
### Changed - for changes in existing functionality
### Deprecated - for soon-to-be removed features
### Removed - for now removed features
### Fixed - for any bug fixes
### Security - in case of vulnerabilities
[${version}]: https://github.com/joshuadavidthomas/opencode-handoff/releases/tag/v${version}
-->

## [Unreleased]

## [0.6.1]

### Fixed

- Only the TUI showing the source session reviews the handoff draft. TUIs on the same machine share tabs, so another client could claim a draft from a session it only had in a tab. When no TUI is showing the source session, the session starts without review and clients with it in a tab get a "Handoff started" toast.

## [0.6.0]

### Added

- Set the `review` plugin option to `false` to start handoff sessions without the review dialog.

### Changed

- **Breaking:** Ported to the OpenCode v2 plugin API. Requires OpenCode v2.1.2 or later; use v0.5.0 with OpenCode v1. Configure the plugin under `plugins` instead of `plugin`.
- The handoff draft opens in a review dialog instead of the TUI prompt box, which v2 plugins can't fill. Without a TUI showing the source session, the session starts without review. The new session keeps the source session's agent and model.
- Referenced files are attached to the handoff prompt, including `@file` references written in the prompt itself.
- Only the client that has the source session open reviews the draft, so other clients of a shared server are unaffected.
- The package now ships compiled JavaScript from `dist`.

### Fixed

- `/handoff` no longer mangles goals that contain `$&` or other `$` replacement patterns.

### Removed

- Dependencies on `@opencode-ai/plugin`, `@opencode-ai/sdk`, and `zod`.

## [0.5.0]

### Changed 

- Bumped `@opencode-ai/plugin` and `@opencode-ai/sdk` to 1.2.15

## [0.4.1]

### Fixed

- Fixed race condition where handoff prompt text was silently dropped because `appendPrompt` fired before the TUI finished navigating to the new session ([#16](https://github.com/joshuadavidthomas/opencode-handoff/issues/16))

## [0.4.0]

### Changed

- Simplified handoff session creation by removing textarea resize workaround (see [sst/opencode#5983](https://github.com/sst/opencode/pull/5983))
- Updated minimum OpenCode version requirement to 1.0.188

## [0.3.2]

### Changed

- File injection now uses synthetic text parts instead of file parts
- Extracted OpenCode-compatible code (binary detection, file formatting) to `vendor.ts` for maintainability
- Clarified user input section of handoff prompt to treat input as direction, not investigation triggers

### Fixed

- Session title generation now works correctly in handoff sessions

## [0.3.1]

### Fixed

- Added missing `clearPrompt` call to prevent double handoff prompt in new session

## [0.3.0]

### Added

- Automatic file injection: @file references in handoff prompts are now automatically loaded into the new session's context

### Changed

- `handoff_session` now accepts `files` array argument
- Restructured `/handoff` command prompt with XML sections (`<context>`, `<instructions>`, `<user_input>`)

## [0.2.0]

### Added

- `read_session` tool for reading conversation transcripts from previous sessions
- Handoff prompts now automatically include a reference to the source session, enabling cross-session context retrieval

### Changed

- Renamed `handoff_prepare` tool to `handoff_session`

## [0.1.0]

### Added

- `/handoff <goal>` command for creating focused continuation prompts
- `handoff_session` tool for session creation with draft prompt
- Inspired by Amp's handoff command

### New Contributors

- Josh Thomas <josh@joshthomas.dev> (maintainer)

[unreleased]: https://github.com/joshuadavidthomas/opencode-handoff/compare/v0.6.1...HEAD
[0.1.0]: https://github.com/joshuadavidthomas/opencode-handoff/releases/tag/v0.1.0
[0.2.0]: https://github.com/joshuadavidthomas/opencode-handoff/releases/tag/v0.2.0
[0.3.0]: https://github.com/joshuadavidthomas/opencode-handoff/releases/tag/v0.3.0
[0.3.1]: https://github.com/joshuadavidthomas/opencode-handoff/releases/tag/v0.3.1
[0.3.2]: https://github.com/joshuadavidthomas/opencode-handoff/releases/tag/v0.3.2
[0.4.0]: https://github.com/joshuadavidthomas/opencode-handoff/releases/tag/v0.4.0
[0.4.1]: https://github.com/joshuadavidthomas/opencode-handoff/releases/tag/v0.4.1
[0.5.0]: https://github.com/joshuadavidthomas/opencode-handoff/releases/tag/v0.5.0
[0.6.0]: https://github.com/joshuadavidthomas/opencode-handoff/releases/tag/v0.6.0
[0.6.1]: https://github.com/joshuadavidthomas/opencode-handoff/releases/tag/v0.6.1
