import { expect, test } from "vitest";
import { digest } from "../token-digest";

// Stored token rows were hashed by pgstencil's `digest` before 0.5.0; a lookup
// must still find them, so the hash is held to fixed vectors, not to itself.
test("a token's digest is the lowercase hex SHA-256 of its UTF-8 text", () => {
  expect(digest("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(digest("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(digest("dmv_é")).toBe("5ef02955c59fe7aed0d97b98032ad48a1e69235d4f35a8a490ebe3cf8d830a6f");
});
