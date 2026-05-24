import { renderToReadableStream } from "react-dom/server";
import {
  ServerRouter,
  type EntryContext,
} from "react-router";

export const streamTimeout = 5_000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  const stream = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      signal: AbortSignal.timeout(streamTimeout + 1_000),
      onError(error) {
        responseStatusCode = 500;
        console.error(error);
      },
    },
  );
  await stream.allReady;

  responseHeaders.set("Content-Type", "text/html");
  return new Response(stream, {
    status: responseStatusCode,
    headers: responseHeaders,
  });
}
