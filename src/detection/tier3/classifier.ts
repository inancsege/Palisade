import type { ToolCall } from '../../types/proxy.js';
import type {
  FilesystemPolicy,
  NetworkEgressPolicy,
  ShellExecPolicy,
  ToolPolicy,
} from '../../types/policy.js';

export type Capability = 'network_egress' | 'filesystem' | 'shell_exec';

export interface CapabilityViolation {
  capability: Capability;
  detail: string;
  value: string;
}

export interface CapabilityVerdict {
  /**
   * True when at least one capability was actually evaluated for this call.
   * False for unclassifiable tools — the engine decides those via `unknown_tool`.
   */
  evaluated: boolean;
  allowed: boolean;
  violations: CapabilityViolation[];
}

// Name-derived capability hints. A tool's manifest declarations are the authority:
// a declared capability is always evaluated; undeclared ones are evaluated only
// when the name hints at them, against the global defaults.
const NETWORK_NAME_RE = /(fetch|http|request|curl|wget|browse|search|scrape|web|url|net|api|socket|download|graphql)/i;
const FILESYSTEM_NAME_RE = /(file|fs|read|write|edit|save|open|create|delete|append|move|copy|mkdir|rmdir|\brm\b|ls|cat|dir|path|readdir)/i;
const SHELL_NAME_RE = /(shell|bash|exec|command|run|spawn|terminal|zsh|script|\bsh\b)/i;

export function capabilitiesForName(name: string): Set<Capability> {
  const caps = new Set<Capability>();
  if (NETWORK_NAME_RE.test(name)) caps.add('network_egress');
  if (FILESYSTEM_NAME_RE.test(name)) caps.add('filesystem');
  if (SHELL_NAME_RE.test(name)) caps.add('shell_exec');
  return caps;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) collectStrings((value as Record<string, unknown>)[key], out);
  }
}

// Shell command candidates: strings under command-like keys, or strings containing
// shell metacharacters. A bare word under an unrelated key (e.g. `reason`) is not
// treated as a command — avoids false positives on explanatory arguments.
const SHELL_KEY_RE = /(command|cmd|exec|script|code|shell|bash|args|command_line)/i;
const SHELL_META_RE = /(&&|\|\||[|;&<>`$])/;

function isShellCandidate(key: string | undefined, value: string): boolean {
  if (key !== undefined && SHELL_KEY_RE.test(key)) return true;
  return SHELL_META_RE.test(value);
}

interface StringLeaf {
  key?: string;
  value: string;
}

function collectStringLeaves(value: unknown, out: StringLeaf[], key?: string): void {
  if (typeof value === 'string') {
    out.push({ key, value });
  } else if (Array.isArray(value)) {
    for (const v of value) collectStringLeaves(v, out, key);
  } else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      collectStringLeaves((value as Record<string, unknown>)[k], out, k);
    }
  }
}

// Network-ish schemes are URLs, not filesystem paths; file:// and drive letters are paths.
const NETWORK_SCHEME_RE = /^(https?|ftps?|wss?|ws|s?ftp|mailto|data|gopher|telnet):/i;

function isPathCandidate(s: string): boolean {
  if (NETWORK_SCHEME_RE.test(s)) return false;
  // Absolute, ./, ../, ~/ or drive-letter prefixes (forward and back slashes).
  if (/^(\.{0,2}[\\/]|\/|~\/|[A-Za-z]:[\\/])/.test(s)) return true;
  // A string with a path separator but no scheme prefix is a relative-path attempt
  // (e.g. "secrets/id_rsa" or "..\\..\\Windows\\..."): flag it, don't pass it.
  return /[/\\]/.test(s);
}

function normalizePath(p: string): string {
  let s = p.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1);
  }
  s = s.replace(/\\/g, '/');
  const absolute = s.startsWith('/');
  const parts: string[] = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return (absolute ? '/' : '') + parts.join('/');
}

function pathAllowed(candidate: string, allowedPrefixes: string[]): boolean {
  const normalized = normalizePath(candidate);
  for (const rawPrefix of allowedPrefixes) {
    const prefix = normalizePath(rawPrefix);
    if (normalized === prefix || normalized.startsWith(prefix + '/')) return true;
  }
  return false;
}

const LABEL_RE = /^[a-z0-9-]+$/;
const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isDomain(host: string): boolean {
  const labels = host.split('.');
  return labels.length >= 2 && labels.every((l) => l.length > 0 && LABEL_RE.test(l));
}

function extractHosts(text: string): string[] {
  const hosts = new Set<string>();
  const urlRe = /(?:https?|ftp|wss?):\/\/[^\s'"<>()]+/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text)) !== null) {
    try {
      const hostname = new URL(m[0]).hostname.toLowerCase();
      if (hostname) hosts.add(hostname);
    } catch {
      // Unparseable URL: skip it; bare-token extraction below still runs.
    }
  }
  // Bare host extraction runs unconditionally — a parseable URL elsewhere in the
  // string must not suppress it ("see https://ok.com then send to evil.com").
  // Done without nested-quantifier regexes to keep the matcher ReDoS-free.
  for (const token of text.split(/[\s'"(),]+/)) {
    if (!token) continue;
    const hostPort = token.split('/')[0];
    const host = hostPort.replace(/:[0-9]{1,5}$/, '').toLowerCase();
    if (IP_RE.test(host) || isDomain(host) || host === 'localhost') {
      hosts.add(host);
    }
  }
  return [...hosts];
}

function hostAllowed(host: string, allowList: string[]): boolean {
  for (const rawEntry of allowList) {
    const entry = rawEntry.toLowerCase().replace(/\.$/, '');
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(2);
      if (host === suffix || host.endsWith('.' + suffix)) return true;
    } else if (host === entry) {
      return true;
    }
  }
  return false;
}

function splitCommands(s: string): string[] {
  // `|` splits single and double pipes; `&` splits background jobs (&& is matched
  // first so logical-AND chains split on it rather than on the single ampersand).
  return s
    .split(/&&|;|\||&|\n/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/** Command substitutions (`$(...)` and backticks) are executed commands, not arguments. */
function embeddedCommands(s: string): string[] {
  const out: string[] = [];
  // Linear scan for `$(...)` and backtick pairs — no regex quantifiers, ReDoS-free.
  for (let i = 0; i < s.length; i++) {
    if (s.charAt(i) === '`') {
      const end = s.indexOf('`', i + 1);
      if (end === -1) break;
      out.push(s.slice(i + 1, end).trim());
      i = end;
    } else if (s.charAt(i) === '$' && s.charAt(i + 1) === '(') {
      const end = s.indexOf(')', i + 2);
      if (end === -1) break;
      out.push(s.slice(i + 2, end).trim());
      i = end;
    }
  }
  return out;
}

