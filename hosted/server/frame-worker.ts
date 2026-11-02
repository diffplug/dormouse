import { frameOriginResponse, type FrameOriginEnv } from "./frame-origin";

/** The frame Worker, `dormouse-frames` on `*.dormouseusercontent.com`. */
export default {
  fetch: (request: Request, env: FrameOriginEnv) => frameOriginResponse(request, env),
};
