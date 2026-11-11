export type ChecksumAlgorithm = 'sha256' | 'crc64-ecma';

export type Checksum = Readonly<{
  algorithm: ChecksumAlgorithm;
  value: string;
}>;

export type ObjectRef = Readonly<{
  storageId: string;
  key: string;
  version?: string;
}>;

export type DeliveryEvidence =
  | Readonly<{ status: 'not_requested' }>
  | Readonly<{ status: 'preparing'; nextCheckAt: string }>
  | Readonly<{ status: 'verified'; checkedAt: string; objectRevision: string }>
  | Readonly<{ status: 'failed' | 'timed_out'; code: string }>;

export type UploadResult = Readonly<{
  object: ObjectRef;
  byteLength: number;
  checksum: Checksum | null;
  etag: string | null;
  reused: boolean;
  delivery: Readonly<{ status: 'not_requested' }>;
}>;

export type Source =
  | Readonly<{ kind: 'bytes'; data: Uint8Array }>
  | Readonly<{ kind: 'file'; path: string }>
  | Readonly<{
      kind: 'stream';
      stream: ReadableStream<Uint8Array>;
      declaredByteLength?: number;
    }>;

export type ObjectStat = Readonly<{
  byteLength: number;
  checksum: Checksum | null;
  etag: string | null;
  contentType?: string;
}>;

export type DriverCapabilities = Readonly<{
  put: boolean;
  copy: boolean;
  conditionalWrite: Readonly<{ ifNoneMatch: boolean }>;
  checksums: readonly ChecksumAlgorithm[];
  presignMethods: readonly ('GET' | 'PUT' | 'HEAD')[];
  multipart: Readonly<{ minPartBytes: number; maxPartBytes: number }> | null;
}>;

export type PutPrecondition = Readonly<{ ifNoneMatch: '*' }>;

export type DriverPut = Readonly<{
  object: ObjectRef;
  data: Uint8Array;
  contentType?: string;
  checksum: Checksum;
  precondition?: PutPrecondition;
  signal?: AbortSignal;
}>;

export type DriverCopy = Readonly<{
  from: ObjectRef;
  to: ObjectRef;
  ifNoneMatch?: '*';
  signal?: AbortSignal;
}>;

export interface StorageDriver {
  readonly storageId: string;
  readonly capabilities: DriverCapabilities;
  put(input: DriverPut): Promise<{ etag: string | null; checksum: Checksum | null }>;
  stat(ref: ObjectRef): Promise<ObjectStat | null>;
  read(ref: ObjectRef): Promise<{ data: Uint8Array; checksum: Checksum | null }>;
  copy(input: DriverCopy): Promise<void>;
  delete(ref: ObjectRef): Promise<void>;
  presignPut?(input: PresignPutInput): Promise<DirectUploadPlan>;
  presignGet?(input: PresignGetInput): Promise<DirectReadPlan>;
  createMultipart?(input: CreateMultipartInput): Promise<MultipartSession>;
  presignPart?(input: PresignPartInput): Promise<DirectUploadPlan>;
  completeMultipart?(input: CompleteMultipartInput): Promise<{ etag: string | null }>;
  abortMultipart?(input: AbortMultipartInput): Promise<void>;
}

export type DirectUploadPlan = Readonly<{
  method: 'PUT';
  url: string;
  headers: Readonly<Record<string, string>>;
}>;

export type PresignPutInput = Readonly<{
  object: ObjectRef;
  contentType?: string;
  expiresInSeconds: number;
}>;

export type DirectReadPlan = Readonly<{
  method: 'GET';
  url: string;
  headers: Readonly<Record<string, string>>;
}>;

export type PresignGetInput = Readonly<{
  object: ObjectRef;
  expiresInSeconds: number;
}>;

export type CreateMultipartInput = Readonly<{
  object: ObjectRef;
  contentType?: string;
  partSize: number;
  totalBytes: number;
}>;

export type MultipartSession = Readonly<{
  uploadId: string;
  partCount: number;
}>;

export type PresignPartInput = Readonly<{
  object: ObjectRef;
  uploadId: string;
  partNumber: number;
  expiresInSeconds: number;
}>;

export type CompleteMultipartInput = Readonly<{
  object: ObjectRef;
  uploadId: string;
  parts: readonly { partNumber: number; etag: string }[];
}>;

export type AbortMultipartInput = Readonly<{
  object: ObjectRef;
  uploadId: string;
}>;

export type UploadRequest = Readonly<{
  storageId: string;
  key: string;
  source: Source;
  contentType?: string;
  maxInputBytes?: number;
  signal?: AbortSignal;
  expectedChecksum?: Checksum;
  precondition?: PutPrecondition;
  multipart?: 'required';
}>;

export type FinalizeRequest = Readonly<{
  storageId: string;
  tempKey: string;
  finalKey: string;
  expectedChecksum: Checksum;
  signal?: AbortSignal;
}>;

export type ScalarConfig = Readonly<Record<string, string | number | boolean>>;
