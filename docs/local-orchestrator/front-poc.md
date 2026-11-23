# Concierge PoC

The PoC ran on a real host on 2026-11-23 with Microsandbox 0.7.16. It ran
all six checks on the base image and reran vsock on the `concierge` image.
The runs used `--no-net` and one VM at a time. All PoC VMs and volumes
were removed afterward, and both reports recorded `cleanupFailures: []`.

```text
MSB_HOME=<short path> bun run spike/local-orchestrator/front-poc.ts --run [--only vsock]
```

Use a short absolute `MSB_HOME` with the required images preloaded. The
script selects `concierge` for vsock when that profile is present and
uses the base image for the other checks.

The vsock rerun used `socat` 1.8.1.3 in the `concierge` profile with image
`localhost/agent-bootstrap/concierge@sha256:fea25f3c0edd801bc8f50edb4701e624233622f7eaf6340fd76461db6a3a86dc`.

| Feature             | Result                                                              | Evidence                                                                                                                                                                                                                                                                                                                                               | Consequence for the Concierge design                                                                                                   |
| ------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| vsock               | Blocked on the base image. Pass on `concierge`.                     | The base image reported `/dev/vsock present`, but BusyBox `nc` lacks AF_VSOCK support. On `concierge`, `socat - VSOCK-CONNECT:2:5000` reached the host Unix socket exposed by `--vsock <path>:5000`. The guest received `ack:ping` and the host reported `host connections: 1`.                                                                        | Use `socat` from `concierge` as the guest relay to the Host API. The guest connects to CID 2.                                          |
| Read-only mount     | Pass.                                                               | `--mount-dir SRC:/repo:ro` denied both overwrite and create with `Read-only file system`. The original host file was unchanged and no new file appeared. The adapter already uses `:ro`, which `--mount-dir` help does not list.                                                                                                                       | Mount the repository snapshot read-only.                                                                                               |
| Named volume        | Pass.                                                               | A second VM read the marker the first VM wrote to the same volume at `/state`.                                                                                                                                                                                                                                                                         | Keep session state on the named volume so the session can continue after VM recreation.                                                |
| Detach and attach   | Pass.                                                               | `msb exec -d` printed a `job_<32 hex>` ID. `msb jobs` listed it as `running`, and `msb attach --read-only` streamed `tick4` through `tick6` before the probe timed out.                                                                                                                                                                                | Use detached jobs and read-only attach to stream their output.                                                                         |
| TTY                 | Initial size and Ctrl-C passed. Live resize remains unverified.     | The guest reported `40 120`. After Ctrl-C interrupted the guest command, the `msb exec -t` client exited in 6–18 ms. After `TIOCSWINSZ` and `SIGWINCH` to the `msb` client, the probe reported `resize to 50 100 observed: false`.                                                                                                                     | Use `msb exec -t` for the interactive session. Live resize appears to be unforwarded. Recheck it manually with Claude Code in Stage 1. |
| Secret modification | Both modify commands passed. Rotation at egress remains unverified. | The initial guest check reported `different`, indicating a placeholder in place of the host value. `msb modify --secret` succeeded with and without `--restart`. The VM remained usable and the guest placeholder stayed unchanged in both cases. The real substituted value is observable at egress, which `--no-net` prevented the PoC from testing. | On credential expiry, recreate the VM and reuse the named volume to continue the session.                                              |

The base-image report captured these lines from `msb modify --help`:

```text
Usage: msb modify [OPTIONS] <NAME>
--secret <NAME[:OPTIONS]@HOST[,HOST...]>
Add or rotate a secret from a host environment variable (`NAME[:OPTIONS]@HOST[,HOST...]`).
--next-start
Save changes for the next start without mutating a running VM
--restart
Restart if needed so restart-required changes become active now
```
