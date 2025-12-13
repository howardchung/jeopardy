// Benchmark hashing algorithms
// import { xxHash32 } from 'js-xxhash';
import nodeCrypto from "node:crypto";
import { cyrb53 } from "../server/hash.ts";

const test = "test".repeat(100000);

// Note: due to VM optimization the later functions run faster
// Need to execute in separate processes for accurate testing
const jobs = {
  cyrb: () => cyrb53(test).toString(16),
  // xxhash: () => xxHash32(test).toString(16),
  // md5js: () => MD5.hash(test),
  // Works only in node
  md5node: () => nodeCrypto.createHash("md5").update(test).digest("hex"),
  // requires https in browser, also Buffer API to convert not available
  sha1: async () =>
    Buffer.from(
      await crypto.subtle.digest("sha-1", Buffer.from(test)),
    ).toString("hex"),
};

console.time(process.argv[2]);
console.log(await jobs[process.argv[2]]());
console.timeEnd(process.argv[2]);
