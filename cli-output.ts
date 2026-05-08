export function print(message = ""): void {
  process.stdout.write(`${message}\n`);
}

export function printError(message = ""): void {
  process.stderr.write(`${message}\n`);
}
