'use strict';

// Linux 下 WebHID 走 /dev/hidraw*，普通用户默认没有读写权限，需要 udev 规则。
// 这里负责检测权限，并可通过 pkexec 一键安装规则。

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const RULES_PATH = '/etc/udev/rules.d/70-incott-mouse.rules';
const RULES = `# INCOTT mouse (Pixart 093A) — 允许桌面驱动通过 hidraw 访问设备
# 522C: 2.4G 无线接收器 / 622C: 有线
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="093a", ATTRS{idProduct}=="522c", MODE="0666", TAG+="uaccess"
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="093a", ATTRS{idProduct}=="622c", MODE="0666", TAG+="uaccess"
`;

function linuxHidrawStatus(vendorId) {
  if (process.platform !== 'linux') return { platform: process.platform, devices: [], needsFix: false };
  const vid = vendorId.toString(16).toUpperCase().padStart(8, '0');
  const devices = [];
  let entries = [];
  try {
    entries = fs.readdirSync('/sys/class/hidraw');
  } catch {
    return { platform: 'linux', devices, needsFix: false };
  }
  for (const name of entries) {
    let uevent = '';
    try {
      uevent = fs.readFileSync(path.join('/sys/class/hidraw', name, 'device', 'uevent'), 'utf8');
    } catch {
      continue;
    }
    const id = /HID_ID=([0-9A-F]+):([0-9A-F]+):([0-9A-F]+)/i.exec(uevent);
    if (!id || id[2].toUpperCase() !== vid) continue;
    let access = false;
    try {
      fs.accessSync(path.join('/dev', name), fs.constants.R_OK | fs.constants.W_OK);
      access = true;
    } catch {
      access = false;
    }
    devices.push({ node: `/dev/${name}`, productId: parseInt(id[3], 16), access });
  }
  return {
    platform: 'linux',
    devices,
    rulesInstalled: fs.existsSync(RULES_PATH),
    needsFix: devices.length > 0 && devices.some((d) => !d.access),
  };
}

function installUdevRules() {
  return new Promise((resolve) => {
    if (process.platform !== 'linux') return resolve({ ok: false, error: 'not linux' });
    const script = [
      `cat > ${RULES_PATH} <<'EOF'`,
      RULES.trimEnd(),
      'EOF',
      'udevadm control --reload-rules',
      'udevadm trigger --subsystem-match=hidraw',
    ].join('\n');
    execFile('pkexec', ['sh', '-c', script], (err, _stdout, stderr) => {
      if (err) resolve({ ok: false, error: String(stderr || err.message), rules: RULES, path: RULES_PATH });
      else resolve({ ok: true, path: RULES_PATH });
    });
  });
}

module.exports = { linuxHidrawStatus, installUdevRules, RULES, RULES_PATH };
