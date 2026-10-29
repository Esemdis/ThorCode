---
name: full-send
description: Take a ticket or a fix from "go" to merged without stopping to ask, when the owner says "full send". Fix it, verify it, have it independently reviewed, open the PR and merge it if the review is clean. Use only when the owner says "full send" (or "/full-send") about a task; a plain request to fix something still stops before merging.
---

# Full send

"Full send" is the owner's standing authorisation, for the one task named, to do
all of this without asking at each step: **fix it, test it, have it reviewed by
someone who did not write it, open the PR, and merge it if it is ready.** It
replaces the usual "want me to merge it?". It does not replace judgement: it is a
licence to finish, not to ignore a red flag, and it covers only the PR you open
for this task in this session.

Everything repo-specific (the verify command, the branch, the deploy, what an
agent must never do) is in the repo's `CLAUDE.md`. Read it first and follow it
over anything here.

## The steps

1. **Understand it.** Read the ticket or the report. If it is ambiguous in a way
   that changes what you build, ask one question first, with a recommended
   default; "full send" starts after that is answered. Don't re-ask what the
   repo's code or CLAUDE.md already settles.
2. **Branch.** Work on the session's feature branch, never on the default branch
   (`main`, or `master` in concert-map). If its earlier PR was merged, restart
   it from the latest default branch (`git fetch origin && git checkout -B
   <branch> origin/<default>`), but **first** run `git status` and `git log
   origin/<branch>..HEAD` (commit or stash anything uncommitted first; if the
   branch was never pushed there is no `origin/<branch>`, so skip the compare),
   and compare content, not commit ids:
   `git diff origin/<default> origin/<branch>`. A squash merge means the old
   commits never appear on the default branch, so "not reached the default
   branch" is always true; what matters is whether any *content* is missing from
   it. A reset or a `merge -s ours` silently drops anything not yet merged (it
   once lost a finished feature, found only when the owner reported it missing).
   Never force-push; if a push is refused because the branch holds only
   already-merged history, merge `origin/<branch>` normally and check nothing in
   it is lost.
3. **Fix it.** Read the part of the design the task touches before editing. Match
   the surrounding code. Record a design decision where the repo says to (for
   example a contract or docs file its CLAUDE.md names). On a large doc edit,
   slice between named markers and check the line count afterwards: a bad slice
   once deleted 2,600 lines.
4. **Test it.** Run the repo's own verify command from its `CLAUDE.md`, with
   `set -o pipefail` when it pipes through `tail`, using any fallback it names
   (and say so in the PR). Read the output, not just the exit code, and make sure
   the exit code is the real command's, not `tail`'s: in a chain like
   `a && b | tail`, pipefail does not cover `a`, so run the parts so that a
   failure in any of them is visible. New logic
   gets tests; a bug fix gets a test that **fails before the fix**: run it on the
   old code and say so. Anything compared against today pins the clock. Then do
   every other check the CLAUDE.md says must happen before merge: for example
   running the change end to end, a browser check for a UI change, integration
   tests, a drift check. **If one cannot run in this environment, that is a
   reason to hand back, not to merge** (ThorCode: a change to queries or the
   Prisma schema needs integration tests that must never run in the sandbox, so it
   cannot be full-sent). Say plainly what could not run.
5. **Review it independently.** The reviewer must be a **separate agent run**
   (`Agent`, a fresh one, not a fork): give it the **diff and the task, not your
   conclusions** ("find bugs, regressions, rule violations from CLAUDE.md, and
   what this breaks elsewhere"; an agent handed your hypothesis returns it
   confirmed). If you cannot spawn one, hand back; never review your own work
   and call it independent. Risky changes get two reviewers with different
   briefs: a solver or planner, a migration, auth, a write path, a recorded design
   decision being reversed. Verify each finding yourself, fix the real ones, run
   step 4 again, then **run the reviewer again on the final diff**: a fix is new
   code. Put its verdict and your answers to its findings in the PR. A finding
   you reject gets one line saying why.
6. **Bring in the default branch.** `git fetch origin`; if it moved, merge it into
   the branch and re-run step 4. If the repo says to check open PRs that touch
   the same files (it names them), do that and keep your change small.
7. **Open the PR.** Use the repo's template if it has one. Say what changed, the
   decisions you took on the owner's behalf, verification with numbers (and what
   was *not* run), the review's verdict, and deploy notes (migration? which repo
   merges first?). Follow the attribution lines the session gives.
8. **Merge it, only if every one of these holds:**
   - the verify command passes, every other pre-merge check in step 4 has
     actually run, and the new tests are real;
   - CI on the PR is green where it exists. Where the repo runs none on PRs
     (concert-map, route-planner, python-crohn), your local verify is the only
     gate, so its output must be clean and quoted in the PR;
   - the final review verdict has no unresolved blocking finding;
   - **the default branch is not already red** (a known failing test there blocks
     the deploy, so your change would not go live). Check the latest default-branch
     workflow run (the GitHub tools' workflow-run listing). If the repo's CLAUDE.md
     records a known red test (ThorCode's `media.test.js`, THO-423), hand back and
     say so; do not merge;
   - no database migration: nothing under a migrations folder and no schema
     change without one, in any repo, since the repos' rules never auto-merge one;
   - no change to deploy config (Dockerfile, workflows, cron schedules, env vars,
     a new required secret), secrets, the auth model, or data deletion, unless
     that is the task;
   - it is the PR you opened in this session, mergeable, with no human review
     comments waiting on it;
   - the change is what was asked, with no unrelated edits;
   - nothing in another repo has to land first (see below).
   Merge with a squash, through the PR. Never push to the default branch.
9. **Check it landed.** Confirm the default branch contains the change (grep the
   file, not just "merged: true") and that no commit of this work was left behind
   on the branch. A merge to the default branch deploys itself in these repos, and
   some run no tests on a PR at all, so **watch the default-branch run**: if it
   is red or its image step is skipped, say so and hand back.
10. **Report.** One short message: what was wrong, what changed, what was tested
    and what was not, what the review found, the PR number, and what the owner
    should look at once it deploys. Plain; don't oversell untested work.

## When the task needs more than one repo

An API change goes in the provider first: **ThorCode before concert-map,
travel-bag and wander** (wander reads ThorCode's `/travel/trips/:id/*`);
**route-planner before wander**. Open both PRs and cross-link them, merge the
first, then **wait until its deploy has finished before merging the second**
(the default-branch workflow succeeded and its image step ran; the host's
Watchtower pull cannot be checked from here, so ask the owner to confirm it): merging both at once still leaves the consumer live
against an API that is not. If the first is not ready, merge neither. Some repos
forbid reaching across (python-crohn: "do not work on wander's side from here";
concert-map: shapes start in ThorCode or python-crohn, never there): follow that,
do your half and hand back the other.

## When to stop and hand back instead of merging

Say exactly what is blocking and what you need, then wait:

- any condition in step 8 fails, or a check in step 4 could not run;
- the review finds something real you cannot fix, or the checks fail for a
  reason that is not yours (red on the default branch too: do not merge, because
  your change would not build or deploy);
- a change the owner has not seen that reverses a recorded decision they did not
  ask to reverse;
- anything irreversible or outward-facing that is not part of the task.
