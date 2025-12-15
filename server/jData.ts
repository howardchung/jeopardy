import { gunzipSync } from "node:zlib";
import fs from "node:fs";
import config from "./config.ts";

let qs = 0;
let eps = 0;
let jData: Record<
  string,
  {
    epNum: string;
    airDate: string;
    info: string;
    jeopardy?: RawQuestion[];
    double?: RawQuestion[];
    triple?: RawQuestion[];
    final?: RawQuestion[];
  }
>;
// On boot, start with the initial data included in repo
await loadJData("./jeopardy.json.gz");
loadJData();
// Periodically refetch the latest episode data and replace it in memory
setInterval(loadJData, 24 * 60 * 60 * 1000);

async function loadJData(fileName?: string) {
  console.time("load");
  let buf: Buffer | undefined;
  if (fileName) {
    buf = fs.readFileSync("./jeopardy.json.gz");
  } else {
    if (config.NODE_ENV !== "development") {
      const resp = await fetch(
        "https://github.com/howardchung/j-archive-parser/raw/release/jeopardy.json.gz",
      );
      if (resp.ok) {
        buf = Buffer.from(await resp.arrayBuffer());
      }
    }
  }
  if (buf) {
    jData = JSON.parse(gunzipSync(buf).toString());
    updateJDataStats();
  }
  console.timeEnd("load");
}

function updateJDataStats() {
  qs = 0;
  eps = 0;
  Object.keys(jData).forEach((key) => {
    eps += 1;
    qs += jData[key].jeopardy?.length ?? 0;
    qs += jData[key].double?.length ?? 0;
    qs += jData[key].final?.length ?? 0;
  });
}

export function getJData() {
  return jData;
}

export function getJDataStats() {
  return { qs, eps };
}
