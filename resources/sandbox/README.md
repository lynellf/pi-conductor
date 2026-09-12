# Capability probe v1

capability-probe-v1.c is a fixed native probe, compiled by a trusted operator
outside conductor with a clean environment, then copied into the prepared runtime
as /opt/pi-conductor/probes/capability-probe-v1 and included in its approved
inventory digest. For example: env -i PATH=/usr/bin:/bin LANG=C /usr/bin/cc
-std=c11 -O2 -Wall -Wextra -Werror capability-probe-v1.c -o
capability-probe-v1. Conductor never compiles, installs, downloads, or chooses
this executable; runtime admission must require its fixed path and approved hash.
