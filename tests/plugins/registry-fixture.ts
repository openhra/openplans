import type { JSONValue } from "@tufjs/models/dist/utils/index.js";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Key,
  Metadata,
  MetaFile,
  Root,
  Signature,
  Snapshot,
  TargetFile,
  Targets,
  Timestamp,
} from "@tufjs/models";
import { z } from "zod";
import { Role } from "@tufjs/models/dist/role.js";
import {
  signaturePayload,
  PUBLISHER_YEAR,
  REAUTHORIZE,
  yankSchema,
  tombstoneSchema,
} from "../../src/plugins/registry/publisher-keys.js";
import type {
  Publisher,
  PublisherSignature,
} from "../../src/plugins/registry/publisher-keys.js";
import { inventory } from "../../src/plugins/package/files.js";
import { writeArchive } from "../../src/plugins/package/archive.js";
import { seal, syntheticPlugin } from "./package-fixture.js";

export const TWO_DAYS = 172800000;
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export const serialize = (metadata: { toJSON(): unknown }) =>
  Buffer.from(JSON.stringify(metadata.toJSON()));
function syntheticKey() {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ format: "jwk" });
  const key = new Key({
    keyID: `synthetic-${randomUUID()}`,
    keyType: "ed25519",
    scheme: "ed25519",
    keyVal: { public: Buffer.from(publicKey.x!, "base64url").toString("hex") },
  });
  return {
    key,
    privateKey: pair.privateKey,
    signer: (bytes: Buffer) =>
      new Signature({
        keyID: key.keyID,
        sig: sign(null, bytes, pair.privateKey).toString("hex"),
      }),
  };
}
export function syntheticKeys() {
  return {
    roots: [syntheticKey(), syntheticKey(), syntheticKey()],
    timestamp: syntheticKey(),
    snapshot: syntheticKey(),
    targets: syntheticKey(),
  };
}
type Keys = ReturnType<typeof syntheticKeys>;
const fields = (version: number, expires: number) => ({
  version,
  expires: new Date(expires).toISOString(),
  specVersion: "1.0.31",
});
export function rootMetadata(
  version: number,
  keys: Keys,
  signers = keys.roots.slice(0, 2),
) {
  const root = new Metadata(
    new Root({
      ...fields(version, Date.now() + 365 * (TWO_DAYS / 2)),
      roles: {
        root: new Role({
          keyIDs: keys.roots.map((key) => key.key.keyID),
          threshold: 2,
        }),
        timestamp: new Role({
          keyIDs: [keys.timestamp.key.keyID],
          threshold: 1,
        }),
        snapshot: new Role({ keyIDs: [keys.snapshot.key.keyID], threshold: 1 }),
        targets: new Role({ keyIDs: [keys.targets.key.keyID], threshold: 1 }),
      },
      keys: Object.fromEntries(
        [...keys.roots, keys.timestamp, keys.snapshot, keys.targets].map(
          ({ key }) => [key.keyID, key],
        ),
      ),
    }),
  );
  for (const signer of signers) root.sign(signer.signer, true);
  return root;
}
function meta(metadata: { signed: { version: number }; toJSON(): unknown }) {
  const bytes = serialize(metadata);
  return new MetaFile({
    version: metadata.signed.version,
    length: bytes.length,
    hashes: { sha256: digest(bytes) },
  });
}

