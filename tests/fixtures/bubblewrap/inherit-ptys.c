/* Test-only launcher for issue #109; never touches the caller's terminal FDs. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 3) return 64;
  int cloexec = strcmp(argv[1], "cloexec") == 0;
  if (!cloexec && strcmp(argv[1], "inherit") != 0) return 64;
  const int targets[] = {34, 35, 255};
  for (unsigned int index = 0; index < sizeof targets / sizeof *targets; index++) {
    int target = targets[index];
    errno = 0;
    if (fcntl(target, F_GETFD) != -1 || errno != EBADF) {
      fprintf(stderr, "refusing to replace existing descriptor %d\n", target);
      return 65;
    }
    int fd = open("/dev/ptmx", O_RDWR | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0 || dup2(fd, target) < 0) {
      perror("pty setup");
      return 66;
    }
    if (fd != target) close(fd);
    if (fcntl(target, F_SETFD, cloexec ? FD_CLOEXEC : 0) < 0) return 67;
  }
  execv(argv[2], argv + 2);
  perror("execv");
  return 68;
}
