/* #165: identity-only Darwin observation. Public SDK APIs; no process signalling.
 * KERN_PROCARGS2 may redact env to argv only. Empty env is UNKNOWN, never absent.
 * Source: apple-oss-distributions/xnu/bsd/kern/kern_sysctl.c, sysctl_procargsx.
 */
#include <ctype.h>
#include <errno.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/resource.h>
#include <sys/sysctl.h>
#include <unistd.h>

#define MAX_PROCESSES 16384
#define MAX_ARGS (2 * 1024 * 1024)
#define MAX_TOKEN 1024

static int fail(const char *operation, int code, int pid) {
  /* Fixed strings and errno only: never print syscall input, argv, or env. */
  fprintf(stderr, "{\"version\":1,\"error\":{\"operation\":\"%s\",\"errno\":%d,\"pid\":%d}}\n", operation, code, pid);
  return 1;
}

static void wipe(char *buffer, size_t size) {
  volatile char *bytes = buffer;
  while (size--) *bytes++ = 0;
}

static int same_birth(const struct kinfo_proc *a, const struct kinfo_proc *b) {
  return a->kp_proc.p_pid == b->kp_proc.p_pid &&
    a->kp_proc.p_starttime.tv_sec == b->kp_proc.p_starttime.tv_sec &&
    a->kp_proc.p_starttime.tv_usec == b->kp_proc.p_starttime.tv_usec;
}

static int read_info(int pid, struct kinfo_proc *info) {
  int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
  size_t size = sizeof(*info);
  memset(info, 0, sizeof(*info));
  if (sysctl(mib, 4, info, &size, NULL, 0) != 0) return -1;
  if (size == 0) return 0;
  if (size != sizeof(*info)) { errno = EIO; return -1; }
  return 1;
}

/* 1 present, 0 complete absence, -1 unknown. No string leaves this function. */
static int marker_state(int pid, const char *token) {
  int mib[] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t needed = 0;
  if (sysctl(mib, 3, NULL, &needed, NULL, 0) != 0 ||
      needed <= sizeof(int) || needed > MAX_ARGS) return -1;
  char *buffer = calloc(needed, 1);
  if (!buffer) return -1;
  size_t size = needed;
  int result = -1;
  if (sysctl(mib, 3, buffer, &size, NULL, 0) != 0 || size > needed || size <= sizeof(int)) goto done;
  int argc = 0;
  memcpy(&argc, buffer, sizeof(argc));
  if (argc < 1 || argc > MAX_ARGS) goto done;
  char *cursor = buffer + sizeof(int);
  char *end = buffer + size;
  char *nul = memchr(cursor, 0, (size_t)(end - cursor));
  if (!nul) goto done;
  cursor = nul + 1;
  while (cursor < end && *cursor == 0) ++cursor;
  for (int i = 0; i < argc; ++i) {
    nul = memchr(cursor, 0, (size_t)(end - cursor));
    if (!nul) goto done;
    cursor = nul + 1;
  }
  const char prefix[] = "PI_CONDUCTOR_EXECUTION_ID=";
  size_t prefix_size = sizeof(prefix) - 1;
  int entries = 0;
  int matched = 0;
  while (cursor < end && *cursor != 0) {
    nul = memchr(cursor, 0, (size_t)(end - cursor));
    if (!nul || !memchr(cursor, '=', (size_t)(nul - cursor))) goto done;
    ++entries;
    if ((size_t)(nul - cursor) == prefix_size + strlen(token) &&
        memcmp(cursor, prefix, prefix_size) == 0 &&
        memcmp(cursor + prefix_size, token, strlen(token)) == 0) matched = 1;
    cursor = nul + 1;
  }
  /* Restricted queries end at argv; a genuinely empty environment is also unknown.
   * Do not accept a truncated buffer without its terminating empty env entry. */
  if (matched) result = 1;
  else if (entries > 0 && cursor < end && *cursor == 0) result = 0;
done:
  wipe(buffer, needed);
  free(buffer);
  return result;
}

