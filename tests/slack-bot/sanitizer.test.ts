import { describe, expect, it } from 'vitest';
import { sanitizeInput } from '../../src/slack-bot/sanitizer';

describe('sanitizeInput', () => {
  it('removes control characters', () => {
    const result = sanitizeInput('hello\u0000\u0007world');
    expect(result.text).toBe('helloworld');
    expect(result.wasTruncated).toBe(false);
  });

  it('truncates at 10000 chars with notice', () => {
    const longText = 'a'.repeat(10100);
    const result = sanitizeInput(longText);

    expect(result.wasTruncated).toBe(true);
    expect(result.originalLength).toBe(10100);
    expect(result.text.length).toBe(10000);
    expect(result.text.endsWith('[Message truncated to 10000 characters]')).toBe(true);
  });

  it('passes through normal input', () => {
    const result = sanitizeInput('normal message');
    expect(result.text).toBe('normal message');
    expect(result.wasTruncated).toBe(false);
    expect(result.originalLength).toBe(14);
  });
});
