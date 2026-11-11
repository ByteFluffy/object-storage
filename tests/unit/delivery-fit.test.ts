import { describe, expect, it } from 'vitest';
import { assessDelivery } from '../../src/delivery/fit.js';

const image = {
  mediaType: 'image/png',
  byteLength: 100,
  width: 80,
  height: 40,
};

describe('assessDelivery', () => {
  it('accepts a fact inside every supplied constraint', () => {
    expect(
      assessDelivery(image, {
        allowedMediaTypes: ['image/png'],
        maxBytes: 100,
        maxEdge: 80,
      }),
    ).toEqual({ status: 'usable' });
  });

  it('asks for the missing fact instead of choosing an operation', () => {
    expect(assessDelivery({ mediaType: 'image/png' }, { maxBytes: 10 })).toEqual({
      status: 'insufficient_evidence',
      missing: ['byteLength'],
    });
  });

  it('names convertImage when the image type is outside the caller list', () => {
    expect(
      assessDelivery(image, {
        allowedMediaTypes: ['image/webp'],
        maxBytes: 10,
      }),
    ).toEqual({ status: 'adapt', operation: 'convertImage', failed: ['mediaType', 'byteLength'] });
  });

  it('names resizeImage before compress when only the edge is over the limit', () => {
    expect(assessDelivery(image, { maxEdge: 70, maxBytes: 1_000 })).toEqual({
      status: 'adapt',
      operation: 'resizeImage',
      failed: ['edge'],
    });
  });

  it('names compressImage when the type and edge already fit', () => {
    expect(assessDelivery(image, { allowedMediaTypes: ['image/png'], maxEdge: 80, maxBytes: 99 })).toEqual({
      status: 'adapt',
      operation: 'compressImage',
      failed: ['byteLength'],
    });
  });

  it('names transcode, trim, or compress for video from the first failed constraint', () => {
    const video = { mediaType: 'video/quicktime', byteLength: 20, width: 200, height: 100, durationMs: 5_000 };
    expect(assessDelivery(video, { allowedMediaTypes: ['video/mp4'] })).toMatchObject({ operation: 'transcodeVideo' });
    expect(assessDelivery({ ...video, mediaType: 'video/mp4' }, { maxEdge: 150 })).toMatchObject({
      operation: 'transcodeVideo',
    });
    expect(assessDelivery({ ...video, mediaType: 'video/mp4' }, { maxDurationMs: 1_000 })).toMatchObject({
      operation: 'trimMedia',
    });
    expect(assessDelivery({ ...video, mediaType: 'video/mp4' }, { maxBytes: 10 })).toMatchObject({
      operation: 'compressVideo',
    });
  });

  it('names transcodeAudio for an oversized audio type and trimMedia for duration', () => {
    const audio = { mediaType: 'audio/wav', byteLength: 50, durationMs: 9_000 };
    expect(assessDelivery(audio, { allowedMediaTypes: ['audio/mpeg'] })).toMatchObject({ operation: 'transcodeAudio' });
    expect(assessDelivery(audio, { maxBytes: 40 })).toMatchObject({ operation: 'transcodeAudio' });
    expect(assessDelivery(audio, { maxDurationMs: 8_000 })).toMatchObject({ operation: 'trimMedia' });
    expect(assessDelivery(audio, { maxEdge: 1 })).toEqual({ status: 'usable' });
  });

  it('does not assign an image or video operation to another media type', () => {
    expect(assessDelivery({ mediaType: 'application/pdf', byteLength: 20 }, { maxBytes: 10 })).toEqual({
      status: 'unsupported',
      mediaType: 'application/pdf',
    });
  });

  it('rejects a negative limit', () => {
    expect(() => assessDelivery(image, { maxBytes: -1 })).toThrowError(
      expect.objectContaining({ code: 'config_invalid' }),
    );
  });
});