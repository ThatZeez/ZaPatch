// Tiny terminal helpers. No dependencies; honors NO_COLOR and non-TTY.
const enabled = process.stdout.isTTY && !process.env.NO_COLOR;

function paint(code, s) {
  return enabled ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export const c = {
  bold: (s) => paint('1', s),
  green: (s) => paint('32', s),
  red: (s) => paint('31', s),
  yellow: (s) => paint('33', s),
  dim: (s) => paint('2', s),
};

export function header(title) {
  console.log(`\n${c.bold(title)}`);
  console.log('─'.repeat(Math.min(title.length + 8, 40)));
}

export function info(msg) {
  console.log(msg);
}

export function success(msg) {
  console.log(`${c.green('OK')}  ${msg}`);
}

export function failure(msg) {
  console.log(`${c.red('FAIL')} ${msg}`);
}

export function warn(msg) {
  console.log(c.yellow(msg));
}

export function dim(msg) {
  console.log(c.dim(msg));
}

// Spec-style step line: `Detecting Zalo...         OK`
export function step(name, status) {
  const pad = '.'.repeat(Math.max(2, 32 - name.length));
  if (status === 'ok') console.log(`${name} ${c.dim(pad)} ${c.green('OK')}`);
  else if (status === 'fail') console.log(`${name} ${c.dim(pad)} ${c.red('FAIL')}`);
  else if (status === 'run') console.log(`${name} ${c.dim(pad)} ...`);
  else console.log(`${name} ${c.dim(pad)} ${status}`);
}

export function reportError(err) {
  console.error(`\n${c.red('Error:')} ${err.message}`);
  if (err.hint) console.error(c.dim(`Hint: ${err.hint}`));
  if (err.code) console.error(c.dim(`Code: ${err.code}`));
}
