import { describe, it, expect } from 'vitest';
import { classifyToolCall } from '../../../../src/detection/tier3/classifier.js';
import type { ToolCall } from '../../../../src/types/proxy.js';
import type { CapabilityDefaults } from '../../../../src/types/policy.js';

const DEFAULT_CAPS: CapabilityDefaults = {
  network_egress: 'deny',
  filesystem: 'read_only',
  shell_exec: 'deny',
};

function call(name: string, args: unknown): ToolCall {
  return { name, arguments: args };
}

function violationOf(caps: { network_egress: unknown; filesystem: unknown; shell_exec: unknown }, name: string, args: unknown) {
  return classifyToolCall(call(name, args), caps);
}

describe('classifyToolCall — network_egress (T3-04)', () => {
  const network = (allow: string[]) => ({ network_egress: { allow }, filesystem: 'none', shell_exec: 'deny' });

  it('allows a fetch tool hitting an allow-listed host', () => {
    const v = violationOf(network(['api.openweathermap.org']), 'fetch', {
      url: 'https://api.openweathermap.org/data/2.5/weather?q=Paris',
    });
    expect(v.allowed).toBe(true);
    expect(v.evaluated).toBe(true);
    expect(v.violations).toEqual([]);
  });

  it('allows a wildcard allow-list entry (*.openweathermap.org)', () => {
    const v = violationOf(network(['*.openweathermap.org']), 'fetch', {
      url: 'https://sub.openweathermap.org/x',
    });
    expect(v.allowed).toBe(true);
  });

  it('does not treat a bare allow entry as covering subdomains', () => {
    const v = violationOf(network(['openweathermap.org']), 'fetch', {
      url: 'https://api.openweathermap.org/x',
    });
    expect(v.allowed).toBe(false);
    expect(v.violations[0].capability).toBe('network_egress');
    expect(v.violations[0].value).toBe('api.openweathermap.org');
  });

  it('blocks a host not in the allow list', () => {
    const v = violationOf(network(['api.openweathermap.org']), 'fetch', {
      url: 'https://evil.example.com/x',
    });
    expect(v.allowed).toBe(false);
    expect(v.violations).toHaveLength(1);
  });

  it('matches bare host strings in arguments', () => {
    const v = violationOf(network(['good.com']), 'browse', { site: 'evil.com/path' });
    expect(v.allowed).toBe(false);
    expect(v.violations[0].value).toBe('evil.com');
  });

  it('strips ports from IP literals before matching', () => {
    const v = violationOf(network(['10.0.0.5']), 'request', { host: '10.0.0.5:8080/api' });
    expect(v.allowed).toBe(true);
  });

  it('blocks an IP literal not in the allow list', () => {
    const v = violationOf(network(['10.0.0.5']), 'request', { host: '10.0.0.9' });
    expect(v.allowed).toBe(false);
  });

  it('honors a bare network_egress: deny policy', () => {
    const v = classifyToolCall(call('fetch', { url: 'https://anything.com' }), {
      network_egress: 'deny',
      filesystem: 'none',
      shell_exec: 'deny',
    });
    expect(v.allowed).toBe(false);
  });

  it('honors a bare network_egress: allow policy', () => {
    const v = classifyToolCall(call('fetch', { url: 'https://anything.com' }), {
      network_egress: 'allow',
      filesystem: 'none',
      shell_exec: 'deny',
    });
    expect(v.allowed).toBe(true);
  });

  it('finds URLs nested in objects and arrays', () => {
    const v = violationOf(network(['good.com']), 'fetch', {
      steps: [{ target: ['https://evil.com/x', 'https://good.com'] }],
    });
    expect(v.allowed).toBe(false);
    expect(v.violations[0].value).toBe('evil.com');
  });

  it('does not flag a network tool with no URL-like argument', () => {
    const v = violationOf(network(['good.com']), 'fetch', { query: 'how many stars' });
    expect(v.allowed).toBe(true);
  });
});

