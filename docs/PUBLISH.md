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

## Push a clean project history

Extract the package into a **new directory**. This keeps the existing workspace and its legacy research history intact.

```bash
mkdir -p ~/tripleteam-publish
tar -xzf /home/FangWang/TripleTeam/release/TripleTeam-source.tar.gz -C ~/tripleteam-publish
cd ~/tripleteam-publish/TripleTeam
git init -b main
git add .
git commit -m "Release TripleTeam: adaptive execution and evidence-backed delivery"
git remote add origin https://github.com/npm-DreaMaX/TripleTeam.git
git push -u origin main
```

Git may ask for your configured GitHub authentication. If the remote already has commits, push a new branch and open a pull request instead of forcing over existing history:

```bash
git push -u origin HEAD:tripleteam-release
```

The source package is the reviewable handoff. These instructions do not publish anything automatically. After uploading, the README's relative images and documentation links work directly on GitHub.