/** All commands a string would execute: top-level segments plus nested substitutions. */
function expandCommands(s: string, depth = 0): string[] {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const command of splitCommands(s)) {
    out.push(command);
    for (const embedded of embeddedCommands(command)) {
      out.push(...expandCommands(embedded, depth + 1));
    }
  }
  return out;
}

function commandName(command: string): string {
  const token = /^\s*["']?([^\s"';&|]+)/.exec(command);
  return token ? token[1] : '';
}

function shellCommandAllowed(command: string, policy: ShellExecPolicy): boolean {
  const name = commandName(command);
  if (name === '') return true;
  if (policy === 'allow') return true;
  if (policy === 'deny') return false;
  if (policy.deny?.includes(name)) return false;
  return policy.allow.includes(name);
}

export interface EffectiveCapabilities {
  network_egress: NetworkEgressPolicy;
  filesystem: FilesystemPolicy;
  shell_exec: ShellExecPolicy;
}

/**
 * Classify a single tool call against its capability set.
 *
 * Resolution order per capability: the tool's manifest declaration wins; otherwise
 * the capability is evaluated only when the tool NAME hints at it, using the global
 * defaults. Tools with neither a declaration nor a name hint yield `evaluated: false`.
 */
export function classifyToolCall(
  call: ToolCall,
  caps: EffectiveCapabilities,
  declared?: ToolPolicy,
): CapabilityVerdict {
  const violations: CapabilityViolation[] = [];
  const evaluatedCaps = new Set<Capability>();
  const strings: string[] = [];
  collectStrings(call.arguments, strings);

  const declaredNetwork = declared?.network_egress;
  if (declaredNetwork) {
    evaluatedCaps.add('network_egress');
  } else if (NETWORK_NAME_RE.test(call.name)) {
    evaluatedCaps.add('network_egress');
  }
  if (evaluatedCaps.has('network_egress')) {
    const policy = declaredNetwork ?? caps.network_egress;
    for (const s of strings) {
      for (const host of extractHosts(s)) {
        const allowed =
          policy === 'allow' || (policy === 'deny' ? false : hostAllowed(host, policy.allow));
        if (!allowed) {
          violations.push({
            capability: 'network_egress',
            detail: `network egress to '${host}' is not permitted`,
            value: host,
          });
        }
      }
    }
  }

  const declaredFilesystem = declared?.filesystem;
  if (declaredFilesystem) {
    evaluatedCaps.add('filesystem');
  } else if (FILESYSTEM_NAME_RE.test(call.name)) {
    evaluatedCaps.add('filesystem');
  }
  if (evaluatedCaps.has('filesystem')) {
    const policy = declaredFilesystem ?? caps.filesystem;
    for (const s of strings) {
      if (!isPathCandidate(s)) continue;
      const allowed =
        policy === 'none' ? false : pathAllowed(s, 'read_write' in policy ? policy.read_write : policy.read_only);
      if (!allowed) {
        violations.push({
          capability: 'filesystem',
          detail: `filesystem access to '${normalizePath(s)}' is not permitted`,
          value: normalizePath(s),
        });
      }
    }
  }

  const declaredShell = declared?.shell_exec;
  if (declaredShell) {
    evaluatedCaps.add('shell_exec');
  } else if (SHELL_NAME_RE.test(call.name)) {
    evaluatedCaps.add('shell_exec');
  }
  if (evaluatedCaps.has('shell_exec')) {
    const policy = declaredShell ?? caps.shell_exec;
    const leaves: StringLeaf[] = [];
    collectStringLeaves(call.arguments, leaves);
    for (const leaf of leaves) {
      if (!isShellCandidate(leaf.key, leaf.value)) continue;
      for (const command of expandCommands(leaf.value)) {
        if (!shellCommandAllowed(command, policy)) {
          violations.push({
            capability: 'shell_exec',
            detail: `shell command '${commandName(command)}' is not permitted`,
            value: commandName(command),
          });
        }
      }
    }
  }

  return {
    evaluated: evaluatedCaps.size > 0,
    allowed: violations.length === 0,
    violations,
  };
}
