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

[unreleased]: https://github.com/joshuadavidthomas/opencode-handoff/compare/v0.3.1...HEAD
[0.1.0]: https://github.com/joshuadavidthomas/opencode-handoff/releases/tag/v0.1.0
[0.2.0]: https://github.com/joshuadavidthomas/opencode-handoff/releases/tag/v0.2.0
[0.3.0]: https://github.com/joshuadavidthomas/opencode-handoff/releases/tag/v0.3.0
[0.3.1]: https://github.com/joshuadavidthomas/opencode-handoff/releases/tag/v0.3.1
