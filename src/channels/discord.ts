import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
  ThreadChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  // Thread JID → parent channel JID. Populated on thread creation and
  // lazily self-healed when inbound messages arrive for known threads
  // after a restart (Discord's API gives us `parentId` inline).
  private threadToChannel = new Map<string, string>();

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      if (message.author.bot) return;

      const channel = message.channel;
      const isThread = channel.isThread();
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;
      const botId = this.client?.user?.id;

      const isBotMentioned = botId
        ? message.mentions.users.has(botId) ||
          message.content.includes(`<@${botId}>`) ||
          message.content.includes(`<@!${botId}>`)
        : false;

      let content = message.content;
      if (isBotMentioned && botId) {
        content = content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
      }

      // Attachment placeholders
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          },
        );
        content = content
          ? `${content}\n${attachmentDescriptions.join('\n')}`
          : attachmentDescriptions.join('\n');
      }

      // Reply context
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      if (isThread) {
        const threadChannel = channel as ThreadChannel;
        const threadJid = `dc:${threadChannel.id}`;
        const parentId = threadChannel.parentId;

        // Self-heal the map after restart: Discord tells us the parent inline.
        if (parentId && !this.threadToChannel.has(threadChannel.id)) {
          this.threadToChannel.set(threadChannel.id, parentId);
        }

        // Inside threads: no trigger needed. Every message continues the chat.
        const chatName = message.guild
          ? `${message.guild.name} / ${threadChannel.name}`
          : threadChannel.name;
        this.opts.onChatMetadata(
          threadJid,
          timestamp,
          chatName,
          'discord',
          true,
        );

        this.opts.onMessage(threadJid, {
          id: msgId,
          chat_jid: threadJid,
          sender,
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });

        logger.info(
          { threadJid, parentId, sender: senderName },
          'Discord thread message delivered',
        );
        return;
      }

      // Parent-channel path (not a thread)
      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;

      const textChannel = channel as TextChannel;
      const chatName = message.guild
        ? `${message.guild.name} #${textChannel.name}`
        : senderName;

      // Record channel metadata for discovery either way.
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        message.guild !== null,
      );

      // Only registered channels produce threads.
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Non-mention messages in the parent channel are ignored.
      // The channel stays clean — the bot only speaks inside threads.
      if (!isBotMentioned) {
        logger.debug(
          { chatJid, sender: senderName },
          'Discord channel message without mention — ignored',
        );
        return;
      }

      // Create a thread off this message. Thread name = first 50 chars of
      // the stripped content (falling back to sender if empty).
      const threadName = (content.trim().slice(0, 50) || senderName).trim();
      let threadJid: string;
      try {
        if (!('startThread' in message) || typeof message.startThread !== 'function') {
          logger.warn({ chatJid }, 'Discord channel does not support threads');
          return;
        }
        const thread = await message.startThread({
          name: threadName,
          autoArchiveDuration: 60,
        });
        this.threadToChannel.set(thread.id, channelId);
        threadJid = `dc:${thread.id}`;

        const threadChatName = message.guild
          ? `${message.guild.name} / ${thread.name}`
          : thread.name;
        this.opts.onChatMetadata(
          threadJid,
          timestamp,
          threadChatName,
          'discord',
          true,
        );
      } catch (err) {
        logger.error(
          { chatJid, err },
          'Failed to create Discord thread from mention',
        );
        return;
      }

      // Prepend trigger so downstream trigger logic treats this as addressed.
      const contentWithTrigger = TRIGGER_PATTERN.test(content)
        ? content
        : `@${ASSISTANT_NAME} ${content}`;

      this.opts.onMessage(threadJid, {
        id: msgId,
        chat_jid: threadJid,
        sender,
        sender_name: senderName,
        content: contentWithTrigger,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, threadJid, sender: senderName },
        'Discord thread created from mention',
      );
    });

    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const target = channel as TextChannel | ThreadChannel;
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await target.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await target.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  getParentJid(jid: string): string | null {
    if (!jid.startsWith('dc:')) return null;
    const id = jid.slice(3);
    const parentId = this.threadToChannel.get(id);
    return parentId ? `dc:${parentId}` : null;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel | ThreadChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
