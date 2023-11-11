import 'semantic-ui-css/semantic.min.css';

import { createRoot } from 'react-dom/client';

import App from './src/components/App';
import { JeopardyHome } from './src/components/Home/Home';
import React from 'react';

const isHome = !Boolean(window.location.hash.substring(1));
const container = document.getElementById('root');
const root = createRoot(container);
root.render(isHome ? <JeopardyHome /> : <App />);