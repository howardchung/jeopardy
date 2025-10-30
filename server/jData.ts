import { gunzipSync } from 'zlib';
import fs from 'fs';
import config from './config.ts';

let qs = 0;
let eps = 0;
// On boot, start with the initial data included in repo
console.time('load');
let jData = JSON.parse(
  gunzipSync(fs.readFileSync('./jeopardy.json.gz')).toString(),
);
updateJDataStats();
console.timeEnd('load');
console.log('loaded %d episodes', Object.keys(jData).length);
let etag: string | null = null;

// Periodically refetch the latest episode data and replace it in memory
setInterval(refreshEpisodes, 24 * 60 * 60 * 1000);
refreshEpisodes();

async function refreshEpisodes() {
  if (config.NODE_ENV === 'development') {
    return;
  }
  console.time('reload');
  try {
    const response = await fetch(
      'https://github.com/howardchung/j-archive-parser/raw/release/jeopardy.json.gz',
    );
    const newEtag = response.headers.get('etag');
    console.log(newEtag, etag);
    if (newEtag !== etag) {
      const arrayBuf = await response.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      jData = JSON.parse(gunzipSync(buf).toString());
      updateJDataStats();
      etag = newEtag;
    }
  } catch (e) {
    console.log(e);
  }
  console.timeEnd('reload');
}

function updateJDataStats() {
  console.time('count');
  qs = 0;
  eps = 0;
  Object.keys(jData).forEach((key) => {
    eps += 1;
    qs += jData[key].jeopardy.length;
    qs += jData[key].double.length;
    qs + jData[key].final.length;
  });
  console.timeEnd('count');
}

export function getJData() {
  return jData;
}

export function getJDataStats() {
  return { qs, eps };
}
