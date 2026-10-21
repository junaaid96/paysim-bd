import { RealtimeProvider } from '@neon/realtime-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './index.css';
import { realtimeClient } from './realtime';

const queryClient = new QueryClient();
const realtime = realtimeClient();

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root element');
}
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {realtime ? (
        <RealtimeProvider client={realtime}>
          <App />
        </RealtimeProvider>
      ) : (
        <App />
      )}
    </QueryClientProvider>
  </StrictMode>,
);
