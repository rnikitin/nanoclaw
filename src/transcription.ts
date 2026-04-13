import { readEnvFile } from './env.js';
import { logger } from './logger.js';

/**
 * Transcribe audio using OpenAI Whisper API.
 * Returns the transcript text, or null on failure.
 */
export async function transcribeAudio(
  buffer: Buffer,
  filename = 'audio.ogg',
): Promise<string | null> {
  const apiKey = readEnvFile(['OPENAI_API_KEY']).OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set — skipping voice transcription');
    return null;
  }

  try {
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(buffer)]), filename);
    formData.append('model', 'whisper-1');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Whisper API ${res.status}: ${body}`);
    }

    const data = (await res.json()) as { text: string };
    return data.text?.trim() || null;
  } catch (err) {
    logger.error({ err }, 'Voice transcription failed');
    return null;
  }
}
