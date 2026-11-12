#!/usr/bin/env node
import { dataDirectory } from "./census.js";
import { openState } from "./open.js";
import { prepareOpenSnapshot, startOpenHostStorage } from "./open-store.js";

/**
 * Run by geocoder.sh before prepare-open.py. With a remote snapshot store it prints the
 * directory to mount as the raw input: a private copy of the extract fetched down from the
 * store, acquired into the store first when missing. With the local store it prints nothing and
 * reads or writes nothing; geocoder.sh mounts raw/open-geocoder as before.
 */
const [state, flag, snapshot, ...extra] = process.argv.slice(2);
if (flag !== "--snapshot" || !/^\d{6}$/.test(snapshot ?? "") || extra.length)
  throw new Error("Usage: open-store-cli TX|FL|NC --snapshot YYMMDD");
await startOpenHostStorage();
try {
  const copy = await prepareOpenSnapshot(
    dataDirectory(),
    openState(state ?? ""),
    snapshot!,
  );
  if (copy) console.log(copy);
} catch (error) {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && /^[a-z_]+$/.test(code))
    console.error(`Failure code: ${code}`);
  console.error("Open geocoder extract could not be copied from the store");
  process.exitCode = 1;
}
