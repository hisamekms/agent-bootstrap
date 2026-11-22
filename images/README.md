# Profile images

`images/profiles.lock.json` pins the built profile images. It is written by
the builder and read by `parseProfileLock` in `src/profile-lock.ts`.

## 1. Fetch packages (needs operator approval)

Packages come from Alpine 3.23 `main`, aarch64, into
`.local/alpine/v3.23/main/aarch64/`:

    https://dl-cdn.alpinelinux.org/alpine/v3.23/main/aarch64/<file>.apk

The file names and SHA-256 values are in `src/image-recipes.ts`. The builder
rejects any file whose digest differs.

The `browser` profile (Debian 13 slim) needs no local files: the build VM
fetches packages from a fixed `snapshot.debian.org` timestamp and may reach
only DNS and `snapshot.debian.org:80`. Its first build needs operator
approval for that egress.

## 2. Build

    MSB_HOME=<abs path> bun spike/images/build-profile.ts <abs msb path> db   # or: browser

The build VM has no network. `apk` verifies each signature with the Alpine
keys in the base image (never `--allow-untrusted`). The builder loads the
image, checks the digest, runs a smoke test (SQLite and PostgreSQL), and
updates the lock. Set `IMAGE_DEBUG=1` for full errors.

## 3. The lock

Each entry holds the image reference (`localhost/agent-bootstrap/<name>@sha256:...`),
the recipe digest, and memory and CPU limits. Debian profiles also list the
installed `name=version` packages. A change to the recipe makes the
lock stale and `parseProfileLock` refuses it until you rebuild. Rebuilding is a
deliberate change: review the lock diff and commit it.
