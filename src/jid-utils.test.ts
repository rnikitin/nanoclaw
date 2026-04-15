import { describe, it, expect } from 'vitest';

import { sanitizeJid } from './jid-utils.js';

describe('sanitizeJid', () => {
  it('replaces colons in Telegram/Discord chatJids', () => {
    expect(sanitizeJid('tg:47319110')).toBe('tg_47319110');
    expect(sanitizeJid('dc:1493529373901590598')).toBe(
      'dc_1493529373901590598',
    );
  });

  it('replaces path separators and other unsafe chars', () => {
    expect(sanitizeJid('wa:123/456@c.us')).toBe('wa_123_456_c.us');
    expect(sanitizeJid('something with spaces')).toBe('something_with_spaces');
  });

  it('preserves allowed filename chars', () => {
    expect(sanitizeJid('Group-Name_v1.2')).toBe('Group-Name_v1.2');
  });

  it('is stable for already-safe ids', () => {
    const safe = 'abc123_def';
    expect(sanitizeJid(safe)).toBe(safe);
  });
});
