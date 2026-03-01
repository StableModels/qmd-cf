Review all changes in the current branch compared to main, check for public API impact, update README and CLAUDE.md if needed, and automatically bump the package version.

## Steps

1. **Diff analysis**: First run `git fetch origin main` to ensure the local main ref is up to date with the remote. Then run `git diff origin/main...HEAD` to see all changes in this branch and `git log --oneline origin/main..HEAD` to understand the commit history. Always compare against `origin/main`, not the local `main` branch.

2. **Determine version bump**:
   - **patch** (e.g. 0.1.0 → 0.1.1): Bug fixes, documentation changes, refactors, test additions, CI changes — anything that doesn't change the public API.
   - **minor** (e.g. 0.1.0 → 0.2.0): New features, new exports, new methods on public classes, new options added to existing methods — any additive change to the public API.
   - Never bump major unless explicitly told to.

3. **Review the changes**: Provide a concise summary of what changed, organized by category (features, fixes, docs, tests, CI, etc.). Flag any concerns.

4. **Public API review**: Check if any changes affect the public API or public usage:
   - Look at `src/index.ts` exports — any added, removed, renamed, or moved exports?
   - Check the `exports` field in `package.json` — any new or changed entry points (`.` and `./testing`)?
   - Look at public class/type signatures in `src/qmd.ts` and `src/types.ts` — any changed method signatures, new required params, removed methods, or changed return types?
   - Check for breaking changes to the `./testing` sub-export (`MockSqlStorage`, `MockVectorize`, `createMockEmbedFn`).
   - If any public API changes are found, update `readme.md` to reflect them. Keep changes concise and developer-oriented — document what consumers need to know (imports, usage, API surface, entry points), not internal implementation details.

5. **CLAUDE.md review**: Check if any changes affect internal architecture, project structure, conventions, or guidance that future developer agents need to know:
   - Read the current `CLAUDE.md` and compare it against the actual state of the codebase after this branch's changes.
   - **File structure**: Are there new source files, moved modules, or renamed files that the File Map section should mention?
   - **Conventions**: Are there new patterns, naming conventions, or implementation rules introduced by this branch?
   - **Commands**: Has the test count changed, or have new scripts been added to `package.json`?
   - **Key design decisions**: Do they still match reality (e.g., if chunking strategy changed, if RRF parameters changed, if schema version bumped)?
   - **Important points**: Are there new gotchas, design decisions, or behavioral notes worth documenting?
   - `CLAUDE.md` is for internal developer/agent guidance — architecture, conventions, file layout, how to extend the code. `README.md` is user-facing — install, usage, API surface, exports. Do not put internal implementation details in the README, and do not put user-facing setup instructions in CLAUDE.md.
   - Only update `CLAUDE.md` if something is actually wrong or missing. Don't rewrite for style.

6. **Test coverage review**: For any new or changed functionality, review existing tests and add missing coverage:
   - Are the core behaviors tested (not just happy paths)? Check edge cases, error conditions, and boundary values that exercise the actual logic.
   - Do tests assert on the right things? Tests should verify correct outcomes and state, not just that "something was called" or "no error was thrown." A test that passes when the code is broken is worse than no test.
   - Are there integration-level tests that exercise the new code through `Qmd`, not just individual functions in isolation?
   - For search changes, verify both FTS-only and hybrid (FTS + vector) paths are tested.
   - For chunking changes, verify break point scoring, code fence handling, and edge cases.
   - Don't add tests for trivial wiring or scenarios already covered. Focus on cases where a bug would actually go undetected.
   - Run `bun test` after any test changes to confirm they pass.

7. **Bump the version**: Run `npm version <patch|minor> --no-git-tag-version` to update package.json. Do NOT create a git tag — the version in package.json is what npm publish uses.

8. **Verify**: Run `bun run test:unit && bun run check && bun run build` to make sure everything still passes.

9. **Commit and push all outstanding changes**: Stage all modified and new files (README.md, CLAUDE.md, package.json, test files, etc.) and create appropriate commits. Then `git push` to ensure the remote branch is fully up to date. This guarantees the PR reflects everything — doc updates, version bump, test additions, and any other changes made during this review.

10. **Update PR**: Check if there is an open pull request for the current branch (`gh pr view --json number,title,body`). If one exists, update its title and description to reflect the full scope of changes in the branch using `gh pr edit`. The PR may have been created early and its description may be outdated. Write a concise title (under 70 chars) and a body with a short summary of all changes, not just the latest commit.

11. **Report**: Show the old version, new version, bump type, and the reasoning for the bump decision.
