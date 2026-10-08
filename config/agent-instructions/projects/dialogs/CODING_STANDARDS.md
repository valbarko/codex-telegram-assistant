# Диалоги: coding standards

## Data and recording

Keep audio, transcripts, client cards and edit history outside Git in the existing
`~/Library/Application Support/ConsultationRecorder/Recordings/` catalogue.
Use synthetic fixtures. Build from this project without the Telegram assistant's
environment or credentials; ignored `config/local-runtime.json` holds only local
speech-tool paths/settings.

Preserve approved client recap wording and recording → transcription → manual
review → explicit summary. Selecting a consultation shows existing results
without regenerating them. Live subtitles stay local with the existing 5–7-second
target. On-demand live assignments and the final full summary are separate;
recording continues independently of both.

## Native interface

Use `/Users/valentinbarko/WORK/valentin-rules/mobile-interface-skills.md` and
`swiftui-expert-skill` for SwiftUI. Preserve macOS/AppKit behavior, system
typography, recording flows, opaque reading surfaces, native Liquid Glass controls
where supported, accessibility fallbacks, neutral startup focus and confirmed
Trash deletion with undo. iOS-only navigation/control recipes do not replace
desktop conventions.

Prefer headless native snapshots. They do not establish real Liquid Glass or
selection compositing, or full-screen subtitle interaction.

## Verification and installation

`README.md` owns runtime setup and build/install commands. Release-affecting
changes require `npm test`, `npm run typecheck` and `npm run build:mac`.
Install only after recording stops and unsaved work is preserved; retain the
installed bundle identity and signing certificate. Installation does not request
launching or foregrounding the app. Apply the README's separately scoped checks
when recording, live behavior or analysis changes.
