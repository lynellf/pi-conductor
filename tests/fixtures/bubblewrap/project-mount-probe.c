#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int write_exact(const char *path, const char *text, int flags) {
  int fd = open(path, flags, 0600);
  if (fd < 0) return -1;
  size_t size = strlen(text);
  ssize_t wrote = write(fd, text, size);
  int saved = errno;
  close(fd);
  errno = saved;
  return wrote == (ssize_t)size ? 0 : -1;
}

static int expect_denied(int result) {
  return result == -1 && (errno == EROFS || errno == EACCES || errno == EBUSY);
}

static int content_is(const char *path, const char *expected) {
  char buffer[64] = {0};
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return 0;
  ssize_t length = read(fd, buffer, sizeof(buffer) - 1);
  close(fd);
  return length >= 0 && strcmp(buffer, expected) == 0;
}

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  if (strcmp(argv[1], "first") == 0) {
    if (access("/workspace/.git", F_OK) == 0) return 10;
    if (!expect_denied(write_exact("/workspace/package.json", "denied", O_WRONLY | O_TRUNC)))
      return 11;
    if (!expect_denied(rename("/workspace/package.json", "/workspace/package.moved"))) return 12;
    if (!expect_denied(mkdir("/workspace/new-root", 0700))) return 13;
    if (!expect_denied(rename("/workspace/src", "/workspace/src-moved"))) return 14;
    if (write_exact("/workspace/src/a.ts", "changed", O_WRONLY | O_TRUNC) != 0) return 15;
    if (write_exact("/workspace/src/new.ts", "persisted", O_WRONLY | O_CREAT | O_EXCL) != 0)
      return 16;
    return 0;
  }
  if (strcmp(argv[1], "second") != 0) return 3;
  if (!content_is("/workspace/src/a.ts", "changed") ||
      !content_is("/workspace/src/new.ts", "persisted"))
    return 20;
  return write_exact("/workspace/src/new.ts", "second", O_WRONLY | O_APPEND) == 0 ? 0 : 21;
}
