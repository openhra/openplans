import { z } from "zod";

const repository = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .max(201);
const ref = z
  .string()
  .regex(/^refs\/(heads|tags)\/[^\s@]+$/)
  .max(300);
const workflow = z
  .string()
  .regex(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml@[^\s@]+$/,
  )
  .max(600);
export const trustedPublishingSchema = z.strictObject({
  repository,
  repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  ref,
  workflowRef: workflow,
  environment: z.string().min(1).max(200).optional(),
});
export const ciIdentitySchema = trustedPublishingSchema.extend({
  issuer: z.literal("https://token.actions.githubusercontent.com"),
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  runId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  runAttempt: z.string().regex(/^[1-9][0-9]{0,19}$/),
  runnerEnvironment: z.literal("github-hosted"),
});
export type CiIdentity = z.infer<typeof ciIdentitySchema>;
export const BUILD_TYPE =
  "https://plans.openhra.com/registry/buildtypes/github-actions/v1";
export const statementSchema = z.strictObject({
  _type: z.literal("https://in-toto.io/Statement/v1"),
  subject: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(400),
        digest: z.strictObject({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
      }),
    )
    .length(1),
  predicateType: z.literal("https://slsa.dev/provenance/v1"),
  predicate: z.strictObject({
    buildDefinition: z.strictObject({
      buildType: z.literal(BUILD_TYPE),
      externalParameters: z.strictObject({ repository, ref, workflow }),
      resolvedDependencies: z
        .array(
          z.strictObject({
            uri: z.string().max(300),
            digest: z.strictObject({
              gitCommit: z.string().regex(/^[a-f0-9]{40}$/),
            }),
          }),
        )
        .length(1),
    }),
    runDetails: z.strictObject({
      builder: z.strictObject({ id: z.string().max(650) }),
      metadata: z.strictObject({ invocationId: z.string().max(350) }),
    }),
  }),
});
export const provenanceSchema = z.strictObject({
  identity: ciIdentitySchema,
  statement: statementSchema,
});
export type Provenance = z.infer<typeof provenanceSchema>;
export interface ProvenanceBinding {
  name: string;
  version: string;
  sha256: string;
}
export function verifyProvenance(
  input: unknown,
  binding: ProvenanceBinding,
): Provenance {
  const receipt = provenanceSchema.parse(input);
  const { identity, statement } = receipt;
  const check = (ok: boolean, code: string) => {
    if (!ok) throw new Error(code);
  };
  check(
    statement.subject[0]!.name === `${binding.name}@${binding.version}` &&
      statement.subject[0]!.digest.sha256 === binding.sha256,
    "provenance_subject",
  );
  const definition = statement.predicate.buildDefinition;
  const details = statement.predicate.runDetails;
  check(
    details.builder.id === `https://github.com/${identity.workflowRef}`,
    "provenance_builder",
  );
  check(
    definition.externalParameters.repository === identity.repository &&
      definition.externalParameters.ref === identity.ref &&
      definition.externalParameters.workflow === identity.workflowRef,
    "provenance_workflow",
  );
  check(
    definition.resolvedDependencies[0]!.uri ===
      `git+https://github.com/${identity.repository}` &&
      definition.resolvedDependencies[0]!.digest.gitCommit === identity.sha,
    "provenance_source",
  );
  check(
    details.metadata.invocationId ===
      `https://github.com/${identity.repository}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}`,
    "provenance_invocation",
  );
  return receipt;
}
