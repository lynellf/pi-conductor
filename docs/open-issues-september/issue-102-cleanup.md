# Issue #102 cleanup observation checklist

Issue #102 covers ordinary foreground tools becoming unobservable when an
unrelated same-user process denies access to `/proc/<pid>/environ`.

## Acceptance mapping

- [x] A controlled same-UID process with `PR_SET_DUMPABLE=0` reproduces
  `EACCES` on its environment while a fast foreground `date` command runs.
- [x] Ownership scans capture a call-scoped pre-spawn PID/start/session
  snapshot. Permission failures are ignored only when a fresh identity check
  proves the process was already present in that snapshot or belongs to a
  verified pre-existing session.
- [x] Marker-positive ownership remains authoritative. PID reuse, session
  changes, newly created sessions, and inaccessible candidates without proof
  remain unresolved and fail closed.
- [x] Root completes the installed-runtime smoke, packed delegation checks, and
  full release verification gates: 2,142 tests across 204 files passed in
  174.35 seconds with zero skips. `pnpm lint`, `pnpm typecheck`,
  `pnpm format:check`, frozen install/prepare build, `pnpm build`, and
  `pnpm audit --prod` passed; the full audit reported zero high or critical
  advisories.

Processes created after the tool starts in a detached or new session remain
indistinguishable from escaped descendants when their marker cannot be read;
the runtime deliberately preserves the unresolved-cleanup barrier in that
case. This follows Linux session rules: `setsid(2)` creates a new session and
`setpgid(2)` cannot move a process between sessions ([setsid(2)](https://man7.org/linux/man-pages/man2/setsid.2.html),
[setpgid(2)](https://man7.org/linux/man-pages/man2/setpgid.2.html)). A resumed
run has no original pre-spawn snapshot and therefore remains conservative.

Manual runtime evidence confirms that an inaccessible same-user process in a
verified pre-existing session does not prevent `date` from returning output and
exit status, while an inaccessible detached process created after tool start
remains unresolved and fails closed. Both processes were test-owned and
explicitly terminated afterward. The same negative behavior was confirmed for
an inaccessible owned escaped descendant: cleanup remained unconfirmed and
the original `EACCES` diagnostic was retained.

The packed Node 22.19.0 / Pi 0.85.1 bash permission-observation regression
passed with delayed initial tool observation and two successful foreground
`date` calls. The #101 packed delegation regression passed separately on the
repository SDK and Node 26. The isolated pre-fix 0.21.5 package remains RED
against the inaccessible-process regression, confirming the fix is exercised
rather than a test-only relaxation.
