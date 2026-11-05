# Work on this repository

For a user request to install or begin setup, follow [INSTALL.md](INSTALL.md). Use the installer for the current harness rather than registering every client on the machine. Preserve existing profiles and unrelated client settings.

For source changes, run `npm test` and `npm run check`. Keep the public install prompt, package manifests, and CLI help aligned. Tests must not send real Slack messages or start model runs.

Keep OAuth credentials, signing secrets, callback tokens, local runtime data, and machine-specific installation receipts out of Git. This project runs independently of Kindred.
