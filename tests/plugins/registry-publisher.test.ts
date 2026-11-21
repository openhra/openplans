import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { plantMutant } from "../../src/plugins/testing/artifacts.js";
import {
  installRegistryPlugin,
  searchRegistry,
} from "../../src/plugins/registry/client.js";
import type * as PublisherModule from "../../src/plugins/registry/publisher-keys.js";
import {
  signaturePayload,
  verifyPublisherSignature,
} from "../../src/plugins/registry/publisher-keys.js";
import { sign } from "node:crypto";
import {
  rootMetadata,
  serialize,
  SyntheticRegistry,
} from "./registry-fixture.js";

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "registry-publisher-synthetic-"));
  scratch.push(base);
  const repository = await new SyntheticRegistry(base).initialize();
  const dataDir = join(base, "data");
  await repository.trust(dataDir);
  return { repository, options: { url: repository.url, dataDir }, base };
}
it("yank hides search and new installs but permits exact version plus archive digest pins", async () => {
  const { repository: r, options, base } = await fixture();
  const entry = (await searchRegistry("synthetic", options))[0]!;
  await r.publish({
    version: 2,
    yanked: { at: Math.floor(Date.now() / 1000), reason: "operator" },
  });
  expect(await searchRegistry("synthetic", options)).toEqual([]);
  await expect(
    installRegistryPlugin(`${r.name}@1.0.0`, join(base, "new"), options),
  ).rejects.toThrow(/yanked/);
  await expect(
    installRegistryPlugin(`${r.name}@1.0.0`, join(base, "wrong"), {
      ...options,
      pinnedSha256: "0".repeat(64),
    }),
  ).rejects.toThrow(/pin_mismatch/);
  expect(
    (
      await installRegistryPlugin(`${r.name}@1.0.0`, join(base, "pinned"), {
        ...options,
        pinnedSha256: entry.sha256,
      })
    ).approval,
  ).toBe("not_granted");
});
it("revoked later signature must have a signed yank; before-cutoff signature and pinned yank remain installable", async () => {
  const { repository: r, options, base } = await fixture();
  const entry = (await searchRegistry("synthetic", options))[0]!;
  r.publisher.keys[0]!.revokedAt = entry.signature.signedAt - 1;
  await r.publish({
    version: 2,
    signature: entry.signature,
    publishedAt: entry.publishedAt,
  });
  await expect(searchRegistry("synthetic", options)).rejects.toThrow(
    /revocation_yank_missing/,
  );
  await r.publish({
    version: 3,
    signature: entry.signature,
    publishedAt: entry.publishedAt,
    yanked: { at: entry.publishedAt, reason: "publisher_key_revoked" },
  });
  expect(await searchRegistry("synthetic", options)).toEqual([]);
  await installRegistryPlugin(`${r.name}@1.0.0`, join(base, "pinned"), {
    ...options,
    pinnedSha256: entry.sha256,
  });
  r.publisher.keys[0]!.revokedAt = entry.signature.signedAt;
  await r.publish({
    version: 4,
    signature: entry.signature,
    publishedAt: entry.publishedAt,
  });
  expect(await searchRegistry("synthetic", options)).toHaveLength(1);
});
it("tombstone refuses pinned downloads clearly even when the archive bytes still exist", async () => {
  const { repository: r, options, base } = await fixture();
  const entry = (await searchRegistry("synthetic", options))[0]!;
  await r.publish({
    version: 2,
    tombstone: { at: entry.publishedAt, reason: "secrets" },
  });
  expect(await searchRegistry("synthetic", options)).toEqual([]);
  await expect(
    installRegistryPlugin(`${r.name}@1.0.0`, join(base, "plugins"), {
      ...options,
      pinnedSha256: entry.sha256,
    }),
  ).rejects.toThrow("registry_package_deleted:secrets");
});
it.each([
  "late-enrollment",
  "receipt-window",
  "expired-key",
  "authorization-lapse",
  "retro-signing",
  "wrong-namespace",
  "forged-signature",
])("client refuses %s evidence", async (kind) => {
  const { repository: r, options } = await fixture();
  const entry = (await searchRegistry("synthetic", options))[0]!;
  const publisher = structuredClone(r.publisher);
  const key = publisher.keys[0]!;
  const signature = { ...entry.signature };
  if (kind === "late-enrollment") key.enrolledAt = entry.publishedAt + 1;
  if (kind === "receipt-window") {
    key.notAfter = entry.publishedAt;
    signature.signedAt--;
  }
  if (kind === "expired-key") key.notAfter = entry.publishedAt - 1;
  if (kind === "authorization-lapse")
    key.authorizations[0]!.notAfter = entry.publishedAt;
  if (kind === "retro-signing") signature.signedAt = entry.publishedAt - 61;
  if (kind === "wrong-namespace") publisher.namespaces = ["elsewhere"];
  if (kind === "forged-signature") signature.sig = "0".repeat(128);
  else
    signature.sig = sign(
      null,
      signaturePayload(entry, signature.signedAt),
      r.publisherKey.privateKey,
    ).toString("hex");
  await r.publish({
    version: 2,
    publisher,
    signature,
    publishedAt: entry.publishedAt,
  });
  await expect(searchRegistry("synthetic", options)).rejects.toThrow(
    /publisher_/,
  );
});
it("authorization lapse after publication does not expire existing installs", async () => {
  const { repository: r, options, base } = await fixture();
  const entry = (await searchRegistry("synthetic", options))[0]!;
  const publisher = structuredClone(r.publisher);
  publisher.keys[0]!.authorizations[0]!.notAfter = entry.publishedAt + 1;
  await r.publish({
    version: 2,
    publisher,
    signature: entry.signature,
    publishedAt: entry.publishedAt,
  });
  expect(await searchRegistry("synthetic", options)).toHaveLength(1);
  await installRegistryPlugin(
    `${r.name}@1.0.0`,
    join(base, "plugins"),
    options,
  );
});
it("a mutant skipping the receipt-time window fails the same client assertion", async () => {
  const { repository: r, options } = await fixture();
  const entry = (await searchRegistry("synthetic", options))[0]!;
  const publisher = structuredClone(r.publisher);
  publisher.keys[0]!.notAfter = entry.publishedAt;
  const signature = { ...entry.signature, signedAt: entry.publishedAt - 1 };
  signature.sig = sign(
    null,
    signaturePayload(entry, signature.signedAt),
    r.publisherKey.privateKey,
  ).toString("hex");
  expect(() =>
    verifyPublisherSignature(publisher, entry, signature, entry.publishedAt),
  ).toThrow(/publisher_key_window/);
  const source = new URL(
    "../../src/plugins/registry/publisher-keys.ts",
    import.meta.url,
  );
  const original = await readFile(source, "utf8");
  const mutant = await plantMutant(
    source,
    original,
    original.replace(
      "[signature.signedAt, publishedAt]",
      "[signature.signedAt]",
    ),
  );
  try {
    const module = (await import(
      /* @vite-ignore */ pathToFileURL(mutant.path).href
    )) as typeof PublisherModule;
    expect(() =>
      expect(() =>
        module.verifyPublisherSignature(
          publisher,
          entry,
          signature,
          entry.publishedAt,
        ),
      ).toThrow(/publisher_key_window/),
    ).toThrow();
  } finally {
    await mutant.cleanup();
  }
});

it("client requires all three declared root keys to exist even when two signatures verify", async () => {
  const { repository: r, options } = await fixture();
  const root = rootMetadata(1, r.keys);
  delete root.signed.keys[r.keys.roots[2]!.key.keyID];
  root.signatures = {};
  for (const key of r.keys.roots.slice(0, 2)) root.sign(key.signer, true);
  root.verifyDelegate("root", root);
  await writeFile(r.rootFile, serialize(root));
  await expect(searchRegistry("synthetic", options)).rejects.toThrow(
    /root_policy/,
  );
});

it("retirement retains a release accepted in the retirement second and refuses later receipts", async () => {
  const { repository: r, options, base } = await fixture();
  const entry = (await searchRegistry("synthetic", options))[0]!;
  r.publisher.keys[0]!.retiredAt = entry.publishedAt;
  await r.publish({
    version: 2,
    signature: entry.signature,
    publishedAt: entry.publishedAt,
  });
  await installRegistryPlugin(
    `${r.name}@1.0.0`,
    join(base, "existing"),
    options,
  );
  await r.publish({ version: 3, publishedAt: entry.publishedAt + 1 });
  await expect(searchRegistry("synthetic", options)).rejects.toThrow(
    /publisher_key_window/,
  );
});
