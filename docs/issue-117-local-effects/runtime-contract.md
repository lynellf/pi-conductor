# Trusted local effect runtime

A registered local effect program is privileged, operator-reviewed host code. The
host verifies the exact executable, fixed argument vector, declared dependency
inventory, host-driver identity, repository identity, reviewed commit, request
scope, evidence hashes, credentials, deadline, and output limit immediately
before releasing its input. It starts the program in a private mode-0700 working
directory with a scrubbed environment, sends credentials only inside the private
stdin document, invokes no shell, and supervises the process session and owner
marker through terminal cleanup.

The program must read stdin through EOF, parse and validate the complete protocol
document, and verify its command and identities before performing any effect. An
empty, partial, malformed, or prematurely closed stdin stream must have no effect.
The program and every descendant must remain in the original supervised process
group and session, retain the supervision marker, and exit before the leader.
Daemonizing, changing process groups, starting background work, or otherwise
escaping supervision violates the provider contract. The program must not
discover ambient credentials or write secrets to stdout or stderr. Each invocation
performs one bounded step and exits. An observation such as
`pending` is returned as an applied observation rather than implemented by a
sleeping process.

These controls are not an OS, filesystem, or network sandbox. In particular,
`repository_path` and `allowed_network_origins` are trusted-program inputs; a
hostname in JSON cannot confine a privileged program's network access. The
operator must review the implementation and complete declared dependency closure
for repository, forge-policy, credential-use, and network behavior.

The broker durably records admission evidence before spawn, process identity
before stdin release, and cleanup settlement before accepting a provider result.
It rechecks both the owner marker and the admitted process session after the
leader exits; any live or unobservable member makes settlement unconfirmed.
Recovery restores the original boot and PID/time/network namespace evidence and
observes the recorded session plus owner marker. A live or unobservable prior
attempt blocks inspection and conflicting work. Timeout, abort, malformed or
oversized output, credential echo, nonzero exit, lost response, and unconfirmed
cleanup are uncertain; they never authorize a blind write replay.
