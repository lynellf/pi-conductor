/* Fixed credential-free test observer for issue #106; never a production tool. */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <poll.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <unistd.h>

static int extra_fds(void) {
  DIR *d = opendir("/proc/self/fd");
  if (!d) return -1;
  int own = dirfd(d), count = 0;
  struct dirent *e;
  while ((e = readdir(d))) {
    if (e->d_name[0] == '.') continue;
    int fd = atoi(e->d_name);
    if (fd > 2 && fd != own) count++;
  }
  closedir(d);
  return count;
}

static int devices(void) {
  const char *names[] = {"null", "zero", "full", "random", "urandom", "tty"};
  const unsigned int majors[] = {1, 1, 1, 1, 1, 5};
  const unsigned int minors[] = {3, 5, 7, 8, 9, 0};
  for (int i = 0; i < 6; i++) {
    char path[64]; struct stat s;
    snprintf(path, sizeof path, "/dev/%s", names[i]);
    if (lstat(path, &s) || !S_ISCHR(s.st_mode) || major(s.st_rdev) != majors[i] || minor(s.st_rdev) != minors[i]) return -1;
  }
  const char *allowed[] = {"null", "zero", "full", "random", "urandom", "tty", "stdin", "stdout", "stderr", "fd", "core", "shm", "pts", "ptmx"};
  DIR *d = opendir("/dev"); if (!d) return -1;
  struct dirent *e; int count = 0;
  while ((e = readdir(d))) {
    if (e->d_name[0] == '.') continue;
    int found = 0;
    for (unsigned int i = 0; i < sizeof allowed / sizeof *allowed; i++) if (!strcmp(allowed[i], e->d_name)) found = 1;
    if (!found) { closedir(d); return -1; }
    count++;
  }
  closedir(d);
  if (count != 14) return -1;

  const char *links[] = {"fd", "stdin", "stdout", "stderr", "core", "ptmx"};
  const char *targets[] = {"/proc/self/fd", "/proc/self/fd/0", "/proc/self/fd/1", "/proc/self/fd/2", "/proc/kcore", "pts/ptmx"};
  for (int i = 0; i < 6; i++) {
    char path[64], target[64];
    snprintf(path, sizeof path, "/dev/%s", links[i]);
    ssize_t length = readlink(path, target, sizeof target - 1);
    if (length < 0 || (size_t)length >= sizeof target - 1) return -1;
    target[length] = '\0';
    if (strcmp(target, targets[i])) return -1;
  }
  struct stat pts, shm;
  if (lstat("/dev/pts", &pts) || !S_ISDIR(pts.st_mode) ||
      lstat("/dev/shm", &shm) || !S_ISDIR(shm.st_mode)) return -1;
  return 0;
}

static int host_connection(int port) {
  int fd = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
  if (fd == -1) return -1;
  struct sockaddr_in addr = {.sin_family = AF_INET, .sin_port = htons((unsigned short)port)};
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  int result = connect(fd, (struct sockaddr *)&addr, sizeof addr);
  int error = errno;
  if (result < 0 && error == EINPROGRESS) {
    struct pollfd p = {.fd = fd, .events = POLLOUT};
    int ready = poll(&p, 1, 1000);
    socklen_t length = sizeof error;
    if (ready <= 0 || getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length)) { close(fd); return -1; }
  } else if (result == 0) error = 0;
  close(fd);
  return error;
}

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  errno = 0;
  char *port_end = NULL;
  long parsed_port = strtol(argv[1], &port_end, 10);
  if (errno || port_end == argv[1] || *port_end != '\0' || parsed_port < 1 || parsed_port > 65535) return 2;
  int fds = extra_fds();
  if (fds < 0) return 2;
  unsigned long long caps[5] = {0};
  const char *keys[] = {"CapInh:", "CapPrm:", "CapEff:", "CapBnd:", "CapAmb:"};
  unsigned int seen = 0;
  FILE *status = fopen("/proc/self/status", "r"); if (!status) return 2;
  char line[512];
  while (fgets(line, sizeof line, status)) {
    for (int i = 0; i < 5; i++) {
      if (!strncmp(line, keys[i], strlen(keys[i]))) {
        if (sscanf(line + strlen(keys[i]), "%llx", &caps[i]) != 1) { fclose(status); return 2; }
        seen |= 1U << i;
      }
    }
  }
  fclose(status);
  if (seen != 31) return 2;
  unsigned long long combined = caps[0] | caps[1] | caps[2] | caps[3] | caps[4];
  struct ifaddrs *interfaces = NULL;
  if (getifaddrs(&interfaces)) return 2;
  int external_interfaces = 0;
  for (struct ifaddrs *i = interfaces; i; i = i->ifa_next) if (!(i->ifa_flags & IFF_LOOPBACK)) external_interfaces++;
  freeifaddrs(interfaces);
  int connection_error = host_connection((int)parsed_port);
  if (connection_error < 0) return 2;
  int device_error = devices();
  FILE *limit = fopen("/proc/sys/user/max_user_namespaces", "r");
  unsigned long namespace_limit;
  if (!limit || fscanf(limit, "%lu", &namespace_limit) != 1) return 2;
  fclose(limit);
  errno = 0;
  int nested_result = unshare(CLONE_NEWUSER), nested_error = errno;
  int nested_userns_denied = nested_result == -1 &&
      (nested_error == ENOSPC || nested_error == EUSERS || nested_error == EPERM);
  int no_new_privs = prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0);
  if (no_new_privs < 0) return 2;
  int expected_connection_denial = connection_error == ENETUNREACH ||
      connection_error == EHOSTUNREACH || connection_error == ECONNREFUSED;
  printf("{\"schema_version\":1,\"capabilities_zero\":%s,\"cap_inh\":\"%016llx\",\"cap_prm\":\"%016llx\",\"cap_eff\":\"%016llx\",\"cap_bnd\":\"%016llx\",\"cap_amb\":\"%016llx\",\"extra_fds\":%d,\"external_interfaces\":%d,\"host_connection_errno\":%d,\"host_connection_denied\":%s,\"devices_match\":%s,\"namespace_limit\":%lu,\"nested_userns_result\":%d,\"nested_userns_errno\":%d,\"nested_userns_denied\":%s,\"no_new_privs\":%d}\n", combined ? "false" : "true", caps[0], caps[1], caps[2], caps[3], caps[4], fds, external_interfaces, connection_error, expected_connection_denial ? "true" : "false", device_error == 0 ? "true" : "false", namespace_limit, nested_result, nested_error, nested_userns_denied ? "true" : "false", no_new_privs);
  if (!expected_connection_denial) return 2;
  return combined || fds || external_interfaces || device_error || !nested_userns_denied || no_new_privs != 1;
}
