export type FetchErrorCode =
  | "invalid_options"
  | "admission_required"
  | "admission_denied"
  | "host_busy"
  | "challenge_detected"
  | "invalid_url"
  | "https_required"
  | "embedded_credentials"
  | "blocked_port"
  | "host_not_allowed"
  | "blocked_address"
  | "dns_error"
  | "connect_timeout"
  | "read_timeout"
  | "network_error"
  | "http_status"
  | "too_many_redirects"
  | "invalid_redirect"
  | "too_large"
  | "html_error_page"
  | "truncated"
  | "unsupported_encoding"
  | "cache_error"
  | "snapshot_conflict"
  | "invalid_zip"
  | "zip_bomb"
  | "zip_path_traversal"
  | "zip_symlink";

/** Safe to log: messages deliberately exclude URLs, response bodies and underlying errors. */
export interface FetchEvidence {
  requested_url: string;
  final_url: string;
  redirect_chain: string[];
  response_headers: Record<string, string>;
  status?: number;
  policy?: FetchEvidence;
  attempts: number;
  connect_timeout_ms: number;
  address?: string;
  connection?: {
    phase: "tcp_connect" | "tls_handshake" | "response";
    code?: string;
  };
}
export class FetchError extends Error {
  evidence?: FetchEvidence;
  connection?: FetchEvidence["connection"];
  constructor(
    public readonly code: FetchErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "FetchError";
  }
}
