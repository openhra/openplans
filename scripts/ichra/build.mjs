#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import {
  generatedFile,
  readParameterFiles,
  registrySource,
} from "./registry.mjs";
// Offline, deterministic embedding only; tests/domain/ichra checks freshness and citations.
await writeFile(generatedFile, registrySource(await readParameterFiles()));
console.log("ichra registry: built");
