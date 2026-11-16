# Ranch screenshot tour

A walk through what each part of the Ranch layout shows, in the order you see
it in `preview.png`.

## Sidebar

- **Projects**: every space, grouped by machine (This Mac, remote machines over
  `hc machine`). Each project lists its tabs as cards.
- **Cards**: the agent's session title, its branch, task progress (`done/total`),
  uncommitted changes (`files +added -removed` with a change meter) and the PR
  badge when the branch has one.
- **States**: working (spinner), needs you (amber), done, and paused tasks when
  an agent stops mid-list. Sub-agents keep their parent card working.
- **Settled** tabs fold into a quiet row per space; drag cards and spaces to
  reorder them. Collapse the sidebar to a rail; hover a project for a popover.

## Session details

- **Tasks** from Claude Code, Codex, OpenCode and Pi, with a progress bar and
  the agent's state pill.
- **Sub-agents** started with `hc run --bg`, with peek and keep-as-tab.
- **Git**: branch vs upstream, ahead/behind, changed files, recent commits and
  the default branch's last commit.
- **Pull request**: title, state, checks and review status.

## Status bar

Machine, branch and agent count on the left; per-provider usage on the right.
