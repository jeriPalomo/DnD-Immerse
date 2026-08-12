import { describe, expect, it } from 'vitest';
import { isTyping } from './useHotkeys.js';

/**
 * The focus guard is the one thing here that would genuinely hurt: typing
 * "delete that" in chat must not delete a token.
 */
describe('isTyping', () => {
  function el(tag: string, editable = false) {
    return { tagName: tag, isContentEditable: editable } as unknown as EventTarget;
  }

  it('suppresses shortcuts inside text fields', () => {
    expect(isTyping(el('INPUT'))).toBe(true);
    expect(isTyping(el('TEXTAREA'))).toBe(true);
    expect(isTyping(el('SELECT'))).toBe(true);
  });

  it('suppresses shortcuts in contenteditable', () => {
    expect(isTyping(el('DIV', true))).toBe(true);
  });

  it('allows shortcuts elsewhere', () => {
    expect(isTyping(el('DIV'))).toBe(false);
    expect(isTyping(el('CANVAS'))).toBe(false);
    expect(isTyping(el('BUTTON'))).toBe(false);
  });

  it('is safe with no target at all', () => {
    expect(isTyping(null)).toBe(false);
  });
});