/** Synthetic test repositories only. Keys live in memory for the life of each fixture. */
export class SyntheticRegistry {
  keys = syntheticKeys();
  rootVersion = 1;
  publisherKey = syntheticKey();
  publisher: Publisher = {
    id: "123",
    namespaces: ["synthetic"],
    firstParty: false,
    suspended: false,
    generation: 1,
    keys: [
      {
        keyid: this.publisherKey.key.keyID,
        public: this.publisherKey.key.keyVal.public!,
        enrolledAt: Math.floor(Date.now() / 1000) - 100,
        notBefore: Math.floor(Date.now() / 1000) - 100,
        notAfter: Math.floor(Date.now() / 1000) - 100 + PUBLISHER_YEAR,
        authorizations: [
          {
            notBefore: Math.floor(Date.now() / 1000) - 100,
            notAfter: Math.floor(Date.now() / 1000) - 100 + REAUTHORIZE,
          },
        ],
        retiredAt: null,
        revokedAt: null,
      },
    ],
  };
  readonly directory: string;
  readonly url: string;
  readonly rootFile: string;
  readonly metadata: string;
  readonly targets: string;
  readonly targetPath = "packages/synthetic/registry/1.0.0.tgz";
  body = Buffer.alloc(0);
  constructor(
    readonly base: string,
    readonly name = "@synthetic/registry",
  ) {
    this.directory = join(base, "repository");
    this.url = pathToFileURL(this.directory + "/").href;
    this.rootFile = join(base, "bootstrap-root.json");
    this.metadata = join(this.directory, "metadata");
    this.targets = join(this.directory, "targets");
  }
  async initialize(sentinel?: string) {
    await mkdir(this.metadata, { recursive: true });
    await mkdir(this.targets, { recursive: true });
    const root = rootMetadata(1, this.keys);
    await writeFile(this.rootFile, serialize(root));
    await writeFile(join(this.metadata, "1.root.json"), serialize(root));
    const plugin = await syntheticPlugin(this.name);
    try {
      if (sentinel) {
        const source = await readFile(
          join(plugin.root, "dist/index.js"),
          "utf8",
        );
        await writeFile(
          join(plugin.root, "dist/index.js"),
          `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "synthetic imported");\n${source}`,
        );
      }
      await seal(plugin.root, plugin.manifest);
      const archive = join(this.base, "synthetic.tgz");
      await writeArchive(
        plugin.root,
        await inventory(plugin.root, 50 * 1024 * 1024),
        archive,
      );
      this.body = await readFile(archive);
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(plugin.root, { recursive: true, force: true });
    }
    this.publisher.namespaces = [this.name.slice(1).split("/")[0]!];
    await this.publish();
    return this;
  }
  async trust(dataDir: string, url = this.url) {
    await mkdir(join(dataDir, "registries"), { recursive: true });
    await writeFile(
      join(dataDir, "registries/trust.json"),
      JSON.stringify({
        version: 1,
        registries: [{ url, root: this.rootFile }],
      }),
    );
  }
  async rotate(
    next = syntheticKeys(),
    signers = [...this.keys.roots.slice(0, 2), ...next.roots.slice(0, 2)],
  ) {
    this.rootVersion += 1;
    await writeFile(
      join(this.metadata, `${this.rootVersion}.root.json`),
      serialize(rootMetadata(this.rootVersion, next, signers)),
    );
    this.keys = next;
  }
  async publish(
    options: {
      publisher?: Publisher;
      signature?: PublisherSignature;
      publishedAt?: number;
      yanked?: {
        at: number;
        reason: "operator" | "publisher_key_revoked";
      } | null;
      tombstone?: { at: number; reason: "secrets" | "rights" | "abuse" } | null;
      version?: number;
      snapshotVersion?: number;
      targetsVersion?: number;
      issuedAt?: number;
      expiresAt?: number;
      targetPath?: string;
      targetLength?: number;
      targetHash?: string;
      targetsSigner?: Keys["targets"];
      timestampSigner?: Keys["timestamp"];
      identityName?: string;
      packageVersion?: string;
      additionalTargets?: TargetFile[];
      extraTargets?: number;
      delegations?: boolean;
      provenance?: JSONValue;
    } = {},
  ) {
    const version = options.version ?? 1;
    const issued = options.issuedAt ?? Date.now();
    const expires = options.expiresAt ?? issued + TWO_DAYS;
    const targetPath = options.targetPath ?? this.targetPath;
    const publishedAt = options.publishedAt ?? Math.floor(Date.now() / 1000);
    const binding = {
      name: options.identityName ?? this.name,
      version: options.packageVersion ?? "1.0.0",
      sha256: options.targetHash ?? digest(this.body),
    };
    const signature = options.signature ?? {
      keyid: this.publisherKey.key.keyID,
      signedAt: publishedAt,
      sig: sign(
        null,
        signaturePayload(binding, publishedAt),
        this.publisherKey.privateKey,
      ).toString("hex"),
    };
    const info = new TargetFile({
      path: targetPath,
      length: options.targetLength ?? this.body.length,
      hashes: { sha256: options.targetHash ?? digest(this.body) },
      unrecognizedFields: {
        custom: {
          openplans: {
            name: options.identityName ?? this.name,
            version: options.packageVersion ?? "1.0.0",
            yanked: options.yanked ?? null,
            tombstone: options.tombstone ?? null,
            summary: "Synthetic registry plugin",
            publisher: this.publisher.id,
            publishedAt,
            signature,
            ...(options.provenance ? { provenance: options.provenance } : {}),
          },
        },
      },
    });
    const targets = new Metadata(
      new Targets({
        ...fields(
          options.targetsVersion ?? version,
          Date.now() + 30 * TWO_DAYS,
        ),
        targets: { [targetPath]: info },
        unrecognizedFields: {
          openplans: {
            publishers: {
              [this.publisher.id]: options.publisher ?? this.publisher,
            },
          },
        },
      }),
    );
    for (const target of options.additionalTargets ?? []) {
      const identity = z
        .object({
          name: z.string(),
          version: z.string(),
          summary: z.string(),
          yanked: yankSchema.nullish(),
          tombstone: tombstoneSchema.nullish(),
        })
        .parse(target.custom.openplans);
      target.unrecognizedFields.custom = {
        openplans: {
          ...identity,
          yanked: identity.yanked ?? null,
          tombstone: identity.tombstone ?? null,
          publisher: this.publisher.id,
          publishedAt,
          signature: {
            keyid: this.publisherKey.key.keyID,
            signedAt: publishedAt,
            sig: sign(
              null,
              signaturePayload(
                {
                  name: identity.name,
                  version: identity.version,
                  sha256: target.hashes.sha256!,
                },
                publishedAt,
              ),
              this.publisherKey.privateKey,
            ).toString("hex"),
          },
        },
      };
      targets.signed.addTarget(target);
    }
    for (let i = 0; i < (options.extraTargets ?? 0); i++) {
      targets.signed.addTarget(
        new TargetFile({
          path: `extra/${i}.tgz`,
          length: this.body.length,
          hashes: { sha256: digest(this.body) },
          unrecognizedFields: {
            custom: {
              openplans: {
                name: `@synthetic/extra-${i}`,
                version: "1.0.0",
                summary: "Synthetic extra plugin",
              },
            },
          },
        }),
      );
    }
    if (options.delegations)
      targets.signed.unrecognizedFields.delegations = { keys: {}, roles: [] };
    targets.sign((options.targetsSigner ?? this.keys.targets).signer);
    const snapshot = new Metadata(
      new Snapshot({
        ...fields(
          options.snapshotVersion ?? version,
          Date.now() + 30 * TWO_DAYS,
        ),
        meta: { "targets.json": meta(targets) },
      }),
    );
    snapshot.sign(this.keys.snapshot.signer);
    const timestamp = new Metadata(
      new Timestamp({
        ...fields(version, expires),
        snapshotMeta: meta(snapshot),
        unrecognizedFields: { issued_at: new Date(issued).toISOString() },
      }),
    );
    timestamp.sign((options.timestampSigner ?? this.keys.timestamp).signer);
    await writeFile(
      join(this.metadata, `${targets.signed.version}.targets.json`),
      serialize(targets),
    );
    await writeFile(
      join(this.metadata, `${snapshot.signed.version}.snapshot.json`),
      serialize(snapshot),
    );
    await writeFile(
      join(this.metadata, "timestamp.json"),
      serialize(timestamp),
    );
    // Unsafe target names are metadata-only negative fixtures and never become disk paths.
    if (targetPath === this.targetPath) {
      const targetFile = join(
        this.targets,
        posix.dirname(targetPath),
        `${info.hashes.sha256}.${basename(targetPath)}`,
      );
      await mkdir(join(this.targets, posix.dirname(targetPath)), {
        recursive: true,
      });
      await writeFile(targetFile, this.body);
    }
    return { targets, snapshot, timestamp, info };
  }
}
