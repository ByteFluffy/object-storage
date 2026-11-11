import type { Checksum, Source } from '../../core/contracts.js';
import type { ProcessingResult } from '../../core/plugin.js';

export type VideoContainer = 'mp4' | 'webm' | 'mkv';
export type AudioContainer = 'mp3' | 'm4a' | 'wav';
export type TrimPrecision = 'keyframe' | 'exact';

export type MediaRuntime = Readonly<{
  ffmpegPath: string;
  ffprobePath: string;
  workspaceDirectory: string;
  deadlineMs: number;
  signal: AbortSignal;
  maxInputBytes?: number;
}>;

export type VideoSettings = Readonly<{
  encoder: string;
  bitrate: number;
  fps?: number;
  width?: number;
  height?: number;
}>;

export type AudioSettings = Readonly<{
  encoder: string;
  bitrate: number;
  sampleRate?: number;
}>;

export type MediaRuntimeInput = Readonly<{
  ffmpegPath: string;
  ffprobePath: string;
  workspaceDirectory: string;
  deadlineMs: number;
  signal: AbortSignal;
  maxInputBytes?: number;
}>;

export type ProbeMediaRequest = MediaRuntimeInput & Readonly<{
  source: Source;
}>;

export type VideoStreamInfo = Readonly<{
  codec: string;
  width: number;
  height: number;
  fps: number;
}>;

export type AudioStreamInfo = Readonly<{
  codec: string;
  sampleRate: number;
  channels: number;
}>;

export type MediaInfo = Readonly<{
  formatName: string;
  durationMs: number;
  video: VideoStreamInfo | null;
  audio: AudioStreamInfo | null;
}>;

export type MediaProbe = MediaInfo & Readonly<{
  byteLength: number;
  inputChecksum: Checksum;
}>;

export type TranscodeVideoRequest = MediaRuntimeInput & Readonly<{
  source: Source;
  container: VideoContainer;
  video: VideoSettings;
  audio?: AudioSettings;
  dropAudio?: boolean;
  durationToleranceMs: number;
}>;

export type CompressVideoRequest = MediaRuntimeInput & Readonly<{
  source: Source;
  container: VideoContainer;
  videoEncoder: string;
  audio?: AudioSettings;
  dropAudio?: boolean;
  fps?: number;
  width?: number;
  height?: number;
  maxBytes: number;
  maxAttempts: number;
  durationToleranceMs: number;
}>;

export type TranscodeAudioRequest = MediaRuntimeInput & Readonly<{
  source: Source;
  container: AudioContainer;
  audio: AudioSettings;
  durationToleranceMs: number;
}>;

export type ExtractFrameRequest = MediaRuntimeInput & Readonly<{
  source: Source;
  imageEncoder: string;
  atMs: number;
  width?: number;
  height?: number;
}>;

export type TrimMediaRequest = MediaRuntimeInput & Readonly<{
  source: Source;
  container: VideoContainer | AudioContainer;
  startMs: number;
  endMs: number;
  precision: TrimPrecision;
  video?: VideoSettings;
  audio?: AudioSettings;
  dropAudio?: boolean;
  durationToleranceMs: number;
}>;

export type TrimMediaResult = ProcessingResult & Readonly<{
  precision: TrimPrecision;
  frameAccurate: boolean;
}>;

export type ConcatMediaRequest = MediaRuntimeInput & Readonly<{
  sources: readonly Source[];
  container: VideoContainer;
  allowNormalize?: boolean;
  video?: VideoSettings;
  audio?: AudioSettings;
  dropAudio?: boolean;
  durationToleranceMs: number;
}>;
