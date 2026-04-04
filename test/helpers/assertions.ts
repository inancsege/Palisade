import { expect } from 'vitest';

export async function expectBlocked(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  expect(res.headers.get('x-palisade-verdict')).toBe('block');
  const body = (await res.json()) as { error: { type: string } };
  expect(body.error.type).toBe('prompt_injection_detected');
}

export async function expectAllowed(res: Response): Promise<void> {
  expect(res.status).toBe(200);
  expect(res.headers.get('x-palisade-verdict')).toBe('allow');
}

export async function expectWarned(res: Response): Promise<void> {
  expect(res.status).toBe(200);
  expect(res.headers.get('x-palisade-verdict')).toBe('warn');
}
