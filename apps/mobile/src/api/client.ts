/**
 * Minimal API client for the iPad POS. Simulator default = host.docker.internal
 * mapping on macOS, which actually works for the dev-server case via
 * http://localhost; on a real iPad over LAN you set API_BASE via env at build
 * time or via the dev menu.
 */
import { Platform } from 'react-native';

// On a real iPad over LAN set this via a build-time define or from dev menu.
// iOS simulator reaches mac host directly; Android emulator uses 10.0.2.2.
export const API_BASE =
  Platform.OS === 'android' ? 'http://10.0.2.2:3001' : 'http://localhost:3001';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`API ${status}: ${body}`);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) throw new ApiError(res.status, body);
  return body ? (JSON.parse(body) as T) : (undefined as unknown as T);
}
