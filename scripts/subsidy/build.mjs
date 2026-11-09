#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import {
  generatedFile,
  readParameterFiles,
  registrySource,
} from "./registry.mjs";
// Offline, deterministic embedding only. check.mjs validates all policy fields after npm run build.
await writeFile(generatedFile, registrySource(await readParameterFiles()));
console.log(
  "subsidy registry: built (run npm run build then node scripts/subsidy/check.mjs)",
);
