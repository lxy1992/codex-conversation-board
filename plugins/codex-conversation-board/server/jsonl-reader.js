import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

/**
 * Read LF-delimited UTF-8 protocol records, optionally ending in CRLF. Unlike
 * readline, U+2028/U+2029 and bare CR are payload, never record boundaries.
 * Parsing and blank-line policy belong to the caller. An unterminated final
 * record is emitted at EOF; close() discards it and detaches without owning input.
 */
export function createJsonlReader({ input }) {
  const reader = new EventEmitter();
  const decoder = new StringDecoder("utf8");
  let fragments = [];
  let closed = false;

  function emitLine(line) {
    reader.emit("line", line.endsWith("\r") ? line.slice(0, -1) : line);
  }

  function consume(text) {
    let start = 0;
    let end;
    while (!closed && (end = text.indexOf("\n", start)) !== -1) {
      const suffix = text.slice(start, end);
      const line = fragments.length ? fragments.join("") + suffix : suffix;
      fragments = [];
      emitLine(line);
      start = end + 1;
    }
    // Retain only the unfinished record, without rescanning or repeatedly copying
    // a large response whenever another small chunk arrives.
    if (!closed && start < text.length) fragments.push(text.slice(start));
  }

  function onData(chunk) {
    consume(typeof chunk === "string" ? chunk : decoder.write(chunk));
  }

  function close() {
    if (closed) return;
    closed = true;
    fragments = [];
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("close", close);
    input.off("error", onError);
    reader.emit("close");
  }

  function onEnd() {
    consume(decoder.end());
    if (!closed && fragments.length) {
      const line = fragments.join("");
      fragments = [];
      emitLine(line);
    }
    close();
  }

  function onError(error) {
    try {
      reader.emit("error", error);
    } finally {
      close();
    }
  }

  reader.close = close;
  input.on("data", onData);
  input.once("end", onEnd);
  input.once("close", close);
  input.once("error", onError);
  return reader;
}
