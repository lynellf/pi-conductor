/** Closed host Git environment and configuration for sandbox preparation (#106 §4). */

/** Construct a Git environment without inherited configuration or credentials. */
export function trustedGitEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: "/nonexistent",
    XDG_CONFIG_HOME: "/nonexistent",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GIT_ALLOW_PROTOCOL: "",
    GIT_EXTERNAL_DIFF: "",
  };
}

/** Fixed defensive configuration for the adapter's closed filter-free command set. */
export function trustedGitConfig(): readonly string[] {
  return [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "core.autocrlf=false",
    "-c",
    "diff.external=",
    "-c",
    "diff.trustExitCode=false",
    "-c",
    "submodule.recurse=false",
    "-c",
    "fetch.recurseSubmodules=false",
    "-c",
    "protocol.allow=never",
    "-c",
    "credential.helper=",
  ];
}
