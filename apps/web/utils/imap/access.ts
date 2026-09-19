import { env } from "@/env";
import { SafeError } from "@/utils/error";

export function assertImapAccess(host: string, security: string) {
  if (!env.NEXT_PUBLIC_ENABLE_IMAP) {
    throw new SafeError("IMAP is disabled on this installation.");
  }
  const allowed = env.IMAP_ALLOWED_HOSTS.split(",").map((value) =>
    value.trim().toLowerCase(),
  );
  if (!allowed.includes(host.toLowerCase())) {
    throw new SafeError("This mail server is not in IMAP_ALLOWED_HOSTS.");
  }
  if (security !== "tls" && security !== "starttls") {
    throw new SafeError("IMAP and SMTP connections require TLS.");
  }
}
