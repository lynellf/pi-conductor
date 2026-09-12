/* Trusted test-only FD observer for Issue #106 §6. */
#include <dirent.h>
#include <stdlib.h>
#include <unistd.h>
int main(void) {
  DIR *directory = opendir("/proc/self/fd");
  if (directory == NULL) return 2;
  const int own = dirfd(directory);
  int extras = 0;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (entry->d_name[0] == '.') continue;
    const int descriptor = atoi(entry->d_name);
    if (descriptor > 2 && descriptor != own) extras++;
  }
  closedir(directory);
  return extras == 0 ? 0 : 91;
}
