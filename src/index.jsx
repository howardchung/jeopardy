import 'semantic-ui-css/semantic.min.css';

import { createRoot } from 'react-dom/client';

import App from './components/App';
import { JeopardyHome } from './components/Home/Home';
import React from 'react';

const urlParams = new URLSearchParams(window.location.search);
const gameId = urlParams.get('game');
const isHome = !Boolean(gameId);
const container = document.getElementById('root');
const root = createRoot(container);
root.render(isHome ? <JeopardyHome /> : <React.StrictMode><App /></React.StrictMode>);
