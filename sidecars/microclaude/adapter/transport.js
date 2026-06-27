import { StringDecoder } from 'node:string_decoder';

export class NdjsonTransport {
  #buffer = '';
  #decoder = new StringDecoder('utf8');
  #drainRegistered = false;
  #pendingWrites = [];

  constructor({ input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {}) {
    this.input = input;
    this.output = output;
    this.errorOutput = errorOutput;
  }

  start(onMessage, onParseError) {
    this.input.on('data', chunk => {
      this.#buffer += this.#decoder.write(chunk);
      this.#drainLines(onMessage, onParseError);
    });

    this.input.on('end', () => {
      this.#buffer += this.#decoder.end();
      this.#drainLines(onMessage, onParseError, true);
    });
  }

  send(message) {
    const line = `${JSON.stringify(message)}\n`;

    if (this.#pendingWrites.length > 0 || this.output.writableNeedDrain) {
      this.#pendingWrites.push(line);
      this.#registerDrain();
      return;
    }

    if (!this.output.write(line)) {
      this.#registerDrain();
    }
  }

  log(message) {
    this.errorOutput.write(`[microclaude-sidecar] ${message}\n`);
  }

  #drainLines(onMessage, onParseError, flush = false) {
    for (;;) {
      const lineEnd = this.#buffer.indexOf('\n');
      if (lineEnd === -1) {
        break;
      }

      const line = this.#buffer.slice(0, lineEnd).trim();
      this.#buffer = this.#buffer.slice(lineEnd + 1);
      this.#parseLine(line, onMessage, onParseError);
    }

    if (flush && this.#buffer.trim().length > 0) {
      const line = this.#buffer.trim();
      this.#buffer = '';
      this.#parseLine(line, onMessage, onParseError);
    }
  }

  #parseLine(line, onMessage, onParseError) {
    if (line.length === 0) {
      return;
    }

    try {
      onMessage(JSON.parse(line));
    } catch (parseError) {
      onParseError?.(parseError, line);
    }
  }

  #registerDrain() {
    if (this.#drainRegistered) {
      return;
    }

    this.#drainRegistered = true;
    this.output.once('drain', () => {
      this.#drainRegistered = false;
      this.#flushPendingWrites();
    });
  }

  #flushPendingWrites() {
    while (this.#pendingWrites.length > 0) {
      const line = this.#pendingWrites.shift();
      if (!this.output.write(line)) {
        this.#registerDrain();
        return;
      }
    }
  }
}
