import { StorageError } from '../core/errors.js';

export type DeliveryFact = Readonly<{
  mediaType?: string;
  byteLength?: number;
  width?: number;
  height?: number;
  durationMs?: number;
}>;

export type DeliveryConstraint = Readonly<{
  allowedMediaTypes?: readonly string[];
  maxBytes?: number;
  maxEdge?: number;
  maxDurationMs?: number;
}>;

export type DeliveryOperation =
  | 'convertImage'
  | 'resizeImage'
  | 'compressImage'
  | 'transcodeVideo'
  | 'compressVideo'
  | 'trimMedia'
  | 'transcodeAudio';

export type DeliveryEvidence = 'mediaType' | 'byteLength' | 'edge' | 'durationMs';

export type DeliveryFit =
  | Readonly<{ status: 'usable' }>
  | Readonly<{ status: 'insufficient_evidence'; missing: readonly DeliveryEvidence[] }>
  | Readonly<{ status: 'unsupported'; mediaType: string }>
  | Readonly<{ status: 'adapt'; operation: DeliveryOperation; failed: readonly string[] }>;

type MediaKind = 'image' | 'video' | 'audio' | 'other';

export function assessDelivery(fact: DeliveryFact, constraint: DeliveryConstraint): DeliveryFit {
  assertLimits(constraint);
  const kind = kindOf(fact.mediaType);
  const missing = missingEvidence(fact, constraint, kind);
  if (missing.length > 0) return { status: 'insufficient_evidence', missing };

  const failed: string[] = [];
  if (typeRejected(fact.mediaType, constraint.allowedMediaTypes)) failed.push('mediaType');
  if (edgeRejected(fact, constraint, kind)) failed.push('edge');
  if (durationRejected(fact, constraint, kind)) failed.push('durationMs');
  if (bytesRejected(fact, constraint)) failed.push('byteLength');
  if (failed.length === 0) return { status: 'usable' };

  const operation = operationFor(failed[0], kind);
  if (operation === null) {
    return { status: 'unsupported', mediaType: essence(fact.mediaType ?? '') };
  }
  return { status: 'adapt', operation, failed };
}

function assertLimits(constraint: DeliveryConstraint): void {
  for (const [name, value] of [
    ['maxBytes', constraint.maxBytes],
    ['maxEdge', constraint.maxEdge],
    ['maxDurationMs', constraint.maxDurationMs],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new StorageError('config_invalid', `${name} must be a non-negative integer`);
    }
  }
}

function missingEvidence(
  fact: DeliveryFact,
  constraint: DeliveryConstraint,
  kind: MediaKind | 'missing',
): DeliveryEvidence[] {
  const missing: DeliveryEvidence[] = [];
  if (constraint.allowedMediaTypes !== undefined && fact.mediaType === undefined) missing.push('mediaType');
  if (constraint.maxBytes !== undefined && fact.byteLength === undefined) missing.push('byteLength');
  if (constraint.maxEdge !== undefined && kind !== 'audio' && (fact.width === undefined || fact.height === undefined)) {
    missing.push('edge');
  }
  if (constraint.maxDurationMs !== undefined && kind !== 'image' && fact.durationMs === undefined) {
    missing.push('durationMs');
  }
  return missing;
}

function typeRejected(mediaType: string | undefined, allowed: readonly string[] | undefined): boolean {
  if (allowed === undefined || mediaType === undefined) return false;
  const current = essence(mediaType);
  return !allowed.some((item) => essence(item) === current);
}

function edgeRejected(fact: DeliveryFact, constraint: DeliveryConstraint, kind: MediaKind | 'missing'): boolean {
  if (constraint.maxEdge === undefined || kind === 'audio' || fact.width === undefined || fact.height === undefined) {
    return false;
  }
  return Math.max(fact.width, fact.height) > constraint.maxEdge;
}

function durationRejected(fact: DeliveryFact, constraint: DeliveryConstraint, kind: MediaKind | 'missing'): boolean {
  if (constraint.maxDurationMs === undefined || kind === 'image' || fact.durationMs === undefined) return false;
  return fact.durationMs > constraint.maxDurationMs;
}

function bytesRejected(fact: DeliveryFact, constraint: DeliveryConstraint): boolean {
  return constraint.maxBytes !== undefined && fact.byteLength !== undefined && fact.byteLength > constraint.maxBytes;
}

function operationFor(failure: string | undefined, kind: MediaKind | 'missing'): DeliveryOperation | null {
  if (kind === 'image') {
    if (failure === 'mediaType') return 'convertImage';
    if (failure === 'edge') return 'resizeImage';
    if (failure === 'byteLength') return 'compressImage';
  }
  if (kind === 'video') {
    if (failure === 'mediaType' || failure === 'edge') return 'transcodeVideo';
    if (failure === 'durationMs') return 'trimMedia';
    if (failure === 'byteLength') return 'compressVideo';
  }
  if (kind === 'audio') {
    if (failure === 'mediaType' || failure === 'byteLength') return 'transcodeAudio';
    if (failure === 'durationMs') return 'trimMedia';
  }
  return null;
}

function kindOf(mediaType: string | undefined): MediaKind | 'missing' {
  if (mediaType === undefined) return 'missing';
  const value = essence(mediaType);
  if (value.startsWith('image/')) return 'image';
  if (value.startsWith('video/')) return 'video';
  if (value.startsWith('audio/')) return 'audio';
  return 'other';
}

function essence(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}
