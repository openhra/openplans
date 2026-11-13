interface SourceControl {
  path: string;
  before: string;
  after: string;
}
export const sourceControls: Record<
  | "dental"
  | "csr"
  | "communityGuard"
  | "filedFamilyCell"
  | "alaskaFpl"
  | "zctaPriority"
  | "mcpPlanKey",
  SourceControl
>;
export function mutateSource(source: string, control: SourceControl): string;
