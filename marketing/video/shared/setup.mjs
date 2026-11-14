// Once per clone, after npm install: puts ffmpeg and ffprobe in .bin/ and makes the AAC copy of the song that the films play.
// HyperFrames needs both programs on PATH, so run it as: PATH="$PWD/.bin:$PATH" npx hyperframes ...
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ffmpeg = require("ffmpeg-static");
const ffprobe = require("ffprobe-static").path;
const exe = process.platform === "win32" ? ".exe" : "";
mkdirSync(new URL("../.bin/", import.meta.url), { recursive: true });
copyFileSync(ffmpeg, new URL(`../.bin/ffmpeg${exe}`, import.meta.url));
copyFileSync(ffprobe, new URL(`../.bin/ffprobe${exe}`, import.meta.url));
const song = new URL("../../Dormouse Multitask.m4a", import.meta.url);
execFileSync(ffmpeg, ["-v", "error", "-y", "-i", decodeURIComponent(song.pathname).replace(/^\/([A-Za-z]:)/, "$1"), "-vn", "-c:a", "aac", "-b:a", "192k", decodeURIComponent(new URL("song.m4a", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1")]);
console.log("ffmpeg and ffprobe are in .bin/, and shared/song.m4a is ready.");
