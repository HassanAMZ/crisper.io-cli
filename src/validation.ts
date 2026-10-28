import { CliError, EXIT } from "./errors.js";

/** Reject selectors before loading a session, which can refresh over the network. */
export function validateOrg(value: string | undefined) {
  if (
    value !== undefined &&
    (!/^org_[A-Za-z0-9]{10,64}$/.test(value) || value.trim() !== value)
  )
    throw new CliError("INVALID_ARGUMENT", "Invalid organization ID.", {
      exit: EXIT.usage,
      next: "Organization IDs look like org_… Run `crisper orgs list`.",
    });
}

export function validateSite(value: string | undefined) {
  if (
    value !== undefined &&
    (!value ||
      value.length > 253 ||
      /[\s\u0000-\u001f\u007f-\u009f]/.test(value))
  )
    throw new CliError("INVALID_ARGUMENT", "Invalid website ID or domain.", {
      exit: EXIT.usage,
      next: "Use a website ID or domain with no whitespace or control characters, at most 253 characters. Run `crisper sites list`.",
    });
}

/** A normalized domain must be a hostname, never a URL, port, or shell text. */
export function validateDomain(domain: string) {
  const labels = domain.split(".");
  if (
    domain.length > 253 ||
    /[^a-z0-9.-]/.test(domain) ||
    labels.length < 2 ||
    labels.some(
      (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )
  )
    throw new CliError("INVALID_ARGUMENT", "Invalid website domain.", {
      exit: EXIT.usage,
      next: "Use a hostname such as example.com, with at least one dot and no leading or trailing hyphens in its labels.",
    });
}
