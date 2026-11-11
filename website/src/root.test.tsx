import { renderToString } from "react-dom/server";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { ErrorBoundary } from "./root";

describe("root ErrorBoundary", () => {
  it("answers a path no route matches with a page that links home", () => {
    const router = createMemoryRouter(
      [{ path: "/", element: <Outlet />, ErrorBoundary, children: [{ index: true, element: <p>home</p> }] }],
      { initialEntries: ["/does-not-exist"] },
    );
    const markup = renderToString(<RouterProvider router={router} />);
    expect(markup).toContain("There is no page here.");
    expect(markup).toContain('href="/"');
  });
});
