// check.mjs — 一次檢查所有前端模組的語法
//
//   node check.mjs
//
// 沒有建置流程，瀏覽器只會在載入時才報語法錯誤，而且訊息不含行號。
// 這支腳本把每個 .js 當成 ES module 交給 Node 解析，錯誤會直接指到行。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const JS = path.join(ROOT, 'js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jl-check-'));

const files = fs.readdirSync(JS).filter((f) => f.endsWith('.js')).sort();
let bad = 0;

for (const f of files) {
  // Node 依副檔名判斷模組類型，.js 會被當成 CommonJS，所以複製成 .mjs 再檢查
  const t = path.join(tmp, f.replace(/\.js$/, '.mjs'));
  fs.copyFileSync(path.join(JS, f), t);
  try {
    execFileSync(process.execPath, ['--check', t], { stdio: 'pipe' });
    console.log(`  ok    js/${f}`);
  } catch (e) {
    bad++;
    const msg = (e.stderr?.toString() || e.message).split('\n').slice(0, 6).join('\n');
    console.log(`  FAIL  js/${f}\n${msg.replace(new RegExp(tmp.replace(/\\/g, '\\\\'), 'g'), 'js')}`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${files.length} 個模組，${bad ? bad + ' 個有語法錯誤' : '全部通過'}\n`);
process.exit(bad ? 1 : 0);
