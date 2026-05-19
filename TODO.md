# Release Security TODO

Implementation order: fix item 2 first, then continue with 3-7. Save item 1 for last.

- [x] 1. Remove the production Tauri updater private key from CI. Use a dummy CI key or avoid updater signing in CI; keep the real updater key local-only in `scripts/sign-and-deploy.sh`.
- [x] 2. Stop using `npx` in signing and publish paths. Use lockfile-backed `pnpm exec` so release-critical tools come from installed workspace dependencies.
- [x] 3. Pin GitHub Actions to full commit SHAs and use automation to keep pins updated.
- [x] 4. Add explicit workflow permissions, with read-only defaults and no `id-token: write` unless a job truly needs it.
- [x] 5. Put VS Code Marketplace and OpenVSX publishing behind a protected GitHub environment with reviewer approval and tag restrictions.
- [x] 6. Verify CI artifacts before local signing, ideally with GitHub artifact attestations checked by `scripts/sign-and-deploy.sh`.
- [x] 7. Make artifact selection strict in `scripts/sign-and-deploy.sh`; fail unless exactly one expected artifact exists at each expected path/name.
