import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readIcnsChunks(buffer) {
  assert.equal(buffer.subarray(0, 4).toString("ascii"), "icns");
  assert.equal(buffer.readUInt32BE(4), buffer.length);

  const chunks = new Map();
  let offset = 8;
  while (offset < buffer.length) {
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    const length = buffer.readUInt32BE(offset + 4);
    assert.ok(length >= 8, `invalid ${type} chunk length`);
    assert.ok(offset + length <= buffer.length, `truncated ${type} chunk`);
    chunks.set(type, buffer.subarray(offset + 8, offset + length));
    offset += length;
  }
  assert.equal(offset, buffer.length);
  return chunks;
}

function readPngSize(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(buffer.subarray(12, 16).toString("ascii"), "IHDR");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

test("macOS app icon includes a complete Retina icon set through 1024px", () => {
  const icon = readFileSync(path.join(projectRoot, "assets", "ConversationBoard.icns"));
  const chunks = readIcnsChunks(icon);

  for (const type of ["ic04", "ic05", "ic07", "ic08", "ic09", "ic10", "ic11", "ic12", "ic13", "ic14"]) {
    assert.ok(chunks.has(type), `missing ${type} icon layer`);
  }
  assert.deepEqual(readPngSize(chunks.get("ic10")), { width: 1024, height: 1024 });
});
