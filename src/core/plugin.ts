import type { Checksum } from './contracts.ts';

/** A processing output that stays readable until the caller calls release(). */
export type ProcessingArtifact = Readonly<{
  path: string;
  byteLength: number;
  mediaType: string;
  checksum: Checksum;
  read(): Promise<Uint8Array>;
  release(): Promise<void>;
}>;

/** Processing success is not an upload and not a verified link. */
export type ProcessingResult = Readonly<{
  artifact: ProcessingArtifact;
  inputChecksum: Checksum;
  outputChecksum: Checksum;
}>;

export type ProbeStatus =
  | 'passed'
  | 'not_found'
  | 'forbidden'
  | 'mismatch'
  | 'unavailable'
  | 'timed_out'
  | 'redirected';

export type ProbeResult = Readonly<{
  status: ProbeStatus;
  checkedAt: string;
  byteLength?: number;
  checksum?: Checksum;
  mediaType?: string;
  nextCheckAt?: string;
  code?: string;
}>;
