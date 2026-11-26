#!/bin/sh
set -eu

: "${MSB_HOME:?Set MSB_HOME to a short, dedicated directory with the cached image}"
codex_binary=${1:?Pass the Linux arm64 Codex binary}
case "$codex_binary" in
  /*) ;;
  *) printf 'Use an absolute binary path\n' >&2; exit 2 ;;
esac
test -f "$codex_binary"
digest=$(shasum -a 256 <"$codex_binary")
test "${digest%% *}" = 28c24ad7fb3bf29c95cd66a12e72d2219f06170efefae8b02002ceb50e2866b9
msb=$(command -v msb)
image=docker.io/library/alpine@sha256:5dda816445facf5f7282dc7689a333278834c74265ba25db2e2eb90509e3a9dd

output=$(env -i PATH=/usr/bin:/bin MSB_BACKEND=local MSB_HOME="$MSB_HOME" "$msb" \
  run --pull never --no-net --no-stdin --max-duration 45s \
  --copy-file "$codex_binary:/tmp/codex" "$image" -- /bin/sh -ec '
    chmod 700 /tmp/codex
    /tmp/codex --version
    {
      printf "%s\n" "$@"
      sleep 4
    } | /tmp/codex app-server --listen stdio://
  ' sh \
  '{"id":0,"method":"initialize","params":{"clientInfo":{"name":"agent-bootstrap-m1","version":"0.0.0"},"capabilities":{"experimentalApi":true}}}' \
  '{"method":"initialized"}' \
  '{"id":1,"method":"thread/start","params":{"cwd":"/tmp","ephemeral":true,"environments":[],"approvalPolicy":"never","sandbox":"read-only"}}')

printf '%s\n' "$output" | bun -e '
  import assert from "node:assert/strict";
  const [version, ...lines] = (await Bun.stdin.text()).trim().split("\n");
  assert.equal(version, "codex-cli 0.172.0");
  const messages = lines.map(line => JSON.parse(line));
  const init = messages.find(message => message.id === 0)?.result;
  assert.equal(init?.platformOs, "linux");
  const start = messages.find(message => message.id === 1)?.result;
  assert.equal(start?.thread?.ephemeral, true);
  assert.deepEqual(start?.thread?.environments, []);
  assert.equal(typeof start.thread.id, "string");
  assert.ok(start.thread.id.length > 0);
  assert.equal(start?.approvalPolicy, "never");
  assert.deepEqual(start?.sandbox, { type: "readOnly", networkAccess: false });
  assert.ok(messages.some(message => message.method === "thread/started" &&
    message.params.thread.id === start.thread.id));
  console.log("Codex 0.172.0 initialized and started a read-only thread inside the guest.");
'
