import { gunzipSync } from 'node:zlib';
import fs from 'node:fs';
import config from './config.ts';

let qs = 0;
let eps = 0;
let jData: any;
// On boot, start with the initial data included in repo
await loadJData('./jeopardy.json.gz');
loadJData();
// Periodically refetch the latest episode data and replace it in memory
setInterval(loadJData, 24 * 60 * 60 * 1000);

async function loadJData(fileName?: string) {
  console.time('load');
  let buf: Buffer | undefined;
  if (fileName) {
    buf = fs.readFileSync('./jeopardy.json.gz');
  } else {
    if (config.NODE_ENV !== 'development') {
      try {
        const response = await fetch(
          'https://github.com/howardchung/j-archive-parser/raw/release/jeopardy.json.gz',
        );
        buf = Buffer.from(await response.arrayBuffer());

      } catch (e) {
        console.log(e);
      }
    }
  }
  if (buf) {
    jData = JSON.parse(gunzipSync(buf).toString());
    updateJDataStats();
  }
  console.timeEnd('load');
}

function updateJDataStats() {
  qs = 0;
  eps = 0;
  Object.keys(jData).forEach((key) => {
    eps += 1;
    qs += jData[key].jeopardy.length;
    qs += jData[key].double.length;
    qs + jData[key].final.length;
  });
}

export function getJData() {
  return jData;
}

export function getJDataStats() {
  return { qs, eps };
}
