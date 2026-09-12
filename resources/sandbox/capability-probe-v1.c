/*
 * Fixed operator-prepared capability probe for Issue #106 §5.
 *
 * This source is compiled outside conductor and copied into the approved
 * runtime at /opt/pi-conductor/probes/capability-probe-v1. It accepts only a
 * host-created sentinel path and a localhost port; it never accepts a command.
 */
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

#define MOUNTINFO_MAX (48 * 1024)

static int extra_fds(void) {
  DIR *directory = opendir("/proc/self/fd");
  if (!directory) return -1;
  int own_fd = dirfd(directory);
  int count = 0;
  struct dirent *entry;
  while ((entry = readdir(directory))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    int fd = atoi(entry->d_name);
    if (fd > 2 && fd != own_fd) count++;
  }
  closedir(directory);
  return count;
}

static int expected_devices(void) {
  const char *names[] = {"null", "zero", "full", "random", "urandom", "tty"};
  const unsigned int majors[] = {1, 1, 1, 1, 1, 5};
  const unsigned int minors[] = {3, 5, 7, 8, 9, 0};
  for (int index = 0; index < 6; index++) {
    char path[64];
    struct stat status;
    snprintf(path, sizeof(path), "/dev/%s", names[index]);
    if (lstat(path, &status) || !S_ISCHR(status.st_mode) ||
        major(status.st_rdev) != majors[index] ||
        minor(status.st_rdev) != minors[index]) return -1;
  }

  const char *allowed[] = {
      "null", "zero", "full", "random", "urandom", "tty", "stdin",
      "stdout", "stderr", "fd", "core", "shm", "pts", "ptmx",
  };
  DIR *directory = opendir("/dev");
  if (!directory) return -1;
  int count = 0;
  struct dirent *entry;
  while ((entry = readdir(directory))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    int found = 0;
    for (unsigned int index = 0; index < sizeof(allowed) / sizeof(*allowed); index++) {
      if (!strcmp(allowed[index], entry->d_name)) found = 1;
    }
    if (!found) {
      closedir(directory);
      return -1;
    }
    count++;
  }
  closedir(directory);
  if (count != 14) return -1;

  const char *links[] = {"fd", "stdin", "stdout", "stderr", "core", "ptmx"};
  const char *targets[] = {
      "/proc/self/fd", "/proc/self/fd/0", "/proc/self/fd/1",
      "/proc/self/fd/2", "/proc/kcore", "pts/ptmx",
  };
  for (int index = 0; index < 6; index++) {
    char path[64], target[64];
    snprintf(path, sizeof(path), "/dev/%s", links[index]);
    ssize_t length = readlink(path, target, sizeof(target) - 1);
    if (length < 0 || (size_t)length >= sizeof(target) - 1) return -1;
    target[length] = '\0';
    if (strcmp(target, targets[index])) return -1;
  }
  struct stat pts, shm;
  if (lstat("/dev/pts", &pts) || !S_ISDIR(pts.st_mode) ||
      lstat("/dev/shm", &shm) || !S_ISDIR(shm.st_mode)) return -1;
  return 0;
}

static int host_connection(int port) {
  int fd = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
  if (fd == -1) return -1;
  struct sockaddr_in address = {
      .sin_family = AF_INET,
      .sin_port = htons((unsigned short)port),
      .sin_addr.s_addr = htonl(INADDR_LOOPBACK),
  };
  int result = connect(fd, (struct sockaddr *)&address, sizeof(address));
  int error = errno;
  if (result < 0 && error == EINPROGRESS) {
    struct pollfd poll_fd = {.fd = fd, .events = POLLOUT};
    int ready = poll(&poll_fd, 1, 1000);
    socklen_t length = sizeof(error);
    if (ready <= 0 || getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length)) {
      close(fd);
      return -1;
    }
  } else if (result == 0) {
    error = 0;
  }
  close(fd);
  return error;
}

static int read_capabilities(unsigned long long capabilities[5]) {
  const char *keys[] = {"CapInh:", "CapPrm:", "CapEff:", "CapBnd:", "CapAmb:"};
  unsigned int seen = 0;
  FILE *status = fopen("/proc/self/status", "r");
  if (!status) return -1;
  char line[512];
  while (fgets(line, sizeof(line), status)) {
    for (int index = 0; index < 5; index++) {
      size_t length = strlen(keys[index]);
      if (!strncmp(line, keys[index], length)) {
        if (sscanf(line + length, "%llx", &capabilities[index]) != 1) {
          fclose(status);
          return -1;
        }
        seen |= 1U << index;
      }
    }
  }
  fclose(status);
  return seen == 31 ? 0 : -1;
}

static int external_interfaces(void) {
  struct ifaddrs *interfaces = NULL;
  if (getifaddrs(&interfaces)) return -1;
  int count = 0;
  for (struct ifaddrs *item = interfaces; item; item = item->ifa_next) {
    if (!(item->ifa_flags & IFF_LOOPBACK)) count++;
  }
  freeifaddrs(interfaces);
  return count;
}

