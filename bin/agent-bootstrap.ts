#!/usr/bin/env -S bun --no-env-file
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapMain } from "../src/onboarding/cli.ts";

const root = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
process.exitCode = await bootstrapMain(process.argv.slice(2), root);
