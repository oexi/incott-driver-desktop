// 原版配置/宏文本格式的解析工具：`key:value;` 串联。行为与原版 findValForKey 系列一致。

export function findValForKey(str, key) {
  if (str == null || key == null || key === '') return null;
  let i = str.indexOf(key + ':');
  if (i === -1) return null;
  i += key.length + 1;
  const j = str.indexOf(';', i);
  if (j === -1) return null;
  return str.substring(i, j);
}

export function stringToNumber(str) {
  if (str == null || str === '') return null;
  const n = parseInt(str);
  return Number.isNaN(n) ? null : n;
}

export function findValForKeyNumber(str, key) {
  return stringToNumber(findValForKey(str, key));
}

export function findValForKeyBool(str, key) {
  const s = findValForKey(str, key);
  if (s == null) return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  return null;
}
