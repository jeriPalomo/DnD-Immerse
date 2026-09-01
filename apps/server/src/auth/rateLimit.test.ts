import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_MS,
  rateLimitLogin,
  resetRateLimits,
} from './rateLimit.js';
import { HttpError } from './guards.js';
import type { FastifyRequest } from 'fastify';

const from = (ip: string) => ({ ip }) as FastifyRequest;

describe('the login rate limit', () => {
  beforeEach(() => {
    resetRateLimits();
    vi.useRealTimers();
  });

  it('lets a real table sign in without ever meeting it', () => {
    // Five people, each getting their password wrong once. That must not throw,
    // or the limit is a bug rather than a defence.
    expect(() => {
      for (let i = 0; i < 10; i += 1) rateLimitLogin(from('100.64.0.1'));
    }).not.toThrow();
  });

  it('refuses once the window is full', () => {
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) rateLimitLogin(from('10.0.0.1'));
    expect(() => rateLimitLogin(from('10.0.0.1'))).toThrow(HttpError);
  });

  it('answers 429 rather than 401', () => {
    // Not a wrong password. Saying 401 would have somebody retyping a password
    // that was right all along.
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) rateLimitLogin(from('10.0.0.2'));
    try {
      rateLimitLogin(from('10.0.0.2'));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as HttpError).status).toBe(429);
      expect((error as HttpError).message).toMatch(/too many attempts/i);
    }
  });

  it('counts each address on its own', () => {
    // One person fat-fingering their password must not lock out the table.
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS + 5; i += 1) {
      try {
        rateLimitLogin(from('10.0.0.3'));
      } catch {
        /* expected */
      }
    }
    expect(() => rateLimitLogin(from('10.0.0.4'))).not.toThrow();
  });

  it('opens a fresh window once the old one has passed', () => {
    vi.useFakeTimers();
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) rateLimitLogin(from('10.0.0.5'));
    expect(() => rateLimitLogin(from('10.0.0.5'))).toThrow();

    vi.advanceTimersByTime(LOGIN_WINDOW_MS + 1);
    expect(() => rateLimitLogin(from('10.0.0.5'))).not.toThrow();
  });

  it('survives a request with no address at all', () => {
    expect(() => rateLimitLogin({} as FastifyRequest)).not.toThrow();
  });
});
