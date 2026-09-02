// 生成站点访问用的 TOTP 密钥（Base32），输出 otpauth:// URI 供验证器 App 录入，
// 并可选现场校验一次动态口令，确认密钥正确后再写入 ESA 控制台。
//
// 用法：
//   node scripts/setup-totp.mjs [账号名，默认 GiveMeOC]
//
// 之后：ESA 控制台 → 边缘计算和 AI → 函数和Pages → 目标函数 → 基本信息 → 函数变量
//       添加变量：键 TOTP_SECRET，值 = 下面生成的密钥（建议勾选「加密存储」）
//       注意：必须重新部署版本后才会生效。
import { createHmac, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;
const DIGITS = 6;
const SKEW = 1; // 与边缘函数一致：容忍 ±1 个时间窗

function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input) {
  const s = String(input || '').toUpperCase().replace(/[=\s-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error(`密钥含非法字符: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function counterBytes(counter) {
  const b = Buffer.alloc(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    b[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  return b;
}

function hotpAt(secretBytes, counter) {
  const mac = createHmac('sha1', Buffer.from(secretBytes)).update(counterBytes(counter)).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

// 与边缘函数同参的实现，可用于本地提前算出当前口令（调试用）
export function currentCode(secret, atSeconds = Math.floor(Date.now() / 1000)) {
  const base = Math.floor(atSeconds / PERIOD);
  return hotpAt(base32Decode(secret), base);
}

function verify(secret, input, atSeconds = Math.floor(Date.now() / 1000)) {
  const code = String(input || '').replace(/\D/g, '');
  if (code.length !== DIGITS) return false;
  const base = Math.floor(atSeconds / PERIOD);
  const bytes = base32Decode(secret);
  for (let d = -SKEW; d <= SKEW; d++) {
    if (hotpAt(bytes, base + d) === code) return true;
  }
  return false;
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (v) => resolve(String(v || '').trim())));
}

async function main() {
  const label = process.argv[2] || 'GiveMeOC';
  const issuer = 'GiveMeOC';
  // 160 bit（20 字节）与主流验证器默认长度一致
  const secret = base32Encode(randomBytes(20));
  const uri = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}`
    + `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`;

  console.log('\n=== 你的 TOTP 密钥（请妥善保存，只显示这一次）===');
  console.log(secret);
  console.log('\n=== 验证器 App 录入 URI（Google / 微软 / 1Password 等均支持）===');
  console.log(uri);
  console.log('\n生成二维码（任选其一）：');
  console.log(`  npx qrcode-terminal -t utf8 "${uri}"`);
  console.log('  或在验证器 App 中选择「手动输入密钥」，粘贴上面的 Base32 密钥。');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const input = await ask(rl, '\n录入后请输入 App 上的 6 位数字以验证（直接回车跳过）: ');
    if (!input) {
      console.log('[·] 已跳过验证。');
    } else if (verify(secret, input)) {
      console.log('[√] 校验通过，密钥可用。');
    } else {
      const remain = PERIOD - (Math.floor(Date.now() / 1000) % PERIOD);
      console.log(`[×] 校验失败。请确认手机时间准确（依赖网络时间同步），可等 ${remain}s 后换新码重试。`);
      console.log(`    若持续失败，重新生成本脚本即可。当前窗口的口令应为: ${currentCode(secret)}`);
    }
  } finally {
    rl.close();
  }

  console.log('\n=== 下一步 ===');
  console.log('1) ESA 控制台 → 边缘计算和 AI → 函数和Pages → 目标函数 → 基本信息 → 函数变量');
  console.log('2) 添加变量：键 TOTP_SECRET，值 = 上面的密钥（建议勾选「加密存储」）');
  console.log('3) 重新部署版本（变量需随下一版本生效），随后访问站点即可看到登录页。');
}

main().catch((e) => {
  console.error('[*] 失败:', e.message);
  process.exit(1);
});
