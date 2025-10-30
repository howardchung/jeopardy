import '@mantine/core/styles.css';
import { createRoot } from 'react-dom/client';
import App from './components/App';
import { JeopardyHome } from './components/Home/Home';
import React from 'react';
import { createTheme, MantineProvider } from '@mantine/core';

const theme = createTheme({
  /** Put your mantine theme override here */
});

const urlParams = new URLSearchParams(window.location.search);
const gameId = urlParams.get('game');
const isHome = !Boolean(gameId);
const container = document.getElementById('root');
const root = createRoot(container!);
root.render(
  <React.StrictMode>
    <MantineProvider theme={theme} forceColorScheme="dark">
      {isHome ? <JeopardyHome /> : <App />}
    </MantineProvider>
  </React.StrictMode>,
);
