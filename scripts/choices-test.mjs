// 离线自测行动选项规则：pnpm choices:test <规则文件|-> <样例文本文件>
//   规则文件  choice-rules.json 的路径；写 - 表示只用内置规则
//   样例文本  一条回复的原始文本（ST 里 chat[i].mes，即 ST 里“编辑消息”看到的内容）
// 输出命中的规则、解析出的选项、去掉选项块后的正文。退出码：命中 0，没命中 1，规则文件有问题 2。
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const [rulesPath, samplePath] = process.argv.slice(2);
if (!rulesPath || !samplePath) {
  console.error('用法：pnpm choices:test <规则文件|-> <样例文本文件>');
  process.exit(2);
}

const out = await build({ entryPoints: ['src/server/choices.ts'], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

let user = [];
if (rulesPath !== '-') {
  let json;
  try {
    json = JSON.parse(readFileSync(rulesPath, 'utf8'));
  } catch (e) {
    console.error(`无法读取规则文件 ${rulesPath}：${e.message}`);
    process.exit(2);
  }
  const v = mod.validateRules(json);
  for (const i of v.issues) console.error(`规则 [${i.rule}]：${i.message}`);
  if (v.issues.length > 0) process.exit(2);
  user = v.rules;
}
const compiled = mod.compileRules([...user, ...mod.DEFAULT_RULES]);
for (const i of compiled.issues) console.error(`规则 [${i.rule}]：${i.message}`);
if (compiled.issues.length > 0) process.exit(2);

const raw = readFileSync(samplePath, 'utf8');
// 渲染文本在这里没有，用原文代替；真实环境里文本/HTML 的去除效果以日志和 Telegram 里看到的为准。
const r = mod.parseChoices(raw, '', raw, compiled.rules);
if (!r) {
  console.log('没有命中任何规则（回复会原样发送，没有按钮）。');
  console.log(`已尝试的规则：${compiled.rules.map((x) => x.name).join('、')}`);
  process.exit(1);
}
console.log(`命中规则：${r.rule}`);
console.log(`选项 ${r.choices.length} 个：`);
r.choices.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
console.log('\n去掉选项块后的正文：');
console.log(r.text);
