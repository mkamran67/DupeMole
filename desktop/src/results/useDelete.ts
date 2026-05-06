import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useResults } from './ResultsContext';
import type { DeleteFailure, DeleteResult } from './types';

export interface DeleteOutcome {
  deleted: string[];
  failed: DeleteFailure[];
}

export function useDelete() {
  const { pruneScan } = useResults();
  const [deleting, setDeleting] = useState(false);
  const [lastFailures, setLastFailures] = useState<DeleteFailure[]>([]);

  const deleteFiles = useCallback(
    async (paths: string[], permanent: boolean): Promise<DeleteOutcome> => {
      if (paths.length === 0) {
        return { deleted: [], failed: [] };
      }
      setDeleting(true);
      try {
        const result = await invoke<DeleteResult>('delete_files', { paths, permanent });
        if (result.deleted.length > 0) {
          await pruneScan(result.deleted);
        }
        setLastFailures(result.failed);
        return result;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const failed = paths.map((path) => ({ path, error }));
        setLastFailures(failed);
        return { deleted: [], failed };
      } finally {
        setDeleting(false);
      }
    },
    [pruneScan]
  );

  const clearFailures = useCallback(() => setLastFailures([]), []);

  return { deleting, deleteFiles, lastFailures, clearFailures };
}
