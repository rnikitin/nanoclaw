import fs from 'fs';
import path from 'path';

import sharp from 'sharp';

import { ensureDir } from './fs-utils.js';

const MAX_DIMENSION = 1024;
const JPEG_QUALITY = 85;

export const IMAGE_REF_PATTERN = /\[Image: (attachments\/[^\]]+)\]/g;

export interface ProcessedImage {
  content: string; // "[Image: attachments/img-xxx.jpg] caption"
  relativePath: string; // "attachments/img-xxx.jpg"
}

export interface ImageAttachment {
  relativePath: string;
  mediaType: string; // "image/jpeg"
}

/**
 * Resize an image to fit within MAX_DIMENSION, convert to JPEG, and save to
 * the group's attachments directory.
 */
export async function processImage(
  buffer: Buffer,
  groupDir: string,
  caption: string,
): Promise<ProcessedImage | null> {
  if (!buffer || buffer.length === 0) return null;

  const attachDir = path.join(groupDir, 'attachments');
  ensureDir(attachDir);

  const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const relativePath = `attachments/${filename}`;
  const fullPath = path.join(groupDir, relativePath);

  const resized = await sharp(buffer)
    .resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();

  fs.writeFileSync(fullPath, resized);

  const captionSuffix = caption ? ` ${caption}` : '';
  return {
    content: `[Image: ${relativePath}]${captionSuffix}`,
    relativePath,
  };
}

/**
 * Extract image attachment references from message content strings.
 */
export function parseImageReferences(
  messages: Array<{ content: string }>,
): ImageAttachment[] {
  const attachments: ImageAttachment[] = [];
  for (const msg of messages) {
    let match;
    const re = new RegExp(IMAGE_REF_PATTERN.source, IMAGE_REF_PATTERN.flags);
    while ((match = re.exec(msg.content)) !== null) {
      attachments.push({
        relativePath: match[1],
        mediaType: 'image/jpeg',
      });
    }
  }
  return attachments;
}
