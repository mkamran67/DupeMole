export interface BackendDuplicateFile {
  path: string;
  size: number;
  modifiedMs: number | null;
}

export interface BackendDuplicateGroup {
  id: string;
  hash: string;
  size: number;
  hashKind: 'full' | 'partial';
  files: BackendDuplicateFile[];
}

export interface ScanComplete {
  groups: BackendDuplicateGroup[];
  totalFiles: number;
  duplicateFiles: number;
  wastedBytes: number;
  extensionCounts: Record<string, number>;
}

export interface DeleteFailure {
  path: string;
  error: string;
}

export interface DeleteResult {
  deleted: string[];
  failed: DeleteFailure[];
}
