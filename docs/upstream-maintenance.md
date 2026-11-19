# Workstation upstream maintenance

Use this ledger when integrating the next selected upstream release. Verify the
actual tag contents and behavior; a PR merge date does not prove release inclusion.
Keep upstream backports separate from fork features. Remove a patch only after its
replacement passes the listed behavioral checks. The release process is in
[release.md](release.md#workstation-fork).

## Selected upstream and preservation ledger

The selected upstream is `v0.16.2`
(`2ee30f4164af42ba209236ab3a31bf9532592fc3`). This integration merges the
18-commit delta from v0.16.1 into deployed workstation.5
(`34a8f04f1eff9060e4803b09c3971e91e60128db`), preserving its draft migration fix.
Upstream .2 leaves archive semantics and OpenCode provider code unchanged. The fork's
universal persisted-stop prerequisite was a regression: saved Codex/legacy conversations
must archive, retain history, and recover matching old archive markers through normal Archive.
The implementation retains targeted OpenCode interruption, child exclusions, identity checks,
and explicit-termination guards. Native archive synchronization follows local archive commit.

The older ledger below records provenance; its universal stored-stop and immutable-marker
policy is superseded by the corrected [archive contract](agent-lifecycle.md#archive). The preservation source is
`1f72f4e91ea6764ccaec677e28ce0721de88951e`, including the local parent-archive
fix. Build the candidate above the selected upstream; do not replay the old
branch's release bookkeeping or duplicate backports. Preserve intervening work
before freezing the candidate.

The dispositions below describe the integration contract. Verification is pending
until the named regressions pass against the final source; source ancestry alone
does not establish equivalent behavior. Retain the actual check receipts with the
accepted package rather than treating this table as a passing test report. For this
incremental update, reuse unchanged passing inputs and run focused archive/provider,
upstream-delta, draft-migration and browser checks; do not restart the old broad integration.

| Behavior and provenance                                                                               | Disposition                                        | Implementation and required evidence                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seven backports listed below                                                                          | Replaced by upstream, subject to behavioral checks | All seven inspected upstream commits are ancestors of the selected tag. Keep manager resumed-turn/send serialization, pointer selection, boundary wheel/history anchor, archived draft and bridge refusal regressions.                                                                            |
| Parent archive visibility (`1f72f4e91`), native settlement (`08aca001e`)                              | Preserved and fixed further                        | `agent-manager.ts`, guarded storage/projections/loading, workspace archive and terminal managers. Confirm failed parent remains visible, counted child leases protect both acquisition orders, retries retain the exact owner, and terminal teardown retains failed handles.                      |
| Unsupported stored-session stops                                                                      | Fixed further                                      | Archive saved conversations normally; no stop call merely to discover support. Matching old archive receipts recover through the archive commit. Explicit termination still checks support before creating intent.                                                                                |
| Archive callers (`50b9ab084`, `faf0647f5`) and upstream Undo                                          | Preserved and integrated                           | Lifecycle commands, workspace operations, client receipt handling and archive hooks. Exact `archivedAt` success stamps; partial progress/Undo cannot restore an unrelated operation or erase a newer unresolved state.                                                                            |
| Durable paste/recovery (`34dd7dd97`, `95eafc11a`, `b7cfdf414`, `0edaaf7bc`)                           | Preserved and fixed further                        | Draft-specific persistence, submission checkpoints and composer ownership. v6 stays unbound; valid v7 checkpoints survive; malformed/future bytes survive later writes/removals. Accepted/uncertain outcomes persist without automatic replay or compaction.                                      |
| Clipboard and sent attachments (`34dd7dd97`, `95eafc11a`)                                             | Preserved and integrated                           | `pasted-text-attachment.ts` owns durable text; upstream platform helpers own short linked-HTML conversion under one dispatcher. Verify exact text, attachment cleanup ownership and read-only sent-text inspection.                                                                               |
| Selection (`e35d1ed24`, `918695b8d`) and configurable previews (`eb012cc97`)                          | Preserved and integrated                           | Web stream strategy, upstream disclosure hold, message expansion and settings. Chromium and explicit Firefox selection/copy/edge-scroll plus preview/Chat Find regressions.                                                                                                                       |
| Editor/Files contracts (`2f8cd9707`, `4d19f3f53`, `89195d256`, `f25bf5b02`, `455687249`, `2a101c616`) | Preserved and integrated                           | Protocol/client/plugin host APIs, file panels, visibility and close protection. Accept target Codium against the exact final package, including retained panels, file/line opens and dirty-close refusal.                                                                                         |
| Overview observations/icons (`e6859b285`, `736a6a0a4`, `df20d5bde`)                                   | Preserved                                          | Passive provider-subagent snapshots, historical activity classification and icon APIs. Accept the target Overview payload against the exact package.                                                                                                                                              |
| Docker/package/publication policy (`9d78be69a`, `97025cdc8` and follow-ups)                           | Preserved                                          | Pinned build environments, disabled updater, signed source, package inspections and manual-only publication contracts. Package provenance must identify the final merge itself.                                                                                                                   |
| Additional native-stop implementations and recovery compaction                                        | Explicitly deferred                                | Unsupported adapters do not gain proof through bookkeeping. Archive is a soft-delete, not proof of remote execution settlement. Only exact matching archive receipts clear on explicit archive; interactive admission stays guarded until then. No recovery-record/blob compaction is introduced. |

The v0.16.2 audit also corrects history-only OpenCode attachment (no configuration or permission
writes), retry after archive-write failure, and matching old archive receipts on already archived
records. Focused manager/provider tests cover these paths with real adapter capabilities. App
corrections release tab reconciliation after failed/canceled workspace archive, report covered
plugin-sheet visibility accurately, and acknowledge Explorer reveal only when the selected row is
viewable. Keep the distinct selection-browser triggers; test async request-bound plugin opens
rather than treating a successful picker mock as proof of that contract.

Accept the new host and target plugins as one compatible set. Changed plugins need
not support the previous host. Keep the complete previous package, plugin payloads,
companion, policies and evidence separately for recovery; retained bytes alone do
not establish migration-safe rollback. Deployment must keep affected services
stopped and startup guarded until the complete selected set verifies on disk.

## Historical backports above v0.15.4

The previous candidate started from upstream `v0.15.4`
(`1c00b365c9e0b74c1580eba33d905d693125ae21`). The seven backports below have
separate signed commits and focused checks. Their listed corrections were absent
from that baseline and required local patches. Their provenance remains useful
when validating their replacements in v0.16.1.

| Upstream change                                      | Inspected merge / local backport                         | Scope and regression                                                                                                                                                    | Retirement condition                                                                        |
| ---------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [#8698](https://github.com/getpaseo/paseo/pull/8698) | `ce8196f6c502ab23bd1ebde5b2301753b25e03a7` / `d24cd024e` | Replay the existing OpenCode v2 turn to a new subscriber; manager can stop a resumed execution and send again.                                                          | Selected release supplies equivalent subscription and regression.                           |
| [#9537](https://github.com/getpaseo/paseo/pull/9537) | `aead84bf0fa4e5bc6b457427bcafbec3acd95749` / `a7c5e70ba` | Serialize interrupting replacement sends without preventing Stop; manager race coverage.                                                                                | Selected release supplies the same admission guarantee.                                     |
| [#8739](https://github.com/getpaseo/paseo/pull/8739) | `ac775a29042751318c10e6415ff051e1fe3768c8` / `0320c46a7` | Focused accepted-pointer capture and touch-only gesture correction, excluding tablet navigation refactoring; real mouse selection on desktop and touch-capable desktop. | Dependency/upstream gestures preserve selection without the local patch.                    |
| [#9570](https://github.com/getpaseo/paseo/pull/9570) | `2fa0e4b169ee1d0daddd80dc167e67bf65f0ee2a` / `f5f5c505c` | Wheel input at the history boundary loads older messages.                                                                                                               | Selected release has equivalent boundary behavior.                                          |
| [#9664](https://github.com/getpaseo/paseo/pull/9664) | `0e0ebc7c9e4a9c7eaebbe1ebccd73fb9e8eb418e` / `b547965e3` | Older-history virtualization preserves reading position.                                                                                                                | Selected release preserves the viewport anchor under the regression.                        |
| [#9079](https://github.com/getpaseo/paseo/pull/9079) | `22f50d4dfa6f7f4795f737e2994283e04c75d592` / `dc1f1a452` | Directory filtering/archive retains drafts; explicit removal clears them. Replica and archive-tab browser checks.                                                       | Selected release provides equivalent draft ownership.                                       |
| [#9653](https://github.com/getpaseo/paseo/pull/9653) | `ade902f195032cf8e1b568eb8b8d1c1333d10eee` / `32385022f` | Rebind after the previous OpenCode bridge stops listening under current Bun or Node; refused-connection regression and three bridge checks. Supersedes closed #9227.    | Selected release recognizes both runtime refusal shapes without treating timeouts as proof. |

## Retained contract detail

| Contract                             | Upstream overlap                                                                                                                                                                         | Required checks before replacement                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Confirmed archive settlement         | Upstream archive commits the parent before its child cascade and clients close optimistically. #8698/#9537 cover adjacent observation/serialization; open PRs are references, not fixes. | Preserve the fork admission guards and recovery contract in [agent-lifecycle.md](agent-lifecycle.md#archive): ordinary parent retained through children, child failure visible and retryable, archived retries keep `archivedAt`, CLI exits nonzero on partial failure, MCP/Hub report the recovery summary. |
| Native mouse selection and scrolling | #8739 pointer capture; #9570/#9664 history anchors. Open #9469 is not a prerequisite.                                                                                                    | Firefox and Chromium mouse drags scroll upward/downward and extend selection across Markdown and past the composer; release stops scrolling; cancel/blur restore composing; streaming/copy remain correct.                                                                                                   |
| Durable pasted text and files        | Existing attachment storage and submission; open #9547/#9548/#9552 receipt/recovery work.                                                                                                | Exact content, one clipboard owner, origin-draft persistence, GC retention, atomic recovery claims and no automatic uncertain resend.                                                                                                                                                                        |
| Embedded editor and Explorer         | Open [#5659](https://github.com/getpaseo/paseo/pull/5659), [#8143](https://github.com/getpaseo/paseo/pull/8143), [#8147](https://github.com/getpaseo/paseo/pull/8147).                   | Request/workspace/placement ownership, bounded reveal, retained editors and fresh close protection. Keep one host reveal operation and one plugin capability adapter.                                                                                                                                        |

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
text, origin ownership and accepted/uncertain outcomes. The submission recovery
record readers must retain the existing version-1 records and their outcome/fence
identities. An explicit draft checkpoint binding distinguishes a fresh same-content
draft from an earlier accepted attempt; version-8 draft occurrences add a durable
cross-tab reservation identity without inferring an old checkpoint from text.
Draft storage migration from v6 to v7 must preserve text and attachments and leave
old drafts unbound, with no inferred association or automatic dispatch. Retirement
or replacement must preserve those records and outcomes. The receipt proposals
above are references only; this patch does not depend on their unfinished wire
semantics.

Composer follow-up regressions also require canonical attachment identity through
draft normalization: accepted sends clear their image/text attachments without
clearing newer draft additions. Preserve full upload-error text, compact wrapping
sent-attachment rows and read-only inspection of sent text. Composer toolbar and
shortcut labels must stay outside chat text selection while the editor remains
selectable.

Native lifecycle and terminal settlement are isolated in `08aca001e`. Its
focused manager/provider/workspace/terminal checks and real OpenCode v2.2.5
family fixture cover restart fencing, safe retries, exact inbox cancellation
and preservation of unrelated active work.

Removing the lifecycle or composer patches also requires a persistence review.
Preserve unresolved native-stop metadata and queued, uncertain, or accepted
composer recovery records. An upstream merge must not automatically replay a submission or clear a marker on startup.
An explicit archive may clear its exact matching old archive receipt under the corrected contract. Migrate existing records only while preserving those outcomes
and rerun the corresponding restart/recovery tests.

Lifecycle replacement must also retain failed terminal handles for a real retry,
keep passive close/delete from erasing unresolved ownership, and prevent helper
release from stopping excluded work. OpenCode interrupt acknowledgements and old
terminal outcomes are insufficient: preserve the fresh native settlement and
exact-family inbox-cancellation checks, including unrelated-sibling survival.

The historical 2026-11-15 overlap refresh also inspected
[#9625](https://github.com/getpaseo/paseo/pull/9625)
(`b4079906990513013979b54b54285980ff3fcd78`) and open
[#8650](https://github.com/getpaseo/paseo/pull/8650)
(`6334bcfbc7b10ca449647bb60f144b62b69618d3`). The former changes worktree
git-risk warnings, not native execution settlement. The latter caps oversized
turns in the mounted history window; keep it separate from selection retention
and recheck its interactions when upgrading virtualization. Those historical
observations do not determine what the selected v0.16.1 tag contains; inspect the
tag and run the retained behavioral checks before retiring any implementation.
