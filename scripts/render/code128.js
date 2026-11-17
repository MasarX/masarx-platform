const CODE128_PATTERNS = [
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100', '10001001100', '10011001000',
  '10011000100', '10001100100', '11001001000', '11001000100', '11000100100', '10110011100', '10011011100',
  '10011001110', '10111001100', '10011101100', '10011100110', '11001110010', '11001011100', '11001001110',
  '11011100100', '11001110100', '11101101110', '11101001100', '11100101100', '11100100110', '11101100100',
  '11100110100', '11100110010', '11011011000', '11011000110', '11000110110', '10100011000', '10001011000',
  '10001000110', '10110001000', '10001101000', '10001100010', '11010001000', '11000101000', '11000100010',
  '10110111000', '10110001110', '10001101110', '10111011000', '10111000110', '10001110110', '11101110110',
  '11010001110', '11000101110', '11011101000', '11011100010', '11011101110', '11101011000', '11101000110',
  '11100010110', '11101101000', '11101100010', '11100011010', '11101111010', '11001000010', '11110001010',
  '10100110000', '10100001100', '10010110000', '10010000110', '10000101100', '10000100110', '10110010000',
  '10110000100', '10011010000', '10011000010', '10000110100', '10000110010', '11000010010', '11001010000',
  '11110111010', '11000010100', '10001111010', '10100111100', '10010111100', '10010011110', '10111100100',
  '10011110100', '10011110010', '11110100100', '11110010100', '11110010010', '11011011110', '11011110110',
  '11110110110', '10101111000', '10100011110', '10001011110', '10111101000', '10111100010', '11110101000',
  '11110100010', '10111011110', '10111101110', '11101011110', '11110101110', '11010000100', '11010010000',
  '11010011100', '1100011101011',
];

const START_CODE_B = 104;
const START_CODE_C = 105;
const SWITCH_TO_C = 99;
const SWITCH_TO_B = 100;
const STOP_CODE = 106;

const isDigit = (c) => c >= '0' && c <= '9';

const patternToRuns = (pattern) => {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new Error('Invalid Code128 pattern');
  }
  if (pattern[0] !== '1') {
    throw new Error('Code128 pattern must start with a bar');
  }
  const runs = [];
  let cur = pattern[0];
  let count = 1;
  for (let i = 1; i < pattern.length; i += 1) {
    const bit = pattern[i];
    if (bit === cur) {
      count += 1;
      continue;
    }
    runs.push(count);
    cur = bit;
    count = 1;
  }
  runs.push(count);
  return runs;
};

const CODE128_RUNS = CODE128_PATTERNS.map(patternToRuns);
CODE128_RUNS[STOP_CODE] = patternToRuns(CODE128_PATTERNS[CODE128_PATTERNS.length - 1]);

const code128BCodeForChar = (ch) => {
  const cp = ch.charCodeAt(0);
  if (cp < 32 || cp > 126) {
    const err = new Error(`Invalid Code128-B character: ${ch}`);
    err.code = 'invalid_code128_input';
    throw err;
  }
  return cp - 32;
};

const code128CCodeForPair = (a, b) => Number(`${a}${b}`);

const encodeCode128Auto = (value) => {
  if (value == null) return null;
  const s = String(value);

  const n = s.length;
  const nodeCount = (n + 1) * 2;
  const INF = Number.POSITIVE_INFINITY;

  const dist = new Array(nodeCount).fill(INF);
  const prev = new Array(nodeCount).fill(null);

  const id = (i, mode) => i * 2 + mode;
  const MODE_B = 0;
  const MODE_C = 1;

  const q = [];
  const push = (nodeId) => q.push(nodeId);

  dist[id(0, MODE_B)] = 1;
  prev[id(0, MODE_B)] = { prevId: null, code: START_CODE_B };
  push(id(0, MODE_B));

  dist[id(0, MODE_C)] = 1;
  prev[id(0, MODE_C)] = { prevId: null, code: START_CODE_C };
  push(id(0, MODE_C));

  let qi = 0;
  while (qi < q.length) {
    const curId = q[qi++];
    const curDist = dist[curId];
    const i = Math.floor(curId / 2);
    const mode = curId % 2;

    if (mode === MODE_B) {
      if (i < n) {
        const nextId = id(i + 1, MODE_B);
        const code = code128BCodeForChar(s[i]);
        if (curDist + 1 < dist[nextId]) {
          dist[nextId] = curDist + 1;
          prev[nextId] = { prevId: curId, code };
          push(nextId);
        }
      }
      const switchId = id(i, MODE_C);
      if (curDist + 1 < dist[switchId]) {
        dist[switchId] = curDist + 1;
        prev[switchId] = { prevId: curId, code: SWITCH_TO_C };
        push(switchId);
      }
    } else {
      if (i + 1 < n && isDigit(s[i]) && isDigit(s[i + 1])) {
        const nextId = id(i + 2, MODE_C);
        const code = code128CCodeForPair(s[i], s[i + 1]);
        if (curDist + 1 < dist[nextId]) {
          dist[nextId] = curDist + 1;
          prev[nextId] = { prevId: curId, code };
          push(nextId);
        }
      }
      const switchId = id(i, MODE_B);
      if (curDist + 1 < dist[switchId]) {
        dist[switchId] = curDist + 1;
        prev[switchId] = { prevId: curId, code: SWITCH_TO_B };
        push(switchId);
      }
    }
  }

  const endB = id(n, MODE_B);
  const endC = id(n, MODE_C);
  const end = dist[endB] <= dist[endC] ? endB : endC;
  if (!Number.isFinite(dist[end])) {
    const err = new Error('Unable to encode value as Code128 (auto)');
    err.code = 'invalid_code128_input';
    throw err;
  }

  const codes = [];
  let cur = end;
  while (cur != null) {
    const p = prev[cur];
    if (!p) break;
    codes.push(p.code);
    cur = p.prevId;
  }
  codes.reverse();

  let checksum = codes[0] || START_CODE_B;
  for (let i = 1; i < codes.length; i += 1) {
    checksum += codes[i] * i;
  }
  checksum %= 103;

  const fullCodes = [...codes, checksum, STOP_CODE];
  const patternModules = fullCodes.reduce((sum, code) => sum + (CODE128_RUNS[code]?.reduce((a, b) => a + b, 0) || 0), 0);

  return {
    codes: fullCodes,
    patternModules,
    inputLength: n,
  };
};

module.exports = {
  CODE128_RUNS,
  STOP_CODE,
  START_CODE_B,
  START_CODE_C,
  SWITCH_TO_B,
  SWITCH_TO_C,
  encodeCode128Auto,
};

