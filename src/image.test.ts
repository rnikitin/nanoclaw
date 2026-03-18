import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock sharp
const sharpMock = vi.hoisted(() => {
  const chain = {
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('resized-image-data')),
  };
  const fn = vi.fn(() => chain);
  return { fn, chain };
});

vi.mock('sharp', () => ({ default: sharpMock.fn }));

// Mock fs
const fsMocks = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, default: { ...actual, ...fsMocks }, ...fsMocks };
});

import { processImage, parseImageReferences } from './image.js';

describe('processImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resizes, converts to JPEG, and saves to attachments', async () => {
    const result = await processImage(
      Buffer.from('raw-image'),
      '/tmp/group',
      '',
    );

    expect(result).not.toBeNull();
    expect(result!.relativePath).toMatch(/^attachments\/img-\d+-\w+\.jpg$/);
    expect(result!.content).toMatch(/^\[Image: attachments\/img-\d+-\w+\.jpg\]$/);

    expect(sharpMock.fn).toHaveBeenCalledWith(Buffer.from('raw-image'));
    expect(sharpMock.chain.resize).toHaveBeenCalledWith(1024, 1024, {
      fit: 'inside',
      withoutEnlargement: true,
    });
    expect(sharpMock.chain.jpeg).toHaveBeenCalledWith({ quality: 85 });
    expect(fsMocks.mkdirSync).toHaveBeenCalledWith('/tmp/group/attachments', {
      recursive: true,
    });
    expect(fsMocks.writeFileSync).toHaveBeenCalled();
  });

  it('includes caption in content string', async () => {
    const result = await processImage(
      Buffer.from('raw-image'),
      '/tmp/group',
      'Look at this!',
    );

    expect(result).not.toBeNull();
    expect(result!.content).toMatch(
      /^\[Image: attachments\/img-\d+-\w+\.jpg\] Look at this!$/,
    );
  });

  it('returns null on empty buffer', async () => {
    const result = await processImage(Buffer.alloc(0), '/tmp/group', '');
    expect(result).toBeNull();
  });

  it('returns null on null-ish buffer', async () => {
    const result = await processImage(
      null as unknown as Buffer,
      '/tmp/group',
      '',
    );
    expect(result).toBeNull();
  });
});

describe('parseImageReferences', () => {
  it('extracts image references from messages', () => {
    const msgs = [
      { content: '[Image: attachments/img-123-abc.jpg] hello' },
      { content: 'no image here' },
      { content: '[Image: attachments/img-456-def.jpg]' },
    ];

    const refs = parseImageReferences(msgs);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({
      relativePath: 'attachments/img-123-abc.jpg',
      mediaType: 'image/jpeg',
    });
    expect(refs[1]).toEqual({
      relativePath: 'attachments/img-456-def.jpg',
      mediaType: 'image/jpeg',
    });
  });

  it('returns empty array when no images', () => {
    const refs = parseImageReferences([
      { content: 'plain text' },
      { content: '[Photo] some caption' },
    ]);
    expect(refs).toHaveLength(0);
  });

  it('handles multiple images in one message', () => {
    const refs = parseImageReferences([
      {
        content:
          '[Image: attachments/img-1-a.jpg] first [Image: attachments/img-2-b.jpg] second',
      },
    ]);
    expect(refs).toHaveLength(2);
  });

  it('handles empty messages array', () => {
    expect(parseImageReferences([])).toHaveLength(0);
  });
});
