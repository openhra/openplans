#!/usr/bin/env node
import { createDatabase } from "../db/database.js";
import { runWorker } from "./commands.js";

process.exitCode = await runWorker(process.argv.slice(2), createDatabase, {
  out: (message) => console.log(message),
  error: (message) => console.error(message),
});
