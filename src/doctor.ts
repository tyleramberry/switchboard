/**
 * `switchboard doctor` — lint the secrets manifest and Home health.
 *
 * The red team proved the point of this tool: the LAB test profile (interpreter
 * allowlisted, /usr/bin/curl with args [".*"]) is exactly what doctor flags as
 * ERROR-level before an agent ever runs it. Doctor never reads secret values; it
 * only looks at names, programs, regexes, hosts and pin state.
 */
import { Manifest, SecretSpec } from "./manifest.js";

export type Severity = "error" | "warning" | "info";

export interface DoctorFinding {
  severity: Severity;
  secret?: string;
  message: string;
  hint: string;
}

/** Programs that can be told, via arguments, to send data anywhere. */
const RISKY_PROGRAMS = new Set([
  "curl", "wget", "ftp", "sftp", "ftp-url", "http", "https",
  "openssl", "tee", "mail", "sendmail", "logger", "syslog",
]);

/** Arg patterns that match literally anything. */
function isCatchAll(pattern: string): boolean {
  try {
    const re = new RegExp(`^(?:${pattern})$`);
    // probe strings that only a catch-all accepts
    return re.test("-x 1.2.3.4:9 --data @/etc/passwd -K /tmp/x -o /dev/stdout \"'; rm -rf ~\"");
  } catch {
    return true; // broken regex: parse would have refused it anyway
  }
}

function base(program: string): string {
  return program.split("/").pop() ?? program;
}

function lintSecret(s: SecretSpec): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  const label = s.name;

  if (!s.purpose.trim()) {
    out.push({ severity: "info", secret: label, message: "no purpose text", hint: "add a one-line purpose so future-you knows what this is for" });
  }
  if (s.timeout_sec > 120) {
    out.push({ severity: "info", secret: label, message: `timeout_sec is ${s.timeout_sec}s`, hint: "over 120s a hung allowlisted command holds the door open; lower it if you can" });
  }

  for (const c of s.commands) {
    const b = base(c.program);
    for (const a of c.args) {
      if (!isCatchAll(a)) continue;
      if (s.unsafe_allow_interpreter) {
        out.push({ severity: "error", secret: label, message: `interpreter ${c.program} is allowlisted AND args pattern \`${a}\` matches anything`, hint: "an interpreter can transform the secret into any encoding before it leaves; the scrubber is a seatbelt, not a control. Drop the interpreter, or pin args to one exact command line" });
      } else if (RISKY_PROGRAMS.has(b)) {
        out.push({ severity: "error", secret: label, message: `${c.program} allowlisted with args pattern \`${a}\` that matches anything`, hint: `${b} can be told to send data anywhere (proxy flags, config files, output files). List the exact flag/argument shapes you need, or use http mode with a host allowlist instead` });
      } else {
        out.push({ severity: "warning", secret: label, message: `args pattern \`${a}\` for ${c.program} matches any argument`, hint: `usually fine for harmless programs like echo, but ${b} will be run with the secret in its environment — narrow the pattern if you can` });
      }
    }
  }

  if (s.http && s.unsafe_allow_interpreter) {
    out.push({ severity: "warning", secret: label, message: "http mode and an interpreter allowlist on the same secret", hint: "http mode is the safer path; if you need both, question the interpreter first" });
  }

  for (const h of s.hosts) {
    if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0") {
      out.push({ severity: "info", secret: label, message: `host allowlist contains local address ${h}`, hint: "local servers see the secret; make sure that's intended" });
    }
    if (h.includes("*")) {
      out.push({ severity: "warning", secret: label, message: `host allowlist pattern ${h} uses a wildcard`, hint: "wildcards widen fast (*.example.com also matches not-example.com.junk) — list exact hosts" });
    }
  }

  return out;
}

/** Lint a parsed manifest (values never involved). */
export function lintManifest(m: Manifest): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  for (const s of m.secrets) out.push(...lintSecret(s));
  if (!m.secrets.length) {
    out.push({ severity: "info", message: "no secrets declared", hint: "add entries to secrets.manifest.yaml, then `switchboard pin`" });
  }
  return out;
}

const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function formatFindings(findings: DoctorFinding[]): string[] {
  const lines: string[] = [];
  const sorted = [...findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  let last = "";
  for (const f of sorted) {
    if (f.severity !== last) {
    lines.push("", `${f.severity.toUpperCase()}${f.severity === "error" ? " 🚨" : f.severity === "warning" ? " ⚠️" : " ℹ️"}`);
    last = f.severity;
    }
    const who = f.secret ? `[${f.secret}] ` : "";
    lines.push(`  - ${who}${f.message}`);
    if (f.hint) lines.push(`      → ${f.hint}`);
  }
  return lines;
}
