import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { resolveMsbHome } from "../src/config/msb-home.ts";

test("Microsandbox home chooses the first configured source", async (t) => {
  const root = await realpath(await mkdtemp("/tmp/ab-home-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envHome = join(root, "env");
  const userHome = join(root, "user");
  const defaultHome = join(root, ".msb");
  await Promise.all(
    [envHome, userHome, defaultHome].map((path) => mkdir(path)),
  );
  const user = { microsandbox: { home: userHome } };
  assert.deepEqual(
    await resolveMsbHome({ HOME: root, MSB_HOME: envHome }, user),
    {
      path: envHome,
      source: "env",
    },
  );
  assert.deepEqual(await resolveMsbHome({ HOME: root, MSB_HOME: "" }, user), {
    path: userHome,
    source: "user",
  });
  assert.deepEqual(await resolveMsbHome({ HOME: root }, {}), {
    path: defaultHome,
    source: "default",
  });
  const invalid = await resolveMsbHome(
    { HOME: root, MSB_HOME: "relative" },
    user,
  );
  assert.ok("status" in invalid);
  assert.equal(invalid.status, "wrong");
  const missing = await resolveMsbHome(
    { HOME: root },
    { microsandbox: { home: join(root, "missing") } },
  );
  assert.ok("status" in missing);
  assert.equal(missing.status, "missing");
});

test("every Microsandbox home source validates the directory and its real path", async (t) => {
  const root = await realpath(await mkdtemp("/tmp/ab-home-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const short = join(root, "short");
  const long = join(root, "é".repeat(21));
  await Promise.all([mkdir(short), mkdir(long)]);
  const cases = [
    {
      source: "env",
      candidate: (base: string) => base,
      resolve: (base: string) => resolveMsbHome({ MSB_HOME: base }, {}),
    },
    {
      source: "user",
      candidate: (base: string) => base,
      resolve: (base: string) =>
        resolveMsbHome({}, { microsandbox: { home: base } }),
    },
    {
      source: "default",
      candidate: (base: string) => join(base, ".msb"),
      resolve: (base: string) => resolveMsbHome({ HOME: base }, {}),
    },
  ];
  for (const { source, candidate, resolve } of cases) {
    const relative = await resolve("relative");
    assert.ok("status" in relative);
    assert.equal(relative.source, source);
    assert.equal(relative.status, "wrong");
    assert.match(relative.detail, /absolute/);

    const missingBase = join(root, "missing");
    const missing = await resolve(missingBase);
    assert.ok("status" in missing);
    assert.equal(missing.source, source);
    assert.equal(missing.status, "missing");
    assert.deepEqual(missing.fix, [`mkdir -p ${candidate(missingBase)}`]);

    const base = join(root, source);
    if (source === "default") await mkdir(base);
    const link = candidate(base);
    await writeFile(link, "");
    const file = await resolve(base);
    assert.ok("status" in file);
    assert.equal(file.status, "wrong");
    assert.match(file.detail, /must be a directory/);
    await rm(link);
    await symlink(long, link);
    const tooLong = await resolve(base);
    assert.ok("status" in tooLong);
    assert.equal(tooLong.source, source);
    assert.equal(tooLong.status, "wrong");
    assert.match(tooLong.detail, /40 bytes after realpath/);
    await rm(link);
    await symlink(short, link);
    assert.deepEqual(await resolve(base), { path: short, source });
  }
});

test("missing home guidance quotes shell syntax and suppresses terminal controls", async (t) => {
  const root = await realpath(await mkdtemp("/tmp/ab-home-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const quoted = await resolveMsbHome({ MSB_HOME: join(root, "a'b $c") }, {});
  assert.ok("fix" in quoted);
  assert.deepEqual(quoted.fix, [`mkdir -p '${root}/a'"'"'b $c'`]);
  const control = await resolveMsbHome(
    { MSB_HOME: join(root, "\u001b[2J") },
    {},
  );
  assert.ok("fix" in control);
  assert.deepEqual(control.fix, ['mkdir -p "$MSB_HOME"']);
});
