# Releasing

Releases are published by project maintainers only.

## Node/CLI release

1. `./scripts/build-package.sh` — builds all packages, stages the npm bundle,
   prompts for version bump (patch/minor/major), updates the Homebrew formula
2. Test locally: `npm install -g .publish-staging && dokkimi version && dokkimi doctor`
3. Commit version bump + formula changes: `git add VERSION Formula/ **/package.json && git commit`
4. `./scripts/publish-package.sh` — publishes to npm, tags `brew-v{VERSION}`
   to trigger the Homebrew tap sync workflow, and prompts to create a GitHub Release

## Checklist

- [ ] Version bumped in VERSION file
- [ ] All package.json files synced (`./scripts/sync-version.sh`)
- [ ] Formula/dokkimi.rb updated (done automatically by build-package.sh)
- [ ] npm package published
- [ ] Homebrew tap updated (triggered by brew-v{VERSION} tag)
- [ ] GitHub Release created with release notes
