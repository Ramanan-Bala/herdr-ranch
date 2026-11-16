# Ranch self-update from settings — design

## Why
People install Ranch by asking an agent to add the layout; it copies `layouts/ranch.*` and
`mods/ranch-*` into `~/.config/herdr-app` and runs `ranch-tasks install`. Nothing records the
source or version, so every change to the repo means asking an agent again. Goal: an
**Updates** card in Ranch settings that checks GitHub and updates in one click.

## Decisions
- An update = any new commit on `main` of `https://github.com/Ramanan-Bala/herdr-ranch.git`
  (no tags/releases).
- Approach A (picked): a new `ranch-tasks update` subcommand in the Node CLI does the work;
  the settings card only calls it. Rejected: doing it in the mod (untestable, `cp` breaks on
  Windows, panel reloads mid-update); spawning an agent (what users already do, slow, costly).

## How it works
- `ranch-tasks update check --json` — `git ls-remote` the repo's `main`, compare with the
  commit in `~/.herdr/ranch/update.json`. Reports `{installed, latest, available, dev, error?}`.
- `ranch-tasks update [--yes] [--json]` — shallow clone/fetch into `~/.herdr/ranch/src`,
  copy `layouts/ranch.json`, `layouts/ranch.svg` and every file of `mods/ranch-*` into the
  Herdr home, write the manifest (commit + sha256 per file), and re-run
  `ranch-tasks install --yes` from the new source when task reporting was installed
  (`~/.herdr/ranch/install.json` exists). Without `--yes` it only says what it would do.
- Safety: a file whose current content differs from both the new version and the manifest
  hash (edited by the person, or no manifest yet = first update) is backed up to
  `~/.herdr/ranch/backups/update-<timestamp>/<path>` before being replaced. Files dropped
  upstream are removed only when the manifest says Ranch wrote them.
- Dev installs (layout or any `mods/ranch-*` is a symlink, as `scripts/link-dev.sh` makes)
  are refused: "dev install — run git pull in the repo".
- Settings card: installed/latest short hashes, status, **Check now**, **Update**. Checks on
  open at most every 30 min. After a successful update it reloads Ranch by switching layouts
  away and back, like `link-dev.sh --reload`.
- Env overrides for tests: `RANCH_UPDATE_REPO`, `RANCH_UPDATE_BRANCH`, `HERDR_APP_HOME`,
  `RANCH_HOME`.

## Non-goals
- Merging `keys.json` (left to the person / the install agent).
- Mods the install agent renamed because of a name clash (they won't be found; the update
  installs under the standard names).
- Updating remote machines.

## Known limits
- Existing installs whose `~/.herdr/ranch` CLI predates this need one more agent install (or
  `ranch-tasks install` from a fresh clone) before the button works; the card says so.
- Updates reach the network through `git` to GitHub; the RECIPE privacy note is updated.
