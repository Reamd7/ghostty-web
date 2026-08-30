import { Ghostty } from './dist/ghostty-web.js';
// 每个场景独立进程验证（无前序状态）
const scenario = process.argv[2];
const g = await Ghostty.load();
const t = g.createTerminal(80, 24);
if (scenario === 'tiny') { t.resize(1, 1); for (let i = 0; i < 1000; i++) t.write('abcdefghij\r\n'); console.log('tiny alone: OK'); }
else if (scenario === 'osc') { t.write('\x1b]0;' + 'x'.repeat(65536)); t.write('\x07ok\r\n'); for (let i = 0; i < 1000; i++) t.write('abcdefghij\r\n'); console.log('osc alone: OK'); }
else if (scenario === 'dcs') { t.write('\x1bPq' + 'x'.repeat(65536)); t.write('\x1b\\ok\r\n'); for (let i = 0; i < 1000; i++) t.write('abcdefghij\r\n'); console.log('dcs alone: OK'); }
else if (scenario === 'osc-then-tiny') {
  // 大 OSC 在实例 A，小网格在实例 B（同 Ghostty 单例）
  const a = g.createTerminal(80, 24);
  a.write('\x1b]0;' + 'x'.repeat(65536)); a.write('\x07ok\r\n'); a.free();
  t.resize(1, 1); for (let i = 0; i < 1000; i++) t.write('abcdefghij\r\n');
  console.log('osc-then-tiny: OK');
}