static int read_namespace(const char *name, char value[64]) {
  char path[64];
  snprintf(path, sizeof(path), "/proc/self/ns/%s", name);
  ssize_t length = readlink(path, value, 63);
  if (length < 1 || length >= 63) return -1;
  value[length] = '\0';
  return 0;
}

static int read_mountinfo(char value[MOUNTINFO_MAX + 1]) {
  int fd = open("/proc/self/mountinfo", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  size_t used = 0;
  while (used < MOUNTINFO_MAX - 1) {
    ssize_t count = read(fd, value + used, MOUNTINFO_MAX - 1 - used);
    if (count < 0) {
      close(fd);
      return -1;
    }
    if (count == 0) break;
    used += (size_t)count;
  }
  close(fd);
  if (used == MOUNTINFO_MAX - 1) return -1;
  value[used] = '\0';
  return used > 0 ? 0 : -1;
}

static void print_json_string(const char *value) {
  putchar('"');
  for (const unsigned char *character = (const unsigned char *)value; *character; character++) {
    switch (*character) {
      case '"': fputs("\\\"", stdout); break;
      case '\\': fputs("\\\\", stdout); break;
      case '\n': fputs("\\n", stdout); break;
      case '\r': fputs("\\r", stdout); break;
      case '\t': fputs("\\t", stdout); break;
      default:
        if (*character < 0x20) printf("\\u%04x", *character);
        else putchar(*character);
    }
  }
  putchar('"');
}

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  char *port_end = NULL;
  errno = 0;
  long parsed_port = strtol(argv[1], &port_end, 10);
  if (errno || port_end == argv[1] || *port_end != '\0' ||
      parsed_port < 1 || parsed_port > 65535) return 2;

  /*
   * Count inherited descriptors before this process opens probe inputs.
   * The directory descriptor is excluded from its own enumeration.
   */
  int fds = extra_fds();
  if (fds < 0) return 2;

  unsigned long long capabilities[5] = {0};
  if (read_capabilities(capabilities)) return 2;
  unsigned long long combined = capabilities[0] | capabilities[1] |
      capabilities[2] | capabilities[3] | capabilities[4];
  int interfaces = external_interfaces();
  int connection_errno = host_connection((int)parsed_port);
  int device_status = expected_devices();

  errno = 0;
  int nested_result = unshare(CLONE_NEWUSER);
  int nested_errno = errno;
  int nested_denied = nested_result == -1 &&
      (nested_errno == ENOSPC || nested_errno == EUSERS || nested_errno == EPERM);
  int no_new_privs = prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0);
  int connection_denied = connection_errno == ENETUNREACH ||
      connection_errno == EHOSTUNREACH || connection_errno == ECONNREFUSED;

  errno = 0;
  int sentinel_result = lstat(argv[2], &(struct stat){0});
  int sentinel_errno = sentinel_result == -1 ? errno : 0;
  int sentinel_absent = sentinel_result == -1 && sentinel_errno == ENOENT;

  char mnt[64], user[64], net[64], ipc[64], uts[64], pid[64];
  char mountinfo[MOUNTINFO_MAX + 1];
  if (interfaces < 0 || connection_errno < 0 || no_new_privs < 0 ||
      read_namespace("mnt", mnt) || read_namespace("user", user) ||
      read_namespace("net", net) || read_namespace("ipc", ipc) ||
      read_namespace("uts", uts) || read_namespace("pid", pid) ||
      read_mountinfo(mountinfo)) return 2;

  printf("{\"schema_version\":1,\"capabilities_zero\":%s,"
         "\"cap_inh\":\"%016llx\",\"cap_prm\":\"%016llx\","
         "\"cap_eff\":\"%016llx\",\"cap_bnd\":\"%016llx\","
         "\"cap_amb\":\"%016llx\",\"extra_fds\":%d,"
         "\"external_interfaces\":%d,\"host_connection_errno\":%d,"
         "\"host_connection_denied\":%s,\"devices_match\":%s,"
         "\"nested_userns_result\":%d,\"nested_userns_errno\":%d,"
         "\"nested_userns_denied\":%s,\"no_new_privs\":%d,"
         "\"namespace\":{\"mnt\":\"%s\",\"user\":\"%s\",\"net\":\"%s\","
         "\"ipc\":\"%s\",\"uts\":\"%s\",\"pid\":\"%s\"},"
         "\"mountinfo\":",
         combined ? "false" : "true", capabilities[0], capabilities[1],
         capabilities[2], capabilities[3], capabilities[4], fds, interfaces,
         connection_errno, connection_denied ? "true" : "false",
         device_status == 0 ? "true" : "false", nested_result, nested_errno,
         nested_denied ? "true" : "false", no_new_privs, mnt, user, net, ipc, uts, pid);
  print_json_string(mountinfo);
  printf(",\"sentinel_errno\":%d,\"sentinel_absent\":%s}\n",
         sentinel_errno, sentinel_absent ? "true" : "false");
  fflush(stdout);

  return combined || fds || interfaces || !connection_denied || device_status ||
      !nested_denied || no_new_privs != 1 || !sentinel_absent;
}
