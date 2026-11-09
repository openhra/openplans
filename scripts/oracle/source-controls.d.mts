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
  | "zctaPriority",
  SourceControl
>;
export function mutateSource(source: string, control: SourceControl): string;
