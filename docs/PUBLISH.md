# Publish the prepared source snapshot

The archive includes current source changes, tests, documentation, assets, lockfile, built entry points and the fixed Pi snapshot. It excludes `.git`, installed dependencies, runtime databases, logs and credentials. `RELEASE_MANIFEST.json` records every payload file hash.

## Build a fresh package

```bash
npm run check
npm test
npm run build
python3 scripts/package-source.py
```

Outputs: `release/TripleTeam-source.zip`, `release/TripleTeam-source.tar.gz`, `release/SHA256SUMS`.

## Update the GitHub repository

Clone the destination into a **new directory**, then replace that clone's tracked content with the source snapshot. This starts from the remote history and avoids the earlier `fetch first` rejection caused by creating a separate local history. The archive contains no `.git` directory. Removing the old tracked content in this disposable clone also prevents obsolete source files from surviving the update.

```bash
TRIPLETEAM_PUBLISH_DIR="$(mktemp -d "$HOME/TripleTeam-publish.XXXXXX")"
git clone https://github.com/npm-DreaMaX/TripleTeam.git "$TRIPLETEAM_PUBLISH_DIR"
cd "$TRIPLETEAM_PUBLISH_DIR"
git switch main
git rm -r --ignore-unmatch -- .
tar -xzf /home/FangWang/TripleTeam/release/TripleTeam-source.tar.gz --strip-components=1
git status --short
git diff --stat
git add .
git commit -m "Release TripleTeam: adaptive execution and verified delivery"
git push -u origin main
```

The temporary directory is unique; `git rm` applies only to this new clone. Keep API credentials and runtime state outside the publication checkout. Review the changed files before committing.

Git may ask for your configured GitHub authentication. If someone updates `main` after the clone, incorporate that update and retry. Resolve any reported conflicts before continuing:

```bash
git pull --rebase origin main
git push origin main
```

For a pull request instead of a direct `main` update:

```bash
git push -u origin HEAD:tripleteam-release
```

The source package is the reviewable handoff. These instructions do not publish anything automatically. After uploading, the README's relative images and documentation links work directly on GitHub.
