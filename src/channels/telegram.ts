import fs from 'fs';
import https from 'https';
import path from 'path';

import { Api, Bot, InputFile } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { processImage } from '../image.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../transcription.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Escape special characters for Telegram MarkdownV2 (in plain text regions).
 */
function escapeV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Convert standard Markdown (as Claude generates) to Telegram MarkdownV2.
 * Handles: bold, italic, strikethrough, code, code blocks, links.
 * Uses a placeholder approach to protect already-converted segments from escaping.
 */
export function toMarkdownV2(input: string): string {
  const tokens: string[] = [];
  function hold(s: string): string {
    const i = tokens.length;
    tokens.push(s);
    return `\x00${i}\x00`;
  }

  let text = input;

  // Code blocks — no escaping inside (Telegram treats pre content as-is)
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
    hold('```' + (lang || '') + '\n' + code + '```'),
  );

  // Inline code — no escaping inside
  text = text.replace(/`([^`\n]+)`/g, (_, code) => hold('`' + code + '`'));

  // Bold **text** → *text*
  text = text.replace(/\*\*(.+?)\*\*/gs, (_, inner) =>
    hold('*' + escapeV2(inner) + '*'),
  );

  // Bold __text__ → *text*
  text = text.replace(/__(.+?)__/gs, (_, inner) =>
    hold('*' + escapeV2(inner) + '*'),
  );

  // Italic *text* → _text_
  text = text.replace(/\*(.+?)\*/gs, (_, inner) =>
    hold('_' + escapeV2(inner) + '_'),
  );

  // Italic _text_ (not inside words like some_var_name)
  text = text.replace(
    /(?<![\\a-zA-Z0-9])_(.+?)_(?![a-zA-Z0-9])/gs,
    (_, inner) => hold('_' + escapeV2(inner) + '_'),
  );

  // Strikethrough ~~text~~ → ~text~
  text = text.replace(/~~(.+?)~~/gs, (_, inner) =>
    hold('~' + escapeV2(inner) + '~'),
  );

  // Links [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) =>
    hold('[' + escapeV2(label) + '](' + url.replace(/([)\\])/g, '\\$1') + ')'),
  );

  // Escape all remaining special characters
  text = escapeV2(text);

  // Restore protected tokens
  text = text.replace(/\x00(\d+)\x00/g, (_, idx) => tokens[parseInt(idx)]);
  return text;
}

/**
 * Send a message with Telegram MarkdownV2 parse mode, falling back to plain text.
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    const v2 = toMarkdownV2(text);
    await api.sendMessage(chatId, v2, {
      ...options,
      parse_mode: 'MarkdownV2',
    });
  } catch (err) {
    logger.debug({ err }, 'MarkdownV2 send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private ownerUserId: string | undefined;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
    // Derive owner user ID from the main group's JID (personal chat = tg:<user_id>)
    const groups = opts.registeredGroups();
    for (const [jid, g] of Object.entries(groups)) {
      if (g.isMain && jid.startsWith('tg:') && !jid.includes('-')) {
        this.ownerUserId = jid.replace('tg:', '');
        break;
      }
    }
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${escapeV2(chatName)}\nType: ${escapeV2(chatType)}`,
        { parse_mode: 'MarkdownV2' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Let NanoClaw session commands through; skip other Telegram bot commands
      const NANOCLAW_COMMANDS = [
        '/compact',
        '/usage',
        '/restart',
        '/thinking',
        '/new',
        '/auto-update',
        '/auto_update',
        '/dreaming',
      ];
      // Strip @bot_username suffix from commands (Telegram adds it in groups)
      const cmdBase = ctx.message.text.trim().replace(/@\S+/, '').trim();
      if (
        ctx.message.text.startsWith('/') &&
        !NANOCLAW_COMMANDS.some(
          (cmd) => cmdBase === cmd || cmdBase.startsWith(cmd + ' '),
        )
      ) {
        return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      // Telegram bot commands use underscores; map to NanoClaw hyphenated form.
      // Also strip @bot_username suffix from commands (Telegram adds it in groups).
      let content = ctx.message.text;
      if (content.startsWith('/')) {
        content = content.replace(/@\S+/, '');
      }
      if (content.trim() === '/auto_update') {
        content = '/auto-update';
      }
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @ark_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Ark\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: sender === this.ownerUserId,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: (ctx.from?.id?.toString() || '') === this.ownerUserId,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      try {
        const photos = ctx.message.photo!;
        const largest = photos[photos.length - 1];
        const file = await ctx.api.getFile(largest.file_id);
        const downloadUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

        const res = await fetch(downloadUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());

        const groupDir = resolveGroupFolderPath(group.folder);
        const caption = ctx.message.caption || '';
        const result = await processImage(buffer, groupDir, caption);

        if (result) {
          // Deliver directly — storeNonText would double-append the caption
          const timestamp = new Date(ctx.message.date * 1000).toISOString();
          const senderName =
            ctx.from?.first_name ||
            ctx.from?.username ||
            ctx.from?.id?.toString() ||
            'Unknown';
          const isGroup =
            ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
          this.opts.onChatMetadata(
            chatJid,
            timestamp,
            undefined,
            'telegram',
            isGroup,
          );
          this.opts.onMessage(chatJid, {
            id: ctx.message.message_id.toString(),
            chat_jid: chatJid,
            sender: ctx.from?.id?.toString() || '',
            sender_name: senderName,
            content: result.content,
            timestamp,
            is_from_me: (ctx.from?.id?.toString() || '') === this.ownerUserId,
          });
          logger.info({ chatJid }, 'Telegram photo processed for vision');
          return;
        }
      } catch (err) {
        logger.error({ chatJid, err }, 'Failed to process Telegram photo');
      }
      // Fallback: store as placeholder
      storeNonText(ctx, '[Photo]');
    });
    this.bot.on('message:video', async (ctx) => {
      const video = ctx.message.video;
      const sizeBytes = video?.file_size || 0;
      const MAX_DOWNLOAD_SIZE = 20 * 1024 * 1024;
      const name = video?.file_name || `video_${ctx.message.message_id}.mp4`;

      if (sizeBytes > MAX_DOWNLOAD_SIZE) {
        storeNonText(
          ctx,
          `[Video: ${name} (${(sizeBytes / 1024 / 1024).toFixed(1)} MB — too large)]`,
        );
        return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        storeNonText(ctx, `[Video: ${name}]`);
        return;
      }

      try {
        const file = await ctx.getFile();
        const downloadUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

        const groupDir = resolveGroupFolderPath(group.folder);
        const attachDir = path.join(groupDir, 'attachments');
        fs.mkdirSync(attachDir, { recursive: true });

        const localPath = path.join(attachDir, name);
        const res = await fetch(downloadUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(localPath, buffer);

        const containerPath = `/workspace/group/attachments/${name}`;
        const caption = ctx.message.caption ? ` — ${ctx.message.caption}` : '';
        storeNonText(ctx, `[Video: ${name} → ${containerPath}${caption}]`);
        logger.info({ chatJid, name, localPath }, 'Telegram video downloaded');
      } catch (err) {
        logger.error(
          { chatJid, name, err },
          'Failed to download Telegram video',
        );
        storeNonText(ctx, `[Video: ${name}]`);
      }
    });
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      try {
        const file = await ctx.api.getFile(ctx.message.voice.file_id);
        const downloadUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const res = await fetch(downloadUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());

        const transcript = await transcribeAudio(buffer, 'voice.ogg');
        if (transcript) {
          const timestamp = new Date(ctx.message.date * 1000).toISOString();
          const senderName =
            ctx.from?.first_name ||
            ctx.from?.username ||
            ctx.from?.id?.toString() ||
            'Unknown';
          const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
          const isGroup =
            ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
          this.opts.onChatMetadata(
            chatJid,
            timestamp,
            undefined,
            'telegram',
            isGroup,
          );
          this.opts.onMessage(chatJid, {
            id: ctx.message.message_id.toString(),
            chat_jid: chatJid,
            sender: ctx.from?.id?.toString() || '',
            sender_name: senderName,
            content: `[Voice: ${transcript}]${caption}`,
            timestamp,
            is_from_me: (ctx.from?.id?.toString() || '') === this.ownerUserId,
          });
          logger.info({ chatJid }, 'Telegram voice message transcribed');
          return;
        }
      } catch (err) {
        logger.error({ chatJid, err }, 'Failed to transcribe Telegram voice');
      }
      storeNonText(ctx, '[Voice message]');
    });
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', async (ctx) => {
      const doc = ctx.message.document;
      const name = doc?.file_name || 'file';
      const sizeBytes = doc?.file_size || 0;
      const MAX_DOWNLOAD_SIZE = 20 * 1024 * 1024; // 20 MB (Telegram Bot API limit)

      if (sizeBytes > MAX_DOWNLOAD_SIZE) {
        storeNonText(
          ctx,
          `[Document: ${name} (${(sizeBytes / 1024 / 1024).toFixed(1)} MB — too large)]`,
        );
        return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        storeNonText(ctx, `[Document: ${name}]`);
        return;
      }

      try {
        const file = await ctx.getFile();
        const downloadUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

        const groupDir = resolveGroupFolderPath(group.folder);
        const attachDir = path.join(groupDir, 'attachments');
        fs.mkdirSync(attachDir, { recursive: true });

        const localPath = path.join(attachDir, name);
        const res = await fetch(downloadUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(localPath, buffer);

        const containerPath = `/workspace/group/attachments/${name}`;
        storeNonText(ctx, `[File: ${name} → ${containerPath}]`);
        logger.info(
          { chatJid, name, localPath },
          'Telegram document downloaded',
        );
      } catch (err) {
        logger.error(
          { chatJid, name, err },
          'Failed to download Telegram document',
        );
        storeNonText(ctx, `[Document: ${name}]`);
      }
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Register bot command hints in Telegram UI
    await this.bot.api.setMyCommands([
      { command: 'usage', description: 'Show token usage and cost' },
      { command: 'thinking', description: 'Toggle thinking mode on/off' },
      { command: 'compact', description: 'Compact conversation context' },
      { command: 'new', description: 'Start new conversation' },
      { command: 'restart', description: 'Restart the bot' },
      { command: 'auto_update', description: 'Check for updates and rebuild' },
      {
        command: 'dreaming',
        description: 'Memory consolidation (status/run/light/deep)',
      },
      { command: 'ping', description: 'Check if bot is online' },
      { command: 'chatid', description: 'Show chat ID for registration' },
    ]);

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendFile(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const fileBuffer = fs.readFileSync(filePath);
      const fileName = path.basename(filePath);
      const inputFile = new InputFile(fileBuffer, fileName);

      await this.bot.api.sendDocument(numericId, inputFile, {
        caption: caption ? toMarkdownV2(caption) : undefined,
        parse_mode: caption ? 'MarkdownV2' : undefined,
      });
      logger.info({ jid, filePath: fileName }, 'Telegram file sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Telegram file');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
