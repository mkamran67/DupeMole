import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useResults } from './ResultsContext';
import { useStats } from '../stats/StatsContext';
import type { DeleteFailure, DeleteResult } from './types';

export interface DeleteOutcome {
  deleted: string[];
  failed: DeleteFailure[];
}

export interface DeleteProgress {
  processed: number;
  total: number;
  currentPath: string | null;
  permanent: boolean;
}

interface DeleteProgressEvent {
  processed: number;
  total: number;
  currentPath: string | null;
}

export function useDelete() {
  const { pruneScan } = useResults();
  const { refresh: refreshStats } = useStats();
  const [deleting, setDeleting] = useState(false);
  const [progress, setProgress] = useState<DeleteProgress | null>(null);
  const [lastFailures, setLastFailures] = useState<DeleteFailure[]>([]);

  const deleteFiles = useCallback(
    async (paths: string[], permanent: boolean): Promise<DeleteOutcome> => {
      if (paths.length === 0) {
        return { deleted: [], failed: [] };
      }
      setDeleting(true);
      setProgress({ processed: 0, total: paths.length, currentPath: null, permanent });

      let unlisten: UnlistenFn | undefined;
      try {
        unlisten = await listen<DeleteProgressEvent>('delete://progress', (e) => {
          setProgress({
            processed: e.payload.processed,
            total: e.payload.total,
            currentPath: e.payload.currentPath,
            permanent,
          });
        });

        const result = await invoke<DeleteResult>('delete_files', { paths, permanent });
        if (result.deleted.length > 0) {
          await pruneScan(result.deleted);
          refreshStats();
        }
        setLastFailures(result.failed);
        return result;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const failed = paths.map((path) => ({ path, error }));
        setLastFailures(failed);
        return { deleted: [], failed };
      } finally {
        unlisten?.();
        setDeleting(false);
        setProgress(null);
      }
    },
    [pruneScan, refreshStats]
  );

  const clearFailures = useCallback(() => setLastFailures([]), []);

  return { deleting, progress, deleteFiles, lastFailures, clearFailures };
}
