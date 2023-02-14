import './index.css';
import 'semantic-ui-css/semantic.min.css';

import { createRoot } from 'react-dom';

import App from './components/App';
import * as serviceWorker from './serviceWorker';
import { JeopardyHome } from './components/Home/Home';

const isHome = !Boolean(window.location.hash.substring(1));
const container = document.getElementById('root');
const root = createRoot(container);
root.render(isHome ? <JeopardyHome /> : <App />);

// If you want your app to work offline and load faster, you can change
// unregister() to register() below. Note this comes with some pitfalls.
// Learn more about service workers: https://bit.ly/CRA-PWA
serviceWorker.unregister();