describe('classifyToolCall — filesystem (T3-04)', () => {
  const fs = (policy: unknown) => ({ network_egress: 'deny', filesystem: policy, shell_exec: 'deny' });

  it('allows a path under the read_only allow prefix', () => {
    const v = violationOf(fs({ read_only: ['./workspace/docs/'] }), 'read-file', {
      path: './workspace/docs/notes.txt',
    });
    expect(v.allowed).toBe(true);
  });

  it('allows the allowed prefix itself (trailing-slash equivalence)', () => {
    const v = violationOf(fs({ read_only: ['./workspace/docs'] }), 'read-file', {
      path: './workspace/docs/',
    });
    expect(v.allowed).toBe(true);
  });

  it('blocks a path outside the allow prefix', () => {
    const v = violationOf(fs({ read_only: ['./workspace/docs/'] }), 'read-file', {
      path: '/etc/passwd',
    });
    expect(v.allowed).toBe(false);
    expect(v.violations[0].capability).toBe('filesystem');
    expect(v.violations[0].value).toBe('/etc/passwd');
  });

  it('normalizes . and .. segments before matching', () => {
    const v = violationOf(fs({ read_only: ['./workspace/docs/'] }), 'read-file', {
      path: './workspace/./docs/../docs/file.txt',
    });
    expect(v.allowed).toBe(true);
  });

  it('does not treat traversal outside the prefix as inside it', () => {
    const v = violationOf(fs({ read_only: ['./workspace/docs/'] }), 'read-file', {
      path: './workspace/docs/../../etc/passwd',
    });
    expect(v.allowed).toBe(false);
  });

  it('honors filesystem: none (any path access is a violation)', () => {
    const v = violationOf(fs('none'), 'read-file', { path: '/tmp/x' });
    expect(v.allowed).toBe(false);
  });

  it('honors read_write prefixes', () => {
    const v = violationOf(fs({ read_write: ['./workspace/sandbox/'] }), 'write-file', {
      path: './workspace/sandbox/out.txt',
    });
    expect(v.allowed).toBe(true);
  });

  it('normalizes Windows-style paths', () => {
    const v = violationOf(fs({ read_write: ['C:/Users/me'] }), 'write-file', {
      path: 'C:\\Users\\me\\notes.txt',
    });
    expect(v.allowed).toBe(true);
  });

  it('treats ~ paths as opaque (never matches a workspace prefix)', () => {
    const v = violationOf(fs({ read_only: ['./workspace/docs/'] }), 'read-file', {
      path: '~/.ssh/id_rsa',
    });
    expect(v.allowed).toBe(false);
  });

  it('does not treat bare filenames without a path prefix as candidates', () => {
    const v = violationOf(fs('none'), 'read-file', { name: 'notes.txt' });
    expect(v.allowed).toBe(true);
  });
});

describe('classifyToolCall — shell_exec (T3-04)', () => {
  const shell = (policy: unknown) => ({ network_egress: 'deny', filesystem: 'none', shell_exec: policy });

  it('allows a command on the allow list', () => {
    const v = violationOf(shell({ allow: ['python3', 'node'] }), 'code-runner', {
      command: 'python3 main.py --port 8080',
    });
    expect(v.allowed).toBe(true);
  });

  it('blocks a command not on the allow list', () => {
    const v = violationOf(shell({ allow: ['python3', 'node'] }), 'code-runner', {
      command: 'curl -s https://evil.com',
    });
    expect(v.allowed).toBe(false);
    expect(v.violations[0].capability).toBe('shell_exec');
    expect(v.violations[0].value).toBe('curl');
  });

  it('blocks commands on the deny list even when allow matches', () => {
    const v = violationOf(shell({ allow: ['python3'], deny: ['python3'] }), 'code-runner', {
      command: 'python3 -c "print(1)"',
    });
    expect(v.allowed).toBe(false);
  });

  it('honors shell_exec: deny', () => {
    const v = violationOf(shell('deny'), 'bash', { command: 'ls' });
    expect(v.allowed).toBe(false);
  });

  it('honors shell_exec: allow', () => {
    const v = violationOf(shell('allow'), 'bash', { command: 'anything' });
    expect(v.allowed).toBe(true);
  });

  it('splits compound commands on &&, ; and newlines', () => {
    const v = violationOf(shell({ allow: ['cd'] }), 'bash', { command: 'cd /tmp && whoami' });
    expect(v.allowed).toBe(false);
    expect(v.violations[0].value).toBe('whoami');
  });

  it('checks each entry of a commands array', () => {
    const v = violationOf(shell({ allow: ['ls'] }), 'bash', { commands: ['ls', 'whoami'] });
    expect(v.allowed).toBe(false);
  });

  it('does not flag a shell tool with no command-like argument', () => {
    const v = violationOf(shell('deny'), 'bash', { reason: 'no command here' });
    expect(v.allowed).toBe(true);
  });
});

describe('classifyToolCall — capability resolution (T3-04)', () => {
  it('evaluates manifest-declared capabilities even when the name gives no hint', () => {
    const v = classifyToolCall(
      call('weather-lookup', { url: 'https://evil.com' }),
      DEFAULT_CAPS,
      { network_egress: { allow: ['api.openweathermap.org'] } },
    );
    expect(v.evaluated).toBe(true);
    expect(v.allowed).toBe(false);
  });

  it('evaluates name-derived capabilities against the defaults when undeclared', () => {
    const v = classifyToolCall(call('fetch', { url: 'https://evil.com' }), DEFAULT_CAPS);
    expect(v.evaluated).toBe(true);
    expect(v.allowed).toBe(false);
  });

  it('evaluates every capability a name maps to', () => {
    const v = classifyToolCall(
      call('download-file', { url: 'https://evil.com', path: '/tmp/out' }),
      { network_egress: { allow: [] }, filesystem: { read_only: [] }, shell_exec: 'deny' },
    );
    expect(v.violations.map((x) => x.capability)).toEqual(['network_egress', 'filesystem']);
  });

  it('marks unclassifiable calls as not evaluated (unknown_tool decision belongs to the engine)', () => {
    const v = classifyToolCall(call('get-weather', { city: 'Paris' }), DEFAULT_CAPS);
    expect(v.evaluated).toBe(false);
    expect(v.allowed).toBe(true);
    expect(v.violations).toEqual([]);
  });

  it('is case-insensitive for tool names', () => {
    const v = classifyToolCall(call('Fetch', { url: 'https://evil.com' }), DEFAULT_CAPS);
    expect(v.evaluated).toBe(true);
    expect(v.allowed).toBe(false);
  });
});