static int emit_process(int pid, const char *token, int *first) {
  struct kinfo_proc before, after;
  int read = read_info(pid, &before);
  if (read <= 0) return read;
  if (before.kp_proc.p_stat == SZOMB) return 0;
  pid_t sid = getsid(pid);
  pid_t group = getpgid(pid);
  if (sid < 0 || group <= 0) {
    if (errno == ESRCH) return 0;
    return -1;
  }
  unsigned long long start;
  const char *kind;
  uid_t uid = before.kp_eproc.e_ucred.cr_uid;
  /* Public SDK sys/sysctl.h: p_ruid is real UID; cr_uid is effective UID. */
  uid_t real_uid = before.kp_eproc.e_pcred.p_ruid;
  if (uid == getuid()) {
    struct rusage_info_v0 usage = {0};
    if (proc_pid_rusage(pid, RUSAGE_INFO_V0, (rusage_info_t *)&usage) != 0) {
      if (errno == ESRCH) return 0;
      return -1;
    }
    start = usage.ri_proc_start_abstime;
    kind = "mach";
  } else {
    /* Other-user identities support group visibility, not marker ownership.
     * Never compare this representation with Mach admission boundaries. */
    start = (unsigned long long)before.kp_proc.p_starttime.tv_sec * 1000000ULL +
      (unsigned long long)before.kp_proc.p_starttime.tv_usec;
    kind = "wallclock";
  }
  if (start == 0) { errno = EIO; return -1; }
  int marker = token[0] == 0 || uid != getuid() ? -1 : marker_state(pid, token);
  read = read_info(pid, &after);
  if (read <= 0) return read;
  if (after.kp_proc.p_stat == SZOMB) return 0;
  if (!same_birth(&before, &after) || after.kp_eproc.e_ucred.cr_uid != uid ||
      after.kp_eproc.e_pcred.p_ruid != real_uid ||
      getsid(pid) != sid || getpgid(pid) != group) { errno = EAGAIN; return -1; }
  if (uid == getuid()) {
    struct rusage_info_v0 verified = {0};
    if (proc_pid_rusage(pid, RUSAGE_INFO_V0, (rusage_info_t *)&verified) != 0) {
      if (errno == ESRCH) return 0;
      return -1;
    }
    if (verified.ri_proc_start_abstime != start) { errno = EAGAIN; return -1; }
  }
  if (!*first) putchar(',');
  *first = 0;
  printf("{\"pid\":%d,\"uid\":%u,\"realUid\":%u,\"startTime\":\"%llu\",\"startKind\":\"%s\",\"processGroupId\":%d,\"sessionId\":%d,\"marker\":\"%s\"}",
    pid, uid, real_uid, start, kind, group, sid,
    marker == 1 ? "present" : marker == 0 ? "absent" : "unknown");
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 2 && argc != 3) return fail("list_processes", EINVAL, 0);
  int snapshot = strcmp(argv[1], "snapshot") == 0;
  int observe = strcmp(argv[1], "observe") == 0;
  int scan = strcmp(argv[1], "scan") == 0;
  if ((!snapshot && !observe && !scan) || (observe != (argc == 3))) return fail("list_processes", EINVAL, 0);
  int target = 0;
  if (observe) {
    char *end;
    long value = strtol(argv[2], &end, 10);
    if (*end || value <= 0 || value > 2147483647) return fail("read_stat", EINVAL, 0);
    target = (int)value;
  }
  char token[MAX_TOKEN + 1] = {0};
  if (!snapshot) {
    size_t bytes = fread(token, 1, sizeof(token), stdin);
    if (bytes > MAX_TOKEN || ferror(stdin)) return fail("read_environ", EINVAL, target);
    token[bytes] = 0;
    if (strlen(token) != bytes) return fail("read_environ", EINVAL, target);
  }
  char boot[64] = {0};
  size_t boot_size = sizeof(boot);
  if (sysctlbyname("kern.bootsessionuuid", boot, &boot_size, NULL, 0) != 0 ||
      boot_size < 2 || boot_size > sizeof(boot) || boot[boot_size - 1] != 0)
    return fail("list_processes", EIO, 0);
  for (size_t i = 0; i < boot_size - 1; ++i) {
    if (!isxdigit((unsigned char)boot[i]) && boot[i] != '-') return fail("list_processes", EIO, 0);
    boot[i] = (char)tolower((unsigned char)boot[i]);
  }
  struct kinfo_proc *processes = NULL;
  size_t count = 0;
  if (!observe) {
    int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL};
    int complete = 0;
    for (int attempt = 0; attempt < 5; ++attempt) {
      size_t needed = 0;
      if (sysctl(mib, 3, NULL, &needed, NULL, 0) != 0) return fail("list_processes", errno, 0);
      if (needed / sizeof(*processes) + 64 > MAX_PROCESSES) return fail("list_processes", EOVERFLOW, 0);
      size_t capacity = needed + 64 * sizeof(*processes);
      processes = calloc(1, capacity);
      if (!processes) return fail("list_processes", ENOMEM, 0);
      size_t size = capacity;
      if (sysctl(mib, 3, processes, &size, NULL, 0) == 0 && size < capacity && size % sizeof(*processes) == 0) {
        count = size / sizeof(*processes);
        complete = 1;
        break;
      }
      free(processes);
      processes = NULL;
      if (errno != ENOMEM) return fail("list_processes", EIO, 0);
    }
    if (!complete) return fail("list_processes", EAGAIN, 0);
  }
  printf("{\"version\":1,\"bootId\":\"%s\",\"uid\":%u,\"processes\":[", boot, getuid());
  int first = 1;
  int failed = 0;
  int failed_pid = target;
  int self_seen = observe;
  if (observe) failed = emit_process(target, token, &first) < 0;
  else for (size_t i = 0; i < count; ++i) {
    int pid = processes[i].kp_proc.p_pid;
    if (pid <= 0) continue;
    if (pid == getpid()) self_seen = 1;
    if (emit_process(pid, snapshot ? "" : token, &first) < 0) { failed = 1; failed_pid = pid; break; }
  }
  if (!self_seen && !failed) { failed = 1; failed_pid = 0; errno = EIO; }
  int failed_errno = errno;
  /* An incomplete document is deliberately invalid. The host never uses partial observations. */
  if (!failed) puts("]}");
  free(processes);
  wipe(token, sizeof(token));
  return failed ? fail("read_stat", failed_errno, failed_pid) : 0;
}
