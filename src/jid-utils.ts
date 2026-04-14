export function sanitizeJid(chatJid: string): string {
  return chatJid.replace(/[^A-Za-z0-9._-]/g, '_');
}
