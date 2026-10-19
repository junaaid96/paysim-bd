import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

export type StreamStatus = 'live' | 'reconnecting' | 'idle';

/** Subscribe to the workspace SSE stream; invalidate queries on any event. */
export function useLiveUpdates(workspaceKey: string): StreamStatus {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<StreamStatus>('idle');

  useEffect(() => {
    const source = new EventSource(`/api/stream?workspace=${encodeURIComponent(workspaceKey)}`);
    const invalidate = (): void => {
      void queryClient.invalidateQueries();
    };
    source.addEventListener('connected', () => setStatus('live'));
    source.addEventListener('txn.created', invalidate);
    source.addEventListener('txn.updated', invalidate);
    source.addEventListener('event.created', invalidate);
    source.addEventListener('delivery.created', invalidate);
    source.addEventListener('delivery.updated', invalidate);
    source.addEventListener('clock.changed', invalidate);
    source.onerror = (): void => setStatus('reconnecting');
    return () => {
      source.close();
      setStatus('idle');
    };
  }, [workspaceKey, queryClient]);

  return status;
}
