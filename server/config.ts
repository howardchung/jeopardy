import 'dotenv/config';

const defaults = {
  SSL_KEY_FILE: '', // Optional, Filename of SSL key (to use https)
  SSL_CRT_FILE: '', // Optional, Filename of SSL cert (to use https)
  PORT: '8083', // Port to use for server
  NODE_ENV: '',
  OPENAI_SECRET_KEY: '',
  STATS_KEY: 'test',
  REDIS_URL: '',
};

export default {
  ...defaults,
  ...process.env,
  permaRooms: ['/default', '/smokestack', '/howard-and-katie', '/liz'],
};