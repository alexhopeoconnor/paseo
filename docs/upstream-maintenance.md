# Workstation upstream maintenance

Use this ledger when integrating the next selected upstream release. Verify the
actual tag contents and behavior; a PR merge date does not prove release inclusion.
Keep upstream backports separate from fork features. Remove a patch only after its
replacement passes the listed behavioral checks. The release process is in
[release.md](release.md#workstation-fork).

## Candidate backports

The candidate starts from upstream `v0.15.4`
(`1c00b365c9e0b74c1580eba33d905d693125ae21`). The seven backports below have
separate signed commits and focused checks. Their listed corrections were absent
from the selected baseline and required local patches. Final package acceptance is recorded
in the candidate handoff.

| Upstream change                                      | Inspected merge / local backport                         | Scope and regression                                                                                                                                                    | Retirement condition                                                                        |
| ---------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [#8698](https://github.com/getpaseo/paseo/pull/8698) | `ce8196f6c502ab23bd1ebde5b2301753b25e03a7` / `d24cd024e` | Replay the existing OpenCode v2 turn to a new subscriber; manager can stop a resumed execution and send again.                                                          | Selected release supplies equivalent subscription and regression.                           |
| [#9537](https://github.com/getpaseo/paseo/pull/9537) | `aead84bf0fa4e5bc6b457427bcafbec3acd95749` / `a7c5e70ba` | Serialize interrupting replacement sends without preventing Stop; manager race coverage.                                                                                | Selected release supplies the same admission guarantee.                                     |
| [#8739](https://github.com/getpaseo/paseo/pull/8739) | `ac775a29042751318c10e6415ff051e1fe3768c8` / `0320c46a7` | Focused accepted-pointer capture and touch-only gesture correction, excluding tablet navigation refactoring; real mouse selection on desktop and touch-capable desktop. | Dependency/upstream gestures preserve selection without the local patch.                    |
| [#9570](https://github.com/getpaseo/paseo/pull/9570) | `2fa0e4b169ee1d0daddd80dc167e67bf65f0ee2a` / `f5f5c505c` | Wheel input at the history boundary loads older messages.                                                                                                               | Selected release has equivalent boundary behavior.                                          |
| [#9664](https://github.com/getpaseo/paseo/pull/9664) | `0e0ebc7c9e4a9c7eaebbe1ebccd73fb9e8eb418e` / `b547965e3` | Older-history virtualization preserves reading position.                                                                                                                | Selected release preserves the viewport anchor under the regression.                        |
| [#9079](https://github.com/getpaseo/paseo/pull/9079) | `22f50d4dfa6f7f4795f737e2994283e04c75d592` / `dc1f1a452` | Directory filtering/archive retains drafts; explicit removal clears them. Replica and archive-tab browser checks.                                                       | Selected release provides equivalent draft ownership.                                       |
| [#9653](https://github.com/getpaseo/paseo/pull/9653) | `ade902f195032cf8e1b568eb8b8d1c1333d10eee` / `32385022f` | Rebind after the previous OpenCode bridge stops listening under current Bun or Node; refused-connection regression and three bridge checks. Supersedes closed #9227.    | Selected release recognizes both runtime refusal shapes without treating timeouts as proof. |

## Fork contracts

| Contract                             | Upstream overlap                                                                                                                                                       | Required checks before replacement                                                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmed archive settlement         | #8698 fixes resumed observation; #9537 fixes replacement serialization. Neither establishes archive settlement.                                                        | Explicit archive/kill fences admission, settles owned native work, preserves uncertain failures and leaves detached/unrelated work alone. Generic cleanup stays passive.         |
| Native mouse selection and scrolling | #8739 pointer capture; #9570/#9664 history anchors. Open #9469 is not a prerequisite.                                                                                  | Actual mouse drag changes scroll position and extends selection off-screen, upward/downward, across Markdown structures; release stops scrolling; streaming/copy remain correct. |
| Durable pasted text and files        | Existing attachment storage and submission; open #9547/#9548/#9552 receipt/recovery work.                                                                              | Exact content, one clipboard owner, origin-draft persistence, GC retention, atomic recovery claims and no automatic uncertain resend.                                            |
| Embedded editor and Explorer         | Open [#5659](https://github.com/getpaseo/paseo/pull/5659), [#8143](https://github.com/getpaseo/paseo/pull/8143), [#8147](https://github.com/getpaseo/paseo/pull/8147). | Request/workspace/placement ownership, bounded reveal, retained editors and fresh close protection. Keep one host reveal operation and one plugin capability adapter.            |

Open proposals are design references, not implemented dependencies or release
guarantees. Reinspect their reviewed revisions before adopting changes. Host additions are recorded in `455687249` and `2a101c616`: optional capabilities
and search provenance use the existing confirmed dispatcher and Files tree. Keep
Codium bridge/authentication behavior in the plugin and companion; add only the
host contracts required for routing, visibility and Explorer integration.

Selection retention is isolated in `e35d1ed24`. Archive UI confirmation and
current-route recovery are isolated in `50b9ab084` and `faf0647f5`; their tests
remain useful when replacing the server lifecycle patch with upstream behavior.

Durable paste and submission recovery are isolated in `34dd7dd97`. The clipboard,
recovery-store, draft-persistence and caller browser regressions preserve exact
text, origin ownership and accepted/uncertain outcomes. The receipt proposals
above are references only; this patch does not depend on their unfinished wire
semantics.

Native lifecycle and terminal settlement are isolated in `08aca001e`. Its
focused manager/provider/workspace/terminal checks and real OpenCode v2.2.5
family fixture cover restart fencing, safe retries, exact inbox cancellation
and preservation of unrelated active work.

Removing the lifecycle or composer patches also requires a persistence review.
Preserve unresolved native-stop metadata and queued, uncertain, or accepted
composer recovery records. An upstream merge must not clear a stop fence or
automatically replay a submission merely because the local implementation is
being replaced. Migrate existing records only while preserving those outcomes
and rerun the corresponding restart/recovery tests.

Lifecycle replacement must also retain failed terminal handles for a real retry,
keep passive close/delete from erasing unresolved ownership, and prevent helper
release from stopping excluded work. OpenCode interrupt acknowledgements and old
terminal outcomes are insufficient: preserve the fresh native settlement and
exact-family inbox-cancellation checks, including unrelated-sibling survival.

The 2026-11-15 overlap refresh also inspected merged
[#9625](https://github.com/getpaseo/paseo/pull/9625)
(`b4079906990513013979b54b54285980ff3fcd78`) and open
[#8650](https://github.com/getpaseo/paseo/pull/8650)
(`6334bcfbc7b10ca449647bb60f144b62b69618d3`). The former changes worktree
git-risk warnings, not native execution settlement. The latter caps oversized
turns in the mounted history window; keep it separate from selection retention
and recheck its interactions when upgrading virtualization. Neither is imported
by this candidate.
