import { StringDecoder } from "node:string_decoder";

/**
 * Consume a JSONL byte stream using only LF as the protocol delimiter.
 *
 * Node.js 24 readline also treats U+2028 and U+2029 as line endings. Both are
 * valid characters inside JSON strings, so readline can split one JSON-RPC
 * message into invalid fragments. StringDecoder keeps UTF-8 characters intact
 * when their bytes are split across stream chunks.
 */
export function readJsonLines(input, onLine) {
  const decoder = new StringDecoder("utf8");
  let fragments = [];

  const emitLine = (line) => {
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };

  const consume = (text) => {
    let start = 0;
    let newline = text.indexOf("\n", start);
    while (newline !== -1) {
      const tail = text.slice(start, newline);
      emitLine(fragments.length > 0 ? `${fragments.join("")}${tail}` : tail);
      fragments = [];
      start = newline + 1;
      newline = text.indexOf("\n", start);
    }
    if (start < text.length) fragments.push(text.slice(start));
  };

  input.on("data", (chunk) => {
    consume(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  });

  input.once("end", () => {
    consume(decoder.end());
    if (fragments.length > 0) emitLine(fragments.join(""));
    fragments = [];
  });
}
