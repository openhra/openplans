import type {
  OperatorHost,
  RouteRegistry,
  StatusHost,
} from "@openplans/plugin-sdk";

/** Page lanes own their registrar and use only these dependencies and the request scope. */
export interface AdminPageDependencies {
  readonly routes: RouteRegistry;
  readonly operator?: OperatorHost;
  readonly status: StatusHost;
  readonly now: () => Date;
  /** Operator configuration only. Never render this path or accept it from a request. */
  readonly evidenceMount?: {
    readonly directory: string;
    readonly deploymentId: string;
  };
}
export type AdminPageRegistrar = (dependencies: AdminPageDependencies) => void;

export const ADMIN_NAVIGATION = Object.freeze([
  { path: "/admin", label: "Overview" },
  { path: "/admin/coverage", label: "Coverage and freshness" },
  { path: "/admin/metrics", label: "Metrics" },
  { path: "/admin/configuration", label: "Configuration" },
  { path: "/admin/releases", label: "Releases and recovery" },
  { path: "/admin/customizations", label: "Customizations" },
  { path: "/admin/customizations/versions", label: "Versions" },
  { path: "/admin/customizations/audit", label: "Audit" },
] as const);
